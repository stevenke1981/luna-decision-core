// The `route` decision kind (docs/design.md §4.1): which model and how much reasoning effort the
// next generation of a coding agent gets. Luna answers a choice over the eligible models and a
// score over the effort ladder. The rules pick by difficulty when Luna is unavailable, and gate
// Luna's answer so that a failing agent never gets less than the rules give it.
import { DEEP_QUESTION, GREETING, HARD_TASK, redact, requireText, verdict } from '../contract.js';
import { EFFORTS } from '../defaults.js';
import { choiceAnswer, quantileIndex, scoreConfidence, scoreLevel } from '../luna/answers.js';
import { excerpt } from '../text.js';

const STEP_KINDS = ['read', 'edit', 'verify', 'exec', 'tool'];
const MAX_TASK_CHARS = 2000;
const MAX_RECENT_STEPS = 8;
const MAX_COMMAND_CHARS = 160;
const REPEAT_WINDOW = 6;
const LONG_TASK_CHARS = 600;
const STUCK_STREAK = 3;
const TWO_IN_A_ROW = 2;
const ONE_IN_A_ROW = 1;
// Ladder indexes used by the rules (the default ladder is low, medium, high, xhigh, max).
const LEVEL_GREETING = 0;
const LEVEL_ROUTINE = 1;
const LEVEL_HARD = 2;
// From this ladder index on, the rules take the strongest eligible model.
const MODEL_TOP_LEVEL = 3;

// One description per effort, used as the level descriptions of the effort score question.
const EFFORT_DESCRIPTIONS = Object.freeze({
  none: 'nothing to think about',
  minimal: 'nothing to think about',
  low: 'routine: lookups, reads, a trivial change',
  medium: 'ordinary engineering: a small feature, a focused edit, one clear failure',
  high: 'hard engineering: design, cross-module refactor, subtle bug, two or three failures in a row',
  xhigh: 'very hard or risky: architecture, security, concurrency, data integrity, or stuck after many failures',
  max: 'the hardest: many interacting constraints, proofs, novel algorithms, still failing after high effort',
});

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const squash = (command) => command.replace(/\s+/g, ' ').trim();
const isHardTask = (task) => HARD_TASK.test(task) || DEEP_QUESTION.test(task) || task.length > LONG_TASK_CHARS;
const statusOf = (failed) => (failed === null ? 'pending' : failed ? 'failed' : 'ok');
const byTierThenId = (a, b) => a.tier - b.tier || (a.id < b.id ? -1 : 1);

function normalizeStep(step, i) {
  const at = `route: steps[${i}]`;
  if (!isPlainObject(step)) throw new TypeError(`${at} must be an object`);
  if (!STEP_KINDS.includes(step.kind)) throw new TypeError(`${at}.kind must be one of ${STEP_KINDS.join('|')}`);
  if (typeof step.command !== 'string') throw new TypeError(`${at}.command must be a string`);
  const failed = step.failed ?? null;
  if (failed !== null && typeof failed !== 'boolean') throw new TypeError(`${at}.failed must be true, false or null`);
  return { kind: step.kind, command: step.command, failed };
}

function normalizeSteps(steps) {
  if (steps == null) return [];
  if (!Array.isArray(steps)) throw new TypeError('route: steps must be an array');
  return steps.map(normalizeStep);
}

function normalizeList(value, field) {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    throw new TypeError(`route: ${field} must be an array of strings`);
  }
  return [...value];
}

function normalizeContextTokens(value) {
  const tokens = value ?? 0;
  if (!Number.isFinite(tokens) || tokens < 0) throw new TypeError('route: contextTokens must be a number >= 0');
  return tokens;
}

function normalizeFlag(value) {
  if (value == null) return false;
  if (typeof value !== 'boolean') throw new TypeError('route: localOnly must be a boolean');
  return value;
}

/** Tokens the window must hold: the context with headroom, rounded up. */
function contextNeed(input, cfg) {
  return Math.ceil((input.contextTokens ?? 0) * cfg.route.contextHeadroom);
}

function assertKnownCandidates(ids, models) {
  const known = new Set(models.map((m) => m.id));
  const unknown = ids.find((id) => !known.has(id));
  if (unknown !== undefined) throw new TypeError(`route: unknown candidate "${unknown}"`);
}

/**
 * The models a request may use, in tier order (then id): the candidates, the models whose
 * window holds the context with headroom, those with every required capability, and, when
 * `localOnly`, the local ones. Possibly none; normalize turns that into an error.
 * @param {object} input a normalized or raw route input
 * @param {object} cfg the loaded config
 * @returns {object[]} the config's model objects, in tier order
 * @throws {TypeError} when a candidate is not a configured model
 */
export function eligibleModels(input, cfg) {
  const models = cfg.route.models;
  const wanted = input.candidates ?? null;
  if (wanted) assertKnownCandidates(wanted, models);
  const need = contextNeed(input, cfg);
  const requires = input.requires ?? [];
  return models
    .filter((m) => !wanted || wanted.includes(m.id))
    .filter((m) => m.contextWindow >= need)
    .filter((m) => requires.every((capability) => m.capabilities.includes(capability)))
    .filter((m) => !input.localOnly || m.local)
    .sort(byTierThenId);
}

