// Kind `compress` (docs/design.md §4.5): is compacting the context window now worth it, and for
// each old segment keep, summarize or drop it. Luna answers the predicate `compact_now` and one
// choice per asked segment; the rules escalate toward targetRatio (gate) and decide alone in
// `heuristic` mode. Everything here is pure: finalize applies the actions to the segments it was
// given, and nothing mutates its input.
import { verdict, certainty, mean, requireText, indexId, redact } from '../contract.js';
import { estimateTokens, excerpt } from '../text.js';
import { choiceAnswer, predicateProbability } from '../luna/answers.js';

/** Tool output older than this many turns is dropped by the rules. */
export const TOOL_DROP_AGE = 6;
/** Tool output above this many tokens is summarized by the rules. */
export const TOOL_SUMMARIZE_TOKENS = 500;
/** Assistant text above this many tokens is summarized by the rules. */
export const ASSISTANT_SUMMARIZE_TOKENS = 800;
/** Luna's compact_now probability at or above which compaction is chosen. */
export const COMPACT_PROBABILITY = 0.5;

const ROLES = ['system', 'user', 'assistant', 'tool'];
const KEEP = 'keep';
const SUMMARIZE = 'summarize';
const DROP = 'drop';
const ACTIONS = [KEEP, SUMMARIZE, DROP];
const GOAL_CHARS = 1000;
const FIRST_LINES = 2;
const LAST_LINES = 2;
const HEAD_SHARE = 0.6;
const DECIMALS = 2;
const KEY_LINE = /error|fail|exception|warn|todo|fixme|decid|result|錯誤|失敗|決定|結論/i;
const UNDER_SOFT = 'under the soft limit';
const NOTHING_ELIGIBLE = 'nothing eligible';
const ESCALATED = 'rules escalated to reach the target ratio';

const COMPACT_QUESTION = Object.freeze({
  type: 'predicate',
  name: 'compact_now',
  instructions: 'Is compacting the context now better than waiting: are old, bulky, finished segments dominating the window rather than the live working set?',
});

