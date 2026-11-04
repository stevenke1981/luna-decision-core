// The memory kinds (docs/design.md §4.4). memory_recall picks the stored memories that apply to a
// query. memory_write decides whether an observation is saved as new, used to update a similar
// memory, or skipped. A secret observation settles as skip and never reaches the state, the
// reasons or the store. Luna's answers are read through src/luna/answers.js; the rules decide
// when Luna is unavailable, and in heuristic mode.
import { MEMORY_TYPES } from '../defaults.js';
import { SECRET, certainty, indexId, mean, verdict } from '../contract.js';
import { excerpt, similarity } from '../text.js';
import { choiceAnswer, predicateProbability } from '../luna/answers.js';

const RECALL = 'memory_recall';
const WRITE = 'memory_write';
const QUERY_CHARS = 2000;
const OBSERVATION_CHARS = 1000;
const MEMORY_CHARS = 400;
const TARGET_CHARS = 120;
const SIMILAR_LIMIT = 5;
// Heuristic recall keeps the memories whose BM25 score reaches this share of the top score.
const RECALL_RATIO = 0.5;
// Similarity (Jaccard) at which an observation is already stored: settled as skip, no Luna call.
const ALREADY_STORED = 0.95;
const DEFAULT_SOURCE = 'user';
const SOURCES = ['user', 'agent', 'tool'];
const ACTIONS = ['save_new', 'update', 'skip'];
const NO_MATCH = 'no stored memory matches the query';

const ACTION_DESCRIPTIONS = {
  save_new: 'store the observation as a new memory',
  update: 'replace the text and type of the similar memory it refines',
  skip: 'store nothing',
};
const TYPE_DESCRIPTIONS = {
  user: 'who the user is and how they want to work',
  feedback: 'a correction or preference the user gave about this kind of work',
  project: 'an ongoing goal, constraint or decision that the code does not show',
  reference: 'a pointer to an external resource',
};
const DURABLE_QUESTION = {
  type: 'predicate',
  name: 'durable',
  instructions: 'Is the observation durable: true across future sessions (a preference, a constraint, a decision, a pointer), and not a temporary state or something the repository already records?',
};