function noModelError(input, cfg) {
  const why = [];
  if (input.contextTokens > 0) why.push(`context ${input.contextTokens} tokens needs a window of ${contextNeed(input, cfg)}`);
  if (input.requires?.length) why.push(`requires ${input.requires.join(', ')}`);
  if (input.localOnly) why.push('localOnly');
  if (input.candidates) why.push(`candidates [${input.candidates.join(', ')}]`);
  return new Error(`route: no eligible model (${why.join('; ')})`);
}

function eligibleOrThrow(input, cfg) {
  const eligible = eligibleModels(input, cfg);
  if (eligible.length === 0) throw noModelError(input, cfg);
  return eligible;
}

/** A route input with defaults applied; a new object. Throws TypeError on bad input. */
function normalize(input, cfg) {
  if (!isPlainObject(input)) throw new TypeError('route: input must be an object');
  const normalized = {
    task: requireText(input.task, 'route: task'),
    steps: normalizeSteps(input.steps),
    contextTokens: normalizeContextTokens(input.contextTokens),
    requires: input.requires == null ? [] : normalizeList(input.requires, 'requires'),
    localOnly: normalizeFlag(input.localOnly),
    candidates: input.candidates == null ? null : normalizeList(input.candidates, 'candidates'),
  };
  eligibleOrThrow(normalized, cfg);
  return normalized;
}

function failureStreak(steps) {
  let n = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].failed === true; i--) n++;
  return n;
}

// The same failing command (whitespace squashed) at least twice in the last REPEAT_WINDOW steps.
function repeatsFailure(steps) {
  const failed = steps.slice(-REPEAT_WINDOW).filter((s) => s.failed === true).map((s) => squash(s.command));
  return new Set(failed).size < failed.length;
}

function recentSteps(steps) {
  return steps.slice(-MAX_RECENT_STEPS).map((s) => ({
    kind: s.kind,
    command: excerpt(redact(s.command), MAX_COMMAND_CHARS),
    status: statusOf(s.failed),
  }));
}

function modelQuestion(eligible) {
  return {
    type: 'choice',
    name: 'model',
    instructions: 'Which model should do the next generation? Weigh how hard the work is against what each model is for.',
    choices: eligible.map((m) => ({ value: m.id, description: `tier ${m.tier}: ${m.strengths}` })),
  };
}

function effortQuestion(ladder) {
  return {
    type: 'score',
    name: 'effort',
    instructions: 'How much reasoning effort does the next generation need, given the request and the steps so far?',
    levels: ladder.map((label) => ({ label, description: EFFORT_DESCRIPTIONS[label] })),
  };
}

/** The state and questions for Luna; the eligible models are kept in `ctx` for interpret. */
function plan(input, cfg) {
  const eligible = eligibleOrThrow(input, cfg);
  return {
    state: {
      task: excerpt(redact(input.task), MAX_TASK_CHARS),
      recent_steps: recentSteps(input.steps),
      failures_in_a_row: failureStreak(input.steps),
      context_tokens: input.contextTokens,
      models: eligible.map((m) => ({ id: m.id, tier: m.tier, strengths: m.strengths })),
    },
    questions: [...(eligible.length > 1 ? [modelQuestion(eligible)] : []), effortQuestion(cfg.ladder)],
    ctx: { eligible },
  };
}

/**
 * The effort that is at least as high as the one asked, within the EFFORTS order. Where the
 * model does not declare the effort, the nearest one it declares is used; ties go upward.
 * A model with no declared efforts is not clamped.
 * @param {string} effort one of EFFORTS
 * @param {string[]} efforts the efforts the model supports
 * @returns {string}
 */
export function clampEffort(effort, efforts) {
  const at = EFFORTS.indexOf(effort);
  if (at < 0) throw new TypeError(`route: unknown effort "${effort}"`);
  if (efforts.length === 0 || efforts.includes(effort)) return effort;
  let best = null;
  for (const e of efforts) {
    const index = EFFORTS.indexOf(e);
    const dist = Math.abs(index - at);
    if (!best || dist < best.dist || (dist === best.dist && index > best.index)) best = { effort: e, index, dist };
  }
  return best.effort;
}

/** The result shape shared by interpret, heuristic and gate. */
function resultFor(eligible, model, effort, probs) {
  return {
    model: model.id,
    effort,
    fallbackChain: eligible.filter((m) => m.tier > model.tier).map((m) => m.id),
    modelProbabilities: probs.modelProbabilities ?? null,
    effortProbabilities: probs.effortProbabilities ?? null,
  };
}

const byKey = (keys, values) => Object.fromEntries(keys.map((k, i) => [k, values[i]]));

/** The model Luna picks: the quantile of its distribution over the tier-ordered models. */
function pickModel(answers, eligible, quantile) {
  if (eligible.length === 1) return { model: eligible[0], probs: null, confidence: null };
  const { probs, confidence } = choiceAnswer(answers, 'model', eligible.map((m) => m.id));
  return { model: eligible[quantileIndex(probs, quantile)], probs, confidence };
}

