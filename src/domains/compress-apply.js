// The pure helpers behind `compress` (docs/design.md §4.5): the action names, token math, the
// extractive summary and applyCompression. Nothing here mutates its input, and the summary budget
// comes in as an argument. compress.js re-exports the public helpers, so its importers are unaffected.
import { estimateTokens } from '../text.js';

/** Keep a segment verbatim. */
export const KEEP = 'keep';
/** Replace a segment with its extractive summary. */
export const SUMMARIZE = 'summarize';
/** Remove a segment. */
export const DROP = 'drop';
/** Every action name, in the order Luna is offered them. */
export const ACTIONS = Object.freeze([KEEP, SUMMARIZE, DROP]);

const FIRST_LINES = 2;
const LAST_LINES = 2;
const HEAD_SHARE = 0.6;
const KEY_LINE = /error|fail|exception|warn|todo|fixme|decid|result|錯誤|失敗|決定|結論/i;

/** True for a positive integer; shared with compress.js for its own validation. */
export const isPosInt = (v) => Number.isInteger(v) && v > 0;

// ---- token math ----------------------------------------------------------------------------

/**
 * Sum of the tokens of the segments.
 * @param {{tokens:number}[]} segments
 * @returns {number}
 */
export function totalTokens(segments) {
  return segments.reduce((sum, s) => sum + s.tokens, 0);
}

/**
 * Tokens a segment occupies after `action`; a summarize that does not shrink keeps the size.
 * @param {{id:string, tokens:number}} segment
 * @param {string} action keep, summarize or drop
 * @param {Map<string, object|null>} summaries from summariesFor
 * @returns {number}
 */
export function sizeAfter(segment, action, summaries) {
  if (action === DROP) return 0;
  const summary = action === SUMMARIZE ? summaries.get(segment.id) : null;
  return summary ? summary.tokens : segment.tokens;
}

/** The action for a segment id; a segment without an action is kept. */
export function actionOf(actions, id) {
  return Object.hasOwn(actions, id) ? actions[id] : KEEP;
}

// ---- extractive summaries ------------------------------------------------------------------

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
 * The marker's count is the tokens of the whole text it starts, and those tokens include the
 * marker's own digits. So the count is iterated to a fixed point. Each pass can only raise the
 * count (more digits never count fewer tokens), and the count moves by a few tokens at most, so
 * the loop ends after a few passes.
 */
function withMarker(before, body) {
  let after = estimateTokens(body);
  let text = `${summaryMarker(before, after)}${body}`;
  while (estimateTokens(text) !== after) {
    after = estimateTokens(text);
    text = `${summaryMarker(before, after)}${body}`;
  }
  return text;
}

/**
 * The summarized segment when it is strictly smaller than the segment, else null. The marker counts
 * inside summaryChars: the body gets the budget left after it. A text never has more tokens than
 * characters, so the marker's count has no more digits than summaryChars does, and the budget holds.
 */
function summarizeSegment(segment, summaryChars) {
  const budget = Math.max(1, summaryChars - summaryMarker(segment.tokens, summaryChars).length);
  const text = withMarker(segment.tokens, extractiveSummary(segment.text, budget));
  const tokens = estimateTokens(text);
  return tokens < segment.tokens ? { ...segment, text, tokens } : null;
}

/**
 * Summary per segment id (null where a summary would not shrink the segment).
 * @param {{id:string, text:string, tokens:number}[]} segments
 * @param {number} summaryChars the compress.summaryChars budget
 * @returns {Map<string, object|null>}
 */
export function summariesFor(segments, summaryChars) {
  return new Map(segments.map((s) => [s.id, summarizeSegment(s, summaryChars)]));
}

// ---- apply ---------------------------------------------------------------------------------

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