// Wording that asks for something to be kept (heuristic only). English and 中文.
export const REMEMBER = /\b(?:remember|always|never|prefer(?:s|red)?|don['’]t|from now on)\b|記住|以後|總是|不要|偏好|習慣/i;
const URL_PATTERN = /https?:\/\/\S+/i;
const PROJECT_PATTERN = /\b(?:deadline|release|milestone)s?\b|專案|截止|上線/i;
const FEEDBACK_PATTERN = /\b(?:always|never|don['’]t)\b|不要|總是|別/i;

/**
 * The memory type a text most likely has: reference (a URL), project (dates, releases, 專案),
 * feedback (always, never, don't, 不要), else user.
 * @param {string} text
 * @returns {'user'|'feedback'|'project'|'reference'}
 */
export function guessType(text) {
  const s = String(text ?? '');
  if (URL_PATTERN.test(s)) return 'reference';
  if (PROJECT_PATTERN.test(s)) return 'project';
  if (FEEDBACK_PATTERN.test(s)) return 'feedback';
  return 'user';
}

function requireObject(input, kind) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${kind}: input must be an object`);
  return input;
}

function requireText(value, kind, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${kind}: ${field} must be a non-empty string`);
  return value.trim();
}

function requireStore(deps, kind) {
  if (!deps?.store) throw new Error(`${kind}: no memory store in deps`);
  return deps.store;
}

/** A memory as a result reports it: full text, with its probability (null when rules decided). */
function memoryOut(record, probability) {
  return { id: record.id, type: record.type, text: record.text, probability };
}

/** Records paired with their question names m0, m1, ... */
function asked(records) {
  return records.map((record, i) => ({ name: indexId('m', i), record }));
}

/** A memory as the Luna state carries it: the question name as id, the text excerpted. */
function stateMemory({ name, record }) {
  return { id: name, type: record.type, text: excerpt(record.text, MEMORY_CHARS) };
}

function noMatch() {
  return verdict({ memories: [], considered: 0 }, null, [NO_MATCH]);
}

// ---------------------------------------------------------------- memory_recall

function normalizeRecall(input, cfg) {
  const i = requireObject(input, RECALL);
  const query = requireText(i.query, RECALL, 'query');
  const limit = i.limit ?? cfg.memory.maxRecall;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`${RECALL}: limit must be a positive integer`);
  return { query, limit };
}

async function prepareRecall(input, cfg, deps) {
  const memories = requireStore(deps, RECALL).search(input.query, cfg.memory.shortlist);
  return { ...input, memories };
}

function planRecall(input) {
  if (input.memories.length === 0) return { settled: noMatch() };
  const asks = asked(input.memories);
  return {
    state: { query: excerpt(input.query, QUERY_CHARS), memories: asks.map(stateMemory) },
    questions: asks.map(({ name }) => ({
      type: 'predicate',
      name,
      instructions: `Does memory ${name} apply to this query: a preference, a correction, a project fact or a resource the task needs?`,
    })),
    ctx: { limit: input.limit, asked: asks },
  };
}

/**
 * Luna's answers to the memory_recall questions: the memories at or above recallThreshold, most
 * probable first, at most `limit`.
 */
function interpretRecall(answers, ctx, cfg) {
  const scored = ctx.asked.map(({ name, record }) => ({ record, p: predicateProbability(answers, name) }));
  const picked = scored
    .filter((s) => s.p >= cfg.memory.recallThreshold)
    .sort((a, b) => b.p - a.p)
    .slice(0, ctx.limit);
  const reasons = picked.map((s) => `luna ${s.record.id} p=${s.p.toFixed(2)}`);
  return verdict(
    { memories: picked.map((s) => memoryOut(s.record, s.p)), considered: scored.length },
    mean(scored.map((s) => certainty(s.p))),
    reasons.length ? reasons : ['no memory reached the recall threshold'],
  );
}

/** Rules: the memories scoring at least RECALL_RATIO of the top BM25 score, capped at `limit`. */
function heuristicRecall(input) {
  if (input.memories.length === 0) return noMatch();
  const top = Math.max(...input.memories.map((m) => m.score));
  const picked = input.memories.filter((m) => m.score >= RECALL_RATIO * top).slice(0, input.limit);
  return verdict(
    { memories: picked.map((m) => memoryOut(m, null)), considered: input.memories.length },
    null,
    [`lexical: score at least ${RECALL_RATIO} × top score`],
  );
}

function summarizeRecall(result) {
  return `${result.memories.length} of ${result.considered} memories`;
}

/** The memory_recall kind. Frozen; every step is pure except prepare (store search). */
export const memoryRecall = Object.freeze({
  name: RECALL,
  normalize: normalizeRecall,
  prepare: prepareRecall,
  plan: planRecall,
  interpret: interpretRecall,
  heuristic: heuristicRecall,
  summarize: summarizeRecall,
});

// ---------------------------------------------------------------- memory_write

function normalizeWrite(input) {
  const i = requireObject(input, WRITE);
  const observation = requireText(i.observation, WRITE, 'observation');
  const source = i.source ?? DEFAULT_SOURCE;
  if (!SOURCES.includes(source)) throw new TypeError(`${WRITE}: source must be ${SOURCES.join('|')}`);
  const type = i.type ?? null;
  if (type !== null && !MEMORY_TYPES.includes(type)) throw new TypeError(`${WRITE}: type must be ${MEMORY_TYPES.join('|')}`);
  if (i.dryRun !== undefined && typeof i.dryRun !== 'boolean') throw new TypeError(`${WRITE}: dryRun must be a boolean`);
  return { observation, source, type, dryRun: i.dryRun ?? false };
}

async function prepareWrite(input, cfg, deps) {
  // A secret is never used as a search query, and its similar memories are not needed.
  const similar = SECRET.test(input.observation)
    ? []
    : requireStore(deps, WRITE).search(input.observation, SIMILAR_LIMIT);
  return { ...input, similar };
}

function typeOf(input) {
  return input.type ?? guessType(input.observation);
}

function writeResult(action, type, targetId, text) {
  return { action, type, targetId, text, applied: false, memory: null };
}

/** The similar memory with the highest Jaccard similarity to the observation, or null. */
function bestMatch(input) {
  return input.similar.reduce((best, record) => {
    const sim = similarity(input.observation, record.text);
    return best && best.similarity >= sim ? best : { record, similarity: sim };
  }, null);
}

/** The cases the rules settle without Luna: a secret, or a near-identical memory already stored. */
function settleWrite(input) {
  if (SECRET.test(input.observation)) {
    return verdict(writeResult('skip', typeOf(input), null, null), null, ['looks like a secret; not stored']);
  }
  const best = bestMatch(input);
  if (best?.similarity >= ALREADY_STORED) {
    return verdict(
      writeResult('skip', typeOf(input), null, input.observation),
      null,
      [`already stored as ${best.record.id}`],
    );
  }
  return null;
}

/** Without similar memories, update is not offered; a target is asked only among two or more. */
function actionsFor(asks) {
  return asks.length ? ACTIONS : ACTIONS.filter((a) => a !== 'update');
}

function actionQuestion(asks) {
  return {
    type: 'choice',
    name: 'action',
    instructions: 'Should the observation be saved as a new memory, used to update the similar memory it refines, or skipped?',
    choices: actionsFor(asks).map((value) => ({ value, description: ACTION_DESCRIPTIONS[value] })),
  };
}

function typeQuestion() {
  return {
    type: 'choice',
    name: 'type',
    instructions: 'Which memory type fits the observation?',
    choices: MEMORY_TYPES.map((value) => ({ value, description: TYPE_DESCRIPTIONS[value] })),
  };
}

function targetQuestion(asks) {
  return {
    type: 'choice',
    name: 'target',
    instructions: 'Which similar memory does the observation update?',
    choices: asks.map(({ name, record }) => ({ value: name, description: excerpt(record.text, TARGET_CHARS) })),
  };
}

function questionsWrite(input, asks) {
  return [
    actionQuestion(asks),
    ...(input.type ? [] : [typeQuestion()]),
    DURABLE_QUESTION,
    ...(asks.length >= 2 ? [targetQuestion(asks)] : []),
  ];
}

function planWrite(input) {
  const settled = settleWrite(input);
  if (settled) return { settled };
  const asks = asked(input.similar);
  return {
    state: {
      observation: excerpt(input.observation, OBSERVATION_CHARS),
      source: input.source,
      similar: asks.map(stateMemory),
    },
    questions: questionsWrite(input, asks),
    ctx: { observation: input.observation, type: input.type, similar: asks },
  };
}

/** The update target: the only similar memory, or the one Luna's target answer names. */
function targetFor(answers, similar) {
  if (similar.length === 1) return similar[0].record.id;
  const { choice } = choiceAnswer(answers, 'target', similar.map(({ name }) => name));
  return similar.find(({ name }) => name === choice).record.id;
}

/**
 * Luna's answers to the memory_write questions. A non-durable observation is skipped whatever
 * the action answer says; the confidence is the action answer's.
 */
function interpretWrite(answers, ctx, cfg) {
  const action = choiceAnswer(answers, 'action', actionsFor(ctx.similar));
  const durable = predicateProbability(answers, 'durable');
  const type = ctx.type ?? choiceAnswer(answers, 'type', MEMORY_TYPES).choice;
  const notDurable = durable < cfg.memory.durableThreshold;
  const chosen = notDurable ? 'skip' : action.choice;
  const targetId = chosen === 'update' ? targetFor(answers, ctx.similar) : null;
  const reasons = [`luna action ${action.choice} (${action.confidence.toFixed(2)})`, `durable ${durable.toFixed(2)}`];
  if (notDurable) reasons.push(`not durable enough (below ${cfg.memory.durableThreshold}): skip`);
  return verdict(writeResult(chosen, type, targetId, ctx.observation), action.confidence, reasons);
}

/**
 * Rules: a secret or an already stored text is skipped; a similar memory (Jaccard at least
 * duplicateSimilarity) is updated; remember-style wording is saved as new; anything else skipped.
 */
function heuristicWrite(input, cfg) {
  const settled = settleWrite(input);
  if (settled) return settled;
  const best = bestMatch(input);
  const type = typeOf(input);
  if (best && best.similarity >= cfg.memory.duplicateSimilarity) {
    return verdict(
      writeResult('update', type, best.record.id, input.observation),
      null,
      [`similar to ${best.record.id} (${best.similarity.toFixed(2)})`],
    );
  }
  if (REMEMBER.test(input.observation)) {
    return verdict(writeResult('save_new', type, null, input.observation), null, ['remember-style wording']);
  }
  return verdict(writeResult('skip', type, null, input.observation), null, ['no remember-style wording and no similar memory']);
}

/** Applies the decision unless it is a dry run or a skip. Store errors propagate. */
async function finalizeWrite(v, input, cfg, deps) {
  const r = v.result;
  if (input.dryRun || r.action === 'skip') return v;
  const store = requireStore(deps, WRITE);
  const memory = r.action === 'update'
    ? store.update(r.targetId, { text: r.text, type: r.type })
    : store.add({ type: r.type, text: r.text, source: input.source });
  return { ...v, result: { ...r, applied: true, memory } };
}

function summarizeWrite(result) {
  return `${result.action}${result.targetId ? ` ${result.targetId}` : ''} (${result.type})`;
}

/** The memory_write kind. Frozen; prepare does the store search, finalize writes the store. */
export const memoryWrite = Object.freeze({
  name: WRITE,
  normalize: normalizeWrite,
  prepare: prepareWrite,
  plan: planWrite,
  interpret: interpretWrite,
  heuristic: heuristicWrite,
  finalize: finalizeWrite,
  summarize: summarizeWrite,
});