function interpretReasons(picked, asked, chosen, cfg) {
  const reasons = [
    picked.probs ? `model ${picked.model.id} at quantile ${cfg.route.modelQuantile}` : `only ${picked.model.id} is eligible`,
    `effort ${asked} at quantile ${cfg.route.effortQuantile}`,
  ];
  if (chosen !== asked) reasons.push(`effort ${asked} clamped to ${chosen} for ${picked.model.id}`);
  return reasons;
}

/** Luna's answers as a verdict. Throws on a refused or malformed answer. */
function interpret(answers, ctx, cfg) {
  const { eligible } = ctx;
  const picked = pickModel(answers, eligible, cfg.route.modelQuantile);
  const effort = scoreLevel(answers, 'effort', cfg.ladder, cfg.route.effortQuantile);
  const effortConfidence = scoreConfidence(answers, 'effort', effort.probs);
  // The effort's confidence counts alone only when there is no model question to compare with.
  const confidence = picked.confidence == null ? effortConfidence : Math.min(picked.confidence, effortConfidence);
  const asked = cfg.ladder[effort.level];
  const chosen = clampEffort(asked, picked.model.efforts);
  const result = resultFor(eligible, picked.model, chosen, {
    modelProbabilities: picked.probs && byKey(eligible.map((m) => m.id), picked.probs),
    effortProbabilities: effort.probs && byKey(cfg.ladder, effort.probs),
  });
  return verdict(result, confidence, interpretReasons(picked, asked, chosen, cfg));
}

// The ladder index the rules give a request, with the reason in words.
function difficulty(input, cfg) {
  const top = cfg.ladder.length - 1;
  const at = (level, reason) => ({ level: Math.min(level, top), reason });
  if (GREETING.test(input.task)) return at(LEVEL_GREETING, 'greeting');
  const streak = failureStreak(input.steps);
  if (streak >= STUCK_STREAK) return at(top, `${streak} failures in a row`);
  if (repeatsFailure(input.steps)) return at(top, 'the same failing command repeated');
  if (streak === TWO_IN_A_ROW) return at(LEVEL_HARD, 'two failures in a row');
  const hard = isHardTask(input.task);
  const reason = hard ? 'hard or long task' : 'routine task';
  return at(hard ? LEVEL_HARD : LEVEL_ROUTINE, streak === ONE_IN_A_ROW ? `first failure; ${reason}` : reason);
}

// The eligible model for a ladder index: the first below level 2, the middle at level 2, the last from 3.
function modelAtLevel(eligible, level) {
  const last = eligible.length - 1;
  if (level <= LEVEL_ROUTINE) return eligible[0];
  if (level < MODEL_TOP_LEVEL) return eligible[Math.floor(last / 2)];
  return eligible[last];
}

/** The rules' answer, for when Luna is unavailable or abstains. Same shape as interpret. */
function heuristic(input, cfg) {
  const eligible = eligibleOrThrow(input, cfg);
  const { level, reason } = difficulty(input, cfg);
  const model = modelAtLevel(eligible, level);
  const asked = cfg.ladder[level];
  const effort = clampEffort(asked, model.efforts);
  const reasons = [reason, `model ${model.id}`];
  if (effort !== asked) reasons.push(`effort ${asked} clamped to ${effort} for ${model.id}`);
  return verdict(resultFor(eligible, model, effort, {}), null, reasons);
}

function findModel(eligible, id) {
  const model = eligible.find((m) => m.id === id);
  if (!model) throw new Error(`route: model ${id} is not eligible for this request`);
  return model;
}

const higherEffort = (a, b) => (EFFORTS.indexOf(b) > EFFORTS.indexOf(a) ? b : a);

/**
 * After a failure (a streak of at least 1) the higher of Luna's and the rules' model tier and
 * effort wins, each on its own. Otherwise Luna's verdict stands. Source 'luna+rules' only when
 * the result changed.
 */
function gate(luna, rules, input, cfg) {
  const streak = failureStreak(input.steps);
  if (streak < 1) return luna;
  const eligible = eligibleOrThrow(input, cfg);
  const lunaModel = findModel(eligible, luna.result.model);
  const ruleModel = findModel(eligible, rules.result.model);
  const model = ruleModel.tier > lunaModel.tier ? ruleModel : lunaModel;
  const effort = clampEffort(higherEffort(luna.result.effort, rules.result.effort), model.efforts);
  if (model.id === luna.result.model && effort === luna.result.effort) return luna;
  const reasons = [...luna.reasons, `failure streak ${streak}: rules raise the answer to ${model.id} at ${effort}`];
  return verdict(resultFor(eligible, model, effort, luna.result), luna.confidence, reasons, 'luna+rules');
}

/** One short line for the ledger and the CLI; never the task text. */
function summarize(result) {
  return `${result.model} effort=${result.effort}`;
}

/** The `route` kind module (contract: src/contract.js). */
export const route = Object.freeze({
  name: 'route',
  normalize,
  plan,
  interpret,
  heuristic,
  gate,
  summarize,
});