const ACTION_CHOICES = Object.freeze([
  { value: KEEP, description: 'still needed verbatim: the current goal, unresolved errors, code being edited, user instructions and constraints' },
  { value: SUMMARIZE, description: 'useful but verbose: long tool output whose conclusion matters, finished explorations, logs with a few key lines' },
  { value: DROP, description: 'no longer needed: superseded file reads, resolved failures, chit-chat, duplicated output' },
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const fmt = (x) => x.toFixed(DECIMALS);

// ---- normalize -----------------------------------------------------------------------------

/**
 * Validates the input and returns a new, normalized copy. Tokens default to estimateTokens(text).
 * @param {object} input `{ window, segments, goal?, force? }`
 * @returns {{window:number, segments:object[], goal:string, force:boolean}}
 * @throws {TypeError} on any bad field
 */
export function normalize(input) {
  if (!isPlainObject(input)) throw new TypeError('compress: input must be an object');
  if (!isPosInt(input.window)) throw new TypeError('compress: window must be a positive integer');
  if (!Array.isArray(input.segments)) throw new TypeError('compress: segments must be an array');
  if (input.goal !== undefined && typeof input.goal !== 'string') throw new TypeError('compress: goal must be a string');
  if (input.force !== undefined && typeof input.force !== 'boolean') throw new TypeError('compress: force must be a boolean');
  return {
    window: input.window,
    segments: normalizeSegments(input.segments),
    goal: (input.goal ?? '').trim(),
    force: input.force === true,
  };
}

function normalizeSegments(list) {
  const ids = new Set();
  return list.map((raw, i) => {
    const seg = normalizeSegment(raw, i);
    if (ids.has(seg.id)) throw new TypeError(`compress: duplicate segment id "${seg.id}"`);
    ids.add(seg.id);
    return seg;
  });
}

function normalizeSegment(raw, index) {
  if (!isPlainObject(raw)) throw new TypeError(`compress: segment ${index} must be an object`);
  const id = requireText(raw.id, 'compress: segment id');
  const label = `compress: segment "${id}"`;
  if (!ROLES.includes(raw.role)) throw new TypeError(`${label} role must be one of ${ROLES.join('|')}`);
  if (typeof raw.text !== 'string') throw new TypeError(`${label} text must be a string`);
  if (!isNonNegInt(raw.turn)) throw new TypeError(`${label} turn must be an integer >= 0`);
  if (raw.tokens !== undefined && !isNonNegInt(raw.tokens)) throw new TypeError(`${label} tokens must be an integer >= 0`);
  if (raw.pinned !== undefined && typeof raw.pinned !== 'boolean') throw new TypeError(`${label} pinned must be a boolean`);
  return {
    id,
    role: raw.role,
    text: raw.text,
    turn: raw.turn,
    tokens: raw.tokens ?? estimateTokens(raw.text),
    pinned: raw.pinned === true,
  };
}

// ---- shared helpers ------------------------------------------------------------------------

function currentTurn(segments) {
  return segments.reduce((max, s) => Math.max(max, s.turn), 0);
}

function totalTokens(segments) {
  return segments.reduce((sum, s) => sum + s.tokens, 0);
}

/** Segments compaction may touch: not pinned, not system, and older than the recent turns. */
function eligibleSegments(segments, keepRecentTurns) {
  const newest = currentTurn(segments) - keepRecentTurns;
  return segments.filter((s) => !s.pinned && s.role !== 'system' && s.turn <= newest);
}

/** The largest eligible segments, at most `maxAsked`; ties keep input order. */
function askedSegments(eligible, maxAsked) {
  return [...eligible].sort((a, b) => b.tokens - a.tokens).slice(0, maxAsked);
}

function oldestFirst(segments) {
  return [...segments].sort((a, b) => a.turn - b.turn);
}

/** The action for a segment id; a segment without an action is kept. */
function actionOf(actions, id) {
  return Object.hasOwn(actions, id) ? actions[id] : KEEP;
}

function ratioOf(input) {
  return totalTokens(input.segments) / input.window;
}

function isUnderSoft(input, cfg) {
  return !input.force && ratioOf(input) < cfg.compress.softRatio;
}

// ---- summaries -----------------------------------------------------------------------------

/**
 * The lines that carry a text: its first and last non-blank lines and every line that marks an
 * error, failure, decision or result; cut to `maxChars` (head and tail kept, an ellipsis between).
 * @param {string} text
 * @param {number} maxChars positive integer
 * @returns {string}
 */
export function extractiveSummary(text, maxChars) {
  if (typeof text !== 'string') throw new TypeError('compress: summary text must be a string');
  if (!isPosInt(maxChars)) throw new TypeError('compress: summary maxChars must be a positive integer');
  const lines = text.split(/\r?\n/);
  const content = lines.map((_, i) => i).filter((i) => lines[i].trim() !== '');
  const picked = new Set([
    ...content.slice(0, FIRST_LINES),
    ...content.slice(-LAST_LINES),
    ...content.filter((i) => KEY_LINE.test(lines[i])),
  ]);
  const kept = [...picked].sort((a, b) => a - b).map((i) => lines[i]).join('\n');
  return cutMiddle(kept, maxChars);
}

function cutMiddle(s, max) {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * HEAD_SHARE);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}

function summaryMarker(before, after) {
  return `[summarized ${before}→${after} tokens] `;
}

/**
 * The summarized segment when it is strictly smaller than the segment, else null. The marker counts
 * inside summaryChars: the body gets the budget left after it. The marker's token count is at most
 * the body budget, so bounding it by summaryChars keeps its digits (and the length) within bounds.
 */
function summarizeSegment(segment, summaryChars) {
  const budget = Math.max(1, summaryChars - summaryMarker(segment.tokens, summaryChars).length);
  const body = extractiveSummary(segment.text, budget);
  const text = `${summaryMarker(segment.tokens, estimateTokens(body))}${body}`;
  const tokens = estimateTokens(text);
  return tokens < segment.tokens ? { ...segment, text, tokens } : null;
}

/** Summary per segment id (null where a summary would not shrink the segment). */
function summariesFor(segments, summaryChars) {
  return new Map(segments.map((s) => [s.id, summarizeSegment(s, summaryChars)]));
}

/** Tokens a segment occupies after `action`; a summarize that does not shrink keeps the size. */
function sizeAfter(segment, action, summaries) {
  if (action === DROP) return 0;
  const summary = action === SUMMARIZE ? summaries.get(segment.id) : null;
  return summary ? summary.tokens : segment.tokens;
}

/**
 * Applies the actions to the segments. Segments without an action are kept; a summarize that
 * would not shrink a segment keeps it. Returns new objects; the input is not touched.
 * @param {object[]} segments normalized segments
 * @param {Record<string, 'keep'|'summarize'|'drop'>} actions
 * @param {{summaryChars:number}} ccfg the compress config
 * @returns {{segments:object[], tokensBefore:number, tokensAfter:number}}
 */
export function applyCompression(segments, actions, ccfg) {
  checkActions(actions, segments);
  const out = [];
  for (const seg of segments) {
    const action = actionOf(actions, seg.id);
    if (action === DROP) continue;
    const summary = action === SUMMARIZE ? summarizeSegment(seg, ccfg.summaryChars) : null;
    out.push(summary ?? { ...seg });
  }
  return { segments: out, tokensBefore: totalTokens(segments), tokensAfter: totalTokens(out) };
}

function checkActions(actions, segments) {
  const ids = new Set(segments.map((s) => s.id));
  for (const [id, action] of Object.entries(actions)) {
    if (!ids.has(id)) throw new TypeError(`compress: action for unknown segment "${id}"`);
    if (!ACTIONS.includes(action)) throw new TypeError(`compress: unknown action "${action}" for segment "${id}"`);
  }
}

// ---- rules: escalation and heuristic -------------------------------------------------------

/** The rule action for one eligible segment, given its age in turns. */
function ruleAction(seg, age) {
  if (seg.role === 'tool' && age > TOOL_DROP_AGE) return DROP;
  if (seg.role === 'tool' && seg.tokens > TOOL_SUMMARIZE_TOKENS) return SUMMARIZE;
  if (seg.role === 'assistant' && seg.tokens > ASSISTANT_SUMMARIZE_TOKENS) return SUMMARIZE;
  return KEEP;
}

/**
 * Escalates `actions` until the projected usage is at or below targetRatio × window, or nothing
 * else helps. Pass 1 turns keep into summarize, oldest eligible first; pass 2 turns the summarized
 * tool segments into drop, oldest first.
 * @returns {{actions:Record<string,string>, changed:boolean}}
 */
export function escalate(actions, input, cfg) {
  const limit = cfg.compress.targetRatio * input.window;
  const summaries = summariesFor(input.segments, cfg.compress.summaryChars);
  const decided = new Map(Object.entries(actions));
  const actionFor = (seg) => decided.get(seg.id) ?? KEEP;
  const eligible = oldestFirst(eligibleSegments(input.segments, cfg.compress.keepRecentTurns));
  let total = input.segments.reduce((sum, s) => sum + sizeAfter(s, actionFor(s), summaries), 0);
  let changed = false;
  const move = (seg, to) => {
    const delta = sizeAfter(seg, to, summaries) - sizeAfter(seg, actionFor(seg), summaries);
    if (delta >= 0) return;
    decided.set(seg.id, to);
    total += delta;
    changed = true;
  };
  for (const seg of eligible) {
    if (total > limit && actionFor(seg) === KEEP) move(seg, SUMMARIZE);
  }
  for (const seg of eligible) {
    if (total > limit && seg.role === 'tool' && actionFor(seg) === SUMMARIZE) move(seg, DROP);
  }
  return { actions: Object.fromEntries(decided), changed };
}

// ---- result shape --------------------------------------------------------------------------

/**
 * The result every path returns (Luna, rules, settled): every segment gets an action when
 * compacting (keep by default); a summarize that would not shrink is reported as keep.
 */
function resultFrom(input, cfg, compact, decisions) {
  const tokensBefore = totalTokens(input.segments);
  if (!compact) return shapeResult(input, false, {}, tokensBefore, tokensBefore);
  const summaries = summariesFor(input.segments, cfg.compress.summaryChars);
  const realized = new Map(input.segments.map((s) => {
    const action = actionOf(decisions, s.id);
    return [s.id, action === SUMMARIZE && !summaries.get(s.id) ? KEEP : action];
  }));
  const tokensAfter = input.segments.reduce((sum, s) => sum + sizeAfter(s, realized.get(s.id), summaries), 0);
  return shapeResult(input, true, Object.fromEntries(realized), tokensBefore, tokensAfter);
}

function shapeResult(input, compact, actions, tokensBefore, tokensAfter) {
  return { compact, actions, segments: null, tokensBefore, tokensAfter, ratioAfter: tokensAfter / input.window };
}

// ---- plan, interpret -----------------------------------------------------------------------


function stateSegment(seg, id, current, excerptChars) {
  return {
    id,
    role: seg.role,
    age: current - seg.turn,
    tokens: seg.tokens,
    text: excerpt(redact(seg.text), excerptChars, true),
    keepTail: true,
  };
}

function actionQuestion(name) {
  return {
    type: 'choice',
    name,
    instructions: `Context segment ${name}: keep it verbatim, summarize it, or drop it?`,
    choices: ACTION_CHOICES,
  };
}

/**
 * Decides what Luna must answer. Settled when the context is under the soft limit (unless forced)
 * or no segment is eligible; otherwise the state and questions for Luna.
 * @returns {{settled:object} | {state:object, questions:object[], ctx:object}}
 */
export function plan(input, cfg) {
  const k = cfg.compress;
  if (isUnderSoft(input, cfg)) return settledVerdict(input, cfg, UNDER_SOFT);
  const eligible = eligibleSegments(input.segments, k.keepRecentTurns);
  if (eligible.length === 0) return settledVerdict(input, cfg, NOTHING_ELIGIBLE);
  const ratio = ratioOf(input);
  const compactAsked = !input.force && ratio < k.hardRatio;
  const asked = askedSegments(eligible, k.maxSegmentsAsked).map((seg, i) => ({ name: indexId('g', i), id: seg.id, seg }));
  const questions = [...(compactAsked ? [COMPACT_QUESTION] : []), ...asked.map((a) => actionQuestion(a.name))];
  if (questions.length === 0) throw new Error('compress: nothing to ask Luna (maxSegmentsAsked is 0 and the context is above the hard limit)');
  const current = currentTurn(input.segments);
  const state = {
    goal: excerpt(redact(input.goal), GOAL_CHARS),
    usage: { tokens: totalTokens(input.segments), window: input.window },
    segments: asked.map((a) => stateSegment(a.seg, a.name, current, k.excerptChars)),
  };
  const ctx = { input, ratio, compactAsked, asked: asked.map(({ name, id }) => ({ name, id })) };
  return { state, questions, ctx };
}

function settledVerdict(input, cfg, reason) {
  return { settled: verdict(resultFrom(input, cfg, false, {}), null, [reason]) };
}

/**
 * Luna's answers to a plan. Compacts when forced, at or above the hard limit, or when compact_now
 * reaches COMPACT_PROBABILITY; actions come from the segment choices and are empty otherwise.
 * Throws (via answers.js) on a refused or malformed answer.
 */
export function interpret(answers, ctx, cfg) {
  const { input, asked, compactAsked, ratio } = ctx;
  const { hardRatio } = cfg.compress;
  const pCompact = compactAsked ? predicateProbability(answers, 'compact_now') : null;
  const picks = asked.map(({ name, id }) => ({ id, ...choiceAnswer(answers, name, ACTIONS) }));
  const compact = input.force || ratio >= hardRatio || (pCompact !== null && pCompact >= COMPACT_PROBABILITY);
  const decisions = Object.fromEntries(picks.map((p) => [p.id, p.choice]));
  const confidence = pCompact !== null ? certainty(pCompact) : mean(picks.map((p) => p.confidence));
  return verdict(resultFrom(input, cfg, compact, decisions), confidence, compactReasons(input, ratio, hardRatio, pCompact));
}

function compactReasons(input, ratio, hardRatio, pCompact) {
  const reasons = [];
  if (input.force) reasons.push('forced');
  else if (ratio >= hardRatio) reasons.push(`ratio ${fmt(ratio)} at or above the hard limit`);
  if (pCompact !== null) reasons.push(`compact_now ${fmt(pCompact)}`);
  return reasons;
}

// ---- heuristic, gate, finalize, summarize --------------------------------------------------

/**
 * Rules only. Compacts when forced or at or above the soft limit and something is eligible; the
 * rule actions are escalated toward targetRatio.
 */
export function heuristic(input, cfg) {
  if (isUnderSoft(input, cfg)) return verdict(resultFrom(input, cfg, false, {}), null, [UNDER_SOFT]);
  const eligible = eligibleSegments(input.segments, cfg.compress.keepRecentTurns);
  if (eligible.length === 0) return verdict(resultFrom(input, cfg, false, {}), null, [NOTHING_ELIGIBLE]);
  const current = currentTurn(input.segments);
  const ruled = Object.fromEntries(eligible.map((s) => [s.id, ruleAction(s, current - s.turn)]));
  const { actions, changed } = escalate(ruled, input, cfg);
  const reasons = [input.force ? 'forced' : `ratio ${fmt(ratioOf(input))} at or above the soft limit`];
  if (changed) reasons.push(ESCALATED);
  return verdict(resultFrom(input, cfg, true, actions), null, reasons);
}

/**
 * Runs after Luna: when Luna compacts, escalates its actions toward targetRatio. The verdict is
 * source 'luna+rules' only when the escalation changed an action; otherwise Luna's verdict is
 * returned as it is. The rules argument is not needed: the escalation is rule-based on its own.
 */
export function gate(luna, rules, input, cfg) {
  if (!luna.result.compact) return luna;
  const escalated = escalate(luna.result.actions, input, cfg);
  if (!escalated.changed) return luna;
  return verdict(
    resultFrom(input, cfg, true, escalated.actions),
    luna.confidence,
    [...luna.reasons, ESCALATED],
    'luna+rules',
  );
}

/** Applies the actions when compacting and sets segments, tokensBefore, tokensAfter, ratioAfter. */
export function finalize(v, input, cfg) {
  const { result } = v;
  const tokensBefore = totalTokens(input.segments);
  const applied = result.compact ? applyCompression(input.segments, result.actions, cfg.compress) : null;
  const tokensAfter = applied ? applied.tokensAfter : tokensBefore;
  return {
    ...v,
    result: {
      ...result,
      segments: applied ? applied.segments : null,
      tokensBefore,
      tokensAfter,
      ratioAfter: tokensAfter / input.window,
    },
  };
}

function countActions(actions) {
  return Object.values(actions).reduce((acc, a) => ({ ...acc, [a]: acc[a] + 1 }), { keep: 0, summarize: 0, drop: 0 });
}

/** One ledger line: counts and tokens only, never segment text. */
export function summarize(result) {
  if (!result.compact) return `no compaction: ${result.tokensBefore} tokens`;
  const n = countActions(result.actions);
  const after = result.tokensAfter ?? result.tokensBefore;
  return `compact: drop ${n.drop}, summarize ${n.summarize}, keep ${n.keep}; ${result.tokensBefore} → ${after} tokens`;
}

/** The kind module (frozen). */
export const compress = Object.freeze({
  name: 'compress',
  normalize,
  plan,
  interpret,
  heuristic,
  gate,
  finalize,
  summarize,
});
