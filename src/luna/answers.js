// Parsing of Decisions API answers. Invalid or refused answers fail the decision instead of
// being turned into confident choices. The engine falls back to rules only in `auto` mode.

const ANSWER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// Accommodate floating-point roundoff, never an incomplete or arbitrary set of weights.
const SUM_TOLERANCE = 1e-6;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isProbability = (v) => Number.isFinite(v) && v >= 0 && v <= 1;

/** Answers keyed by question name; all names become own data properties without overwrites. */
export function answersByName(body) {
  if (!Array.isArray(body?.answers)) throw new Error('Luna returned no answers array');
  const entries = new Map();
  for (const answer of body.answers) {
    if (!isObject(answer) || typeof answer.name !== 'string' || !ANSWER_NAME.test(answer.name)) {
      throw new Error('Luna returned an answer without a valid question name');
    }
    if (entries.has(answer.name)) throw new Error(`Luna returned duplicate answers for "${answer.name}"`);
    entries.set(answer.name, answer);
  }
  return Object.fromEntries(entries);
}

/** The answer named `name`, checked to be of `type`; a refusal or a missing answer throws. */
export function expectAnswer(answers, name, type) {
  const answer = answers && Object.hasOwn(answers, name) ? answers[name] : undefined;
  if (answer?.type === 'refusal') throw new Error(`Luna refused "${name}"`);
  if (!isObject(answer) || answer.type !== type) throw new Error(`Luna returned no ${type} answer for "${name}"`);
  return answer;
}

/** P(yes) of a predicate answer. */
export function predicateProbability(answers, name) {
  const p = expectAnswer(answers, name, 'predicate').probability;
  if (!isProbability(p)) throw new Error(`Luna returned no probability for "${name}"`);
  return p;
}

function confidenceOf(answer, name) {
  if (!Object.hasOwn(answer, 'confidence')) return null;
  if (!isProbability(answer.confidence)) throw new Error(`Luna returned invalid confidence for "${name}": expected 0..1`);
  return answer.confidence;
}

function invalidProbabilities(name, detail) {
  return new Error(`Luna returned invalid probabilities for "${name}": ${detail}`);
}

/** A complete distribution, normalized only to remove tiny rounding differences from 1. */
function normalize(nums, name) {
  if (nums.some((v) => !isProbability(v))) throw invalidProbabilities(name, 'every probability must be a finite number from 0 to 1');
  const total = nums.reduce((sum, v) => sum + v, 0);
  if (total <= 0 || Math.abs(total - 1) > SUM_TOLERANCE) throw invalidProbabilities(name, 'probabilities must sum to 1');
  return nums.map((v) => v / total);
}

function probabilityOf(entry) {
  return isObject(entry) ? entry.probability : entry;
}

/** An array indexed by the expected values; duplicate, missing and unknown entries fail. */
function ordered(entries, size, indexOf, name) {
  const values = new Array(size);
  const seen = new Set();
  for (const [key, entry] of entries) {
    const i = indexOf(key, entry);
    if (!Number.isInteger(i) || i < 0 || i >= size) throw invalidProbabilities(name, 'unknown value or label');
    if (seen.has(i)) throw invalidProbabilities(name, 'duplicate value or label');
    seen.add(i);
    values[i] = probabilityOf(entry);
  }
  if (seen.size !== size) throw invalidProbabilities(name, 'missing value or label');
  return normalize(values, name);
}

/** Index metadata of a score entry, or its position when the array has no index metadata. */
function scoreIndex(entry, labels, fallback, name) {
  if (!isObject(entry)) return fallback;
  const hasValue = Object.hasOwn(entry, 'value');
  const hasLabel = Object.hasOwn(entry, 'label');
  let i = fallback;
  if (hasValue) {
    i = entry.value;
    if (!Number.isInteger(i) || i < 0 || i >= labels.length) throw invalidProbabilities(name, 'unknown level index');
  } else if (hasLabel) {
    i = labels.indexOf(entry.label);
    if (i < 0 || labels.lastIndexOf(entry.label) !== i) throw invalidProbabilities(name, 'unknown or ambiguous level label');
  }
  if (hasLabel && (typeof entry.label !== 'string' || labels[i] !== entry.label)) {
    throw invalidProbabilities(name, 'level label does not match its index');
  }
  return i;
}

