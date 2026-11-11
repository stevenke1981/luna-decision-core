// Decode and validate the answer shapes shared by the decision domains.
import { DecisionError } from '../errors.js';

const malformed = (message) => new DecisionError('LUNA_MALFORMED_ANSWER', message);
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

/** Answers keyed by question name. */
export function answersByName(body) {
  const answers = body?.answers ?? [];
  if (!Array.isArray(answers)) throw malformed('Luna response has no answers array');
  const names = new Set();
  for (const answer of answers) {
    const name = answer?.name;
    if (typeof name !== 'string' || !name || names.has(name)) {
      throw malformed('Luna returned an invalid or duplicate answer name');
    }
    names.add(name);
  }
  return Object.fromEntries(answers.map((answer) => [answer.name, answer]));
}

/** The answer named `name`, checked to be of `type`. */
export function expectAnswer(answers, name, type) {
  const answer = answers?.[name];
  if (answer?.type === 'refusal') throw new DecisionError('LUNA_REFUSED', `Luna refused "${name}"`);
  if (answer?.type !== type) throw malformed(`Luna returned no ${type} answer for "${name}"`);
  return answer;
}

export function predicateProbability(answers, name) {
  const p = expectAnswer(answers, name, 'predicate').probability;
  if (!probability(p)) throw malformed(`Luna returned no probability for "${name}"`);
  return p;
}

function reportedConfidence(answer) {
  if (!Object.hasOwn(answer, 'confidence')) return null;
  if (!probability(answer.confidence)) throw malformed(`Luna returned invalid confidence for "${answer.name}"`);
  return answer.confidence;
}

function probabilityIndex(entry, index, labels, score) {
  if (!entry || typeof entry !== 'object') return score ? index : -1;
  const valueIndex = score ? entry.value : labels.indexOf(entry.value);
  const labelIndex = score && entry.label !== undefined ? labels.indexOf(entry.label) : undefined;
  if (labelIndex !== undefined && (labelIndex < 0 || (valueIndex !== undefined && valueIndex !== labelIndex))) return -1;
  return valueIndex ?? labelIndex ?? (score ? index : -1);
}

function distribution(answer, labels, score) {
  if (!Object.hasOwn(answer, 'probabilities')) return null;
  const p = answer.probabilities;
  const invalid = () => malformed(`Luna returned invalid probabilities for "${answer.name}"`);
  if (!p || typeof p !== 'object') throw invalid();
  const entries = Array.isArray(p)
    ? p.map((entry, i) => [probabilityIndex(entry, i, labels, score), entry])
    : Object.entries(p).map(([key, entry]) => [
      score && !labels.includes(key) && /^\d+$/.test(key) ? Number(key) : labels.indexOf(key), entry,
    ]);
  const seen = new Set();
  const values = labels.map(() => 0);
  for (const [index, entry] of entries) {
    const value = entry && typeof entry === 'object' ? entry.probability : entry;
    if (!Number.isInteger(index) || index < 0 || index >= labels.length || seen.has(index) || !probability(value)) throw invalid();
    seen.add(index);
    values[index] = value;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (sum <= 0) throw invalid();
  return values.map((value) => value / sum);
}

/** Probability of each score level in level order, or null when omitted. */
export function levelProbabilities(answer, labels) {
  return distribution(answer, labels, true);
}

/** Select by quantile when a distribution exists, or by the rounded score alone. */
export function scoreLevel(answers, name, labels, quantile = 0.5) {
  const answer = expectAnswer(answers, name, 'score');
  const probs = levelProbabilities(answer, labels);
  const top = labels.length - 1;
  if (Object.hasOwn(answer, 'score') && (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > top)) {
    throw malformed(`Luna returned an out-of-range score for "${name}"`);
  }
  if (probs) return { level: quantileIndex(probs, quantile), probs };
  if (answer.score === undefined) throw malformed(`Luna returned a score without a value for "${name}"`);
  return { level: Math.round(answer.score), probs: null };
}

/** Index at the quantile of an ordered distribution. Zero-weight entries are skipped. */
export function quantileIndex(probs, quantile = 0.5) {
  let cumulative = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (probs[i] > 0 && cumulative >= quantile - 1e-9) return i;
  }
  return probs.findLastIndex((p) => p > 0);
}

export function choiceAnswer(answers, name, values) {
  const answer = expectAnswer(answers, name, 'choice');
  if (!values.includes(answer.choice)) throw malformed(`Luna returned an unknown choice for "${name}"`);
  const probs = distribution(answer, values, false);
  const confidence = reportedConfidence(answer);
  return { choice: answer.choice, probs, confidence: confidence ?? probs?.[values.indexOf(answer.choice)] ?? null, reportedConfidence: confidence };
}

export function scoreConfidence(answers, name, probs, level) {
  return reportedConfidence(answers[name]) ?? probs?.[level] ?? null;
}
