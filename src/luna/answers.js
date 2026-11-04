// Parsing of Decisions API answers. Every domain reads Luna's answers through these helpers,
// so a malformed or refused answer fails the same way everywhere (it throws, and the engine
// falls back to the rules in `auto` mode).

/** Answers keyed by question name. */
export function answersByName(body) {
  const answers = Array.isArray(body?.answers) ? body.answers : [];
  const out = {};
  for (const a of answers) {
    if (a && typeof a.name === 'string') out[a.name] = a;
  }
  return out;
}

/** The answer named `name`, checked to be of `type`; a refusal or a missing answer throws. */
export function expectAnswer(answers, name, type) {
  const answer = answers?.[name];
  if (answer?.type === 'refusal') throw new Error(`Luna refused "${name}"`);
  if (answer?.type !== type) throw new Error(`Luna returned no ${type} answer for "${name}"`);
  return answer;
}

/** P(yes) of a predicate answer. */
export function predicateProbability(answers, name) {
  const p = expectAnswer(answers, name, 'predicate').probability;
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`Luna returned no probability for "${name}"`);
  return p;
}

// A level's entry in a probability list: matched by value (index) or label when the entries
// carry them, so the order of the list does not matter; by position otherwise.
function listEntry(list, label, i) {
  if (list.some((e) => e && typeof e === 'object' && ('value' in e || 'label' in e))) {
    return list.find((e) => e?.value === i || e?.label === label);
  }
  return list[i];
}

function normalize(nums) {
  const clean = nums.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  return total > 0 ? clean.map((v) => v / total) : null;
}

/** Probability of each level of a score answer, in level order, or null without a distribution. */
export function levelProbabilities(answer, labels) {
  const p = answer?.probabilities;
  const values = Array.isArray(p) ? labels.map((label, i) => listEntry(p, label, i))
    : p && typeof p === 'object' ? labels.map((label, i) => p[label] ?? p[i] ?? p[String(i)]) : [];
  return normalize(values.map((v) => (typeof v === 'object' && v ? v.probability : v)));
}

/**
 * The level index a score answer points to: the `quantile` of its distribution (median by
 * default), which respects the order of the levels; the rounded score without a distribution.
 * @returns {{level:number, probs:number[]|null}}
 */
export function scoreLevel(answers, name, labels, quantile = 0.5) {
  const answer = expectAnswer(answers, name, 'score');
  const probs = levelProbabilities(answer, labels);
  const top = labels.length - 1;
  if (probs) return { level: quantileIndex(probs, quantile), probs };
  if (!Number.isFinite(answer.score)) throw new Error(`Luna returned a score without a value for "${name}"`);
  return { level: Math.max(0, Math.min(top, Math.round(answer.score))), probs: null };
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

/**
 * A choice answer: the chosen value (validated against `values`) and the probability of every
 * value, in `values` order. Without a distribution, the chosen value carries the confidence.
 * @returns {{choice:string, probs:number[], confidence:number}}
 */
export function choiceAnswer(answers, name, values) {
  const answer = expectAnswer(answers, name, 'choice');
  if (!values.includes(answer.choice)) throw new Error(`Luna returned an unknown choice for "${name}"`);
  const p = answer.probabilities;
  const raw = values.map((v) => {
    const x = Array.isArray(p) ? p.find((e) => e?.value === v)?.probability
      : p && typeof p === 'object' ? (typeof p[v] === 'object' ? p[v]?.probability : p[v]) : undefined;
    return Number.isFinite(x) ? x : undefined;
  });
  let probs = raw.every((x) => x === undefined) ? null : normalize(raw.map((x) => x ?? 0));
  const fallbackConfidence = Number.isFinite(answer.confidence) ? answer.confidence : 1;
  if (!probs) {
    const rest = values.length > 1 ? (1 - fallbackConfidence) / (values.length - 1) : 0;
    probs = values.map((v) => (v === answer.choice ? fallbackConfidence : rest));
  }
  const confidence = Number.isFinite(answer.confidence) ? answer.confidence : Math.max(...probs);
  return { choice: answer.choice, probs, confidence };
}

/** Confidence of a score answer: its own field, else the top level probability, else 1. */
export function scoreConfidence(answers, name, probs) {
  const c = answers?.[name]?.confidence;
  if (Number.isFinite(c)) return c;
  return probs ? Math.max(...probs) : 1;
}