/** Probability of each score level, in level order, or null when the field is absent. */
export function levelProbabilities(answer, labels) {
  if (!Object.hasOwn(answer, 'probabilities')) return null;
  const p = answer.probabilities;
  const name = answer.name ?? 'score';
  if (Array.isArray(p)) {
    const keyed = p.some((entry) => isObject(entry) && (Object.hasOwn(entry, 'value') || Object.hasOwn(entry, 'label')));
    return ordered(p.map((entry, i) => [i, entry]), labels.length,
      (i, entry) => scoreIndex(entry, labels, keyed ? undefined : i, name), name);
  }
  if (isObject(p)) {
    return ordered(Object.entries(p), labels.length, (key, entry) => {
      const byLabel = labels.indexOf(key);
      const byIndex = /^(0|[1-9]\d*)$/.test(key) && Number(key) < labels.length ? Number(key) : -1;
      if ((byLabel >= 0 && labels.lastIndexOf(key) !== byLabel) || (byLabel >= 0 && byIndex >= 0 && byLabel !== byIndex)) {
        throw invalidProbabilities(name, 'ambiguous level key');
      }
      const i = byLabel >= 0 ? byLabel : byIndex;
      if (scoreIndex(entry, labels, i, name) !== i) throw invalidProbabilities(name, 'level metadata does not match its key');
      return i;
    }, name);
  }
  throw invalidProbabilities(name, 'expected an array or object');
}

/**
 * The level index a score answer points to: the `quantile` of its distribution (median by
 * default), which respects the order of the levels; the rounded score without a distribution.
 * @returns {{level:number, probs:number[]|null}}
 */
export function scoreLevel(answers, name, labels, quantile = 0.5) {
  const answer = expectAnswer(answers, name, 'score');
  confidenceOf(answer, name);
  const top = labels.length - 1;
  if (Object.hasOwn(answer, 'score') && (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > top)) {
    throw new Error(`Luna returned an invalid score for "${name}": expected 0..${top}`);
  }
  const probs = levelProbabilities(answer, labels);
  if (probs) return { level: quantileIndex(probs, quantile), probs };
  if (!Number.isFinite(answer.score)) throw new Error(`Luna returned a score without a value for "${name}"`);
  return { level: Math.round(answer.score), probs: null };
}

/** Index at the `quantile` of an ordered distribution; a zero-weight entry is never picked. */
export function quantileIndex(probs, quantile = 0.5) {
  let cumulative = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (probs[i] > 0 && cumulative >= quantile - 1e-9) return i;
  }
  return probs.length - 1;
}

function choiceProbabilities(answer, values, name) {
  if (!Object.hasOwn(answer, 'probabilities')) return null;
  const p = answer.probabilities;
  if (Array.isArray(p)) {
    return ordered(p.map((entry) => [entry?.value, entry]), values.length,
      (value, entry) => isObject(entry) && Object.hasOwn(entry, 'value') ? values.indexOf(value) : -1, name);
  }
  if (isObject(p)) {
    return ordered(Object.entries(p), values.length, (key, entry) => {
      const matches = values.flatMap((value, i) => String(value) === key ? [i] : []);
      if (matches.length !== 1) throw invalidProbabilities(name, 'unknown or ambiguous choice key');
      const i = matches[0];
      if (isObject(entry) && Object.hasOwn(entry, 'value') && entry.value !== values[i]) {
        throw invalidProbabilities(name, 'choice value does not match its key');
      }
      return i;
    }, name);
  }
  throw invalidProbabilities(name, 'expected an array or object');
}

/**
 * A choice answer and its probability distribution, in `values` order. Without a distribution,
 * the chosen value carries the confidence; a malformed supplied distribution never falls back.
 * @returns {{choice:string|boolean, probs:number[], confidence:number}}
 */
export function choiceAnswer(answers, name, values) {
  const answer = expectAnswer(answers, name, 'choice');
  if (!values.includes(answer.choice)) throw new Error(`Luna returned an unknown choice for "${name}"`);
  const explicitConfidence = confidenceOf(answer, name);
  let probs = choiceProbabilities(answer, values, name);
  if (!probs) {
    const chosenConfidence = explicitConfidence ?? 1;
    const rest = values.length > 1 ? (1 - chosenConfidence) / (values.length - 1) : 0;
    probs = values.map((v) => (v === answer.choice ? chosenConfidence : rest));
  }
  return { choice: answer.choice, probs, confidence: explicitConfidence ?? Math.max(...probs) };
}

/** Confidence of a score answer: its valid field, else the top level probability, else 1. */
export function scoreConfidence(answers, name, probs) {
  const answer = expectAnswer(answers, name, 'score');
  return confidenceOf(answer, name) ?? (probs ? Math.max(...probs) : 1);
}

/** Validate every answer in a batch before another request can consume more API usage. */
export function validateAnswers(body, questions) {
  const answers = answersByName(body);
  const expected = new Set(questions.map((q) => q.name));
  if (Object.keys(answers).some((name) => !expected.has(name))) throw new Error('Luna returned an unexpected answer name');
  for (const q of questions) {
    if (q.type === 'predicate') predicateProbability(answers, q.name);
    else if (q.type === 'choice') choiceAnswer(answers, q.name, q.choices.map((c) => c.value));
    else if (q.type === 'score') scoreLevel(answers, q.name, q.levels.map((level) => level.label));
  }
}
