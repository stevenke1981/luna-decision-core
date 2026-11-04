// Transport to OpenAI's Luna (gpt-6-luna) via the Decisions API (POST /v1/decisions): typed
// questions in (score, predicate, choice), calibrated probabilities out, billed for input
// tokens only. Every call starts with the same rubric, marked as a cache breakpoint, so only the
// JSON state differs between calls. Calls with many questions are split into batches that share
// the state. A failure that the next call would repeat (timeout, bad key, rate limit) pauses
// Luna for that endpoint and key, so it costs one failure, not one per decision.
import { createHash } from 'node:crypto';
import { RUBRIC, CACHE_KEY } from '../rubric.js';
import { redact } from '../contract.js';

// Uncached input; output is free. Cached reads cost less, so this is an upper bound.
export const USD_PER_INPUT_TOKEN = 0.10 / 1e6;
const PAUSE_MS = { timeout: 30_000, auth: 600_000, rate: 60_000 };
const MAX_RETRY_AFTER_MS = 600_000;
const QUESTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;
// What replaces the literal API key when a server echoes it back in an error message.
export const KEY_MARK = '[key]';

const pausedUntil = new Map();
let explicitCacheRejected = false;

/** Ends every pause and forgets a rejected cache mode; for tests. */
export function resetLunaState() {
  pausedUntil.clear();
  explicitCacheRejected = false;
}

/**
 * Text from a response body, safe to put in an error message: the literal API key is replaced
 * by KEY_MARK first, then every secret-looking span is redacted.
 * @param {unknown} text
 * @param {string} [apiKey]
 * @returns {string}
 */
export function scrubDetail(text, apiKey) {
  const str = String(text);
  const withoutKey = apiKey ? str.split(apiKey).join(KEY_MARK) : str;
  return redact(withoutKey);
}

function pauseKey(opts) {
  return `${opts.url} ${createHash('sha256').update(opts.apiKey ?? '').digest('hex').slice(0, 16)}`;
}

function pause(opts, ms) {
  pausedUntil.set(pauseKey(opts), Date.now() + ms);
}

function retryAfterMs(res) {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, MAX_RETRY_AFTER_MS) : PAUSE_MS.rate;
}

/**
 * Checks a question list before it costs a call: unique valid names, a choice with at least
 * two distinct values, a score with 2 to 10 levels.
 */
export function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('no questions to ask Luna');
  const names = new Set();
  for (const q of questions) {
    if (!QUESTION_NAME.test(q?.name ?? '')) throw new Error(`invalid question name "${q?.name}"`);
    if (names.has(q.name)) throw new Error(`duplicate question name "${q.name}"`);
    names.add(q.name);
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) throw new Error(`question "${q.name}" has no instructions`);
    if (q.type === 'choice') {
      const values = (q.choices ?? []).map((c) => c?.value);
      if (values.length < 2 || new Set(values).size !== values.length) throw new Error(`choice "${q.name}" needs at least 2 distinct choices`);
    } else if (q.type === 'score') {
      const n = q.levels?.length ?? 0;
      if (n < 2 || n > 10) throw new Error(`score "${q.name}" needs 2 to 10 levels`);
    } else if (q.type !== 'predicate') {
      throw new Error(`question "${q.name}" has unknown type "${q.type}"`);
    }
  }
}

/** The Decisions request body: rubric (cache breakpoint) first, then the state as JSON. */
export function requestBody(model, state, questions, cacheMode = 'explicit') {
  const rubric = { type: 'input_text', text: RUBRIC };
  if (cacheMode === 'explicit') rubric.prompt_cache_breakpoint = { mode: 'explicit' };
  return {
    model,
    input: [
      { role: 'developer', content: [rubric] },
      { role: 'user', content: [{ type: 'input_json', data: state }] },
    ],
    questions,
    ...(cacheMode !== 'off' ? { prompt_cache_key: CACHE_KEY } : {}),
    ...(cacheMode === 'explicit' ? { prompt_cache_options: { mode: 'explicit' } } : {}),
  };
}

/** Tokens and the uncached-price upper bound of one response. */
export function callCost(usage) {
  const input = Number.isFinite(usage?.input_tokens) ? usage.input_tokens : null;
  if (input == null) return { cost: null, tokens: null };
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return { cost: input * USD_PER_INPUT_TOKEN, tokens: { input, cached } };
}

function headersFor(opts) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
    ...(opts.organization ? { 'openai-organization': opts.organization } : {}),
    ...(opts.project ? { 'openai-project': opts.project } : {}),
  };
}

async function send(opts, body) {
  try {
    return await fetch(opts.url, {
      method: 'POST', headers: headersFor(opts), body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') pause(opts, PAUSE_MS.timeout);
    throw err;
  }
}

/**
 * POSTs one Decisions request; resolves to the parsed body or throws.
 * @param {LunaOptions} opts
 */
export async function postDecision(opts, state, questions) {
  if (!opts.apiKey) throw new Error('no OpenAI API key (set LUNA_API_KEY or OPENAI_API_KEY)');
  const until = pausedUntil.get(pauseKey(opts)) ?? 0;
  if (Date.now() < until) throw new Error(`Luna paused for ${Math.ceil((until - Date.now()) / 1000)} s after a failure`);
  let mode = opts.cacheMode ?? 'explicit';
  if (mode === 'explicit' && explicitCacheRejected) mode = 'implicit';
  let res = await send(opts, requestBody(opts.model, state, questions, mode));
  let body = await res.json().catch(() => null);
  if (res.status === 400 && mode === 'explicit' && /cache/i.test(body?.error?.message ?? '')) {
    explicitCacheRejected = true;
    res = await send(opts, requestBody(opts.model, state, questions, 'implicit'));
    body = await res.json().catch(() => null);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) pause(opts, PAUSE_MS.auth);
    if (res.status === 429) pause(opts, retryAfterMs(res));
    const detail = scrubDetail(body?.error?.message ?? 'no error body', opts.apiKey);
    throw new Error(`Luna HTTP ${res.status}: ${detail}`);
  }
  pausedUntil.delete(pauseKey(opts));
  return body;
}

/**
 * Asks every question, in batches of at most `opts.maxQuestionsPerCall` that share the state,
 * through `transport` (postDecision by default; tests inject a fake). Batches run in sequence
 * so a pause after a failure stops the rest.
 * @param {LunaOptions} opts
 * @param {object} state the JSON state (must carry a "kind" field)
 * @param {object[]} questions
 * @param {(opts:LunaOptions, state:object, questions:object[]) => Promise<object>} [transport]
 * @returns {Promise<{answers:object[], cost:number|null, tokens:{input:number, cached:number}|null, calls:number}>}
 */
export async function askLuna(opts, state, questions, transport = postDecision) {
  validateQuestions(questions);
  const size = Math.max(1, opts.maxQuestionsPerCall ?? 16);
  const answers = [];
  let cost = null;
  let tokens = null;
  let calls = 0;
  for (let i = 0; i < questions.length; i += size) {
    const body = await transport(opts, state, questions.slice(i, i + size));
    calls++;
    if (Array.isArray(body?.answers)) answers.push(...body.answers);
    const c = callCost(body?.usage);
    if (c.cost != null) {
      cost = (cost ?? 0) + c.cost;
      tokens = { input: (tokens?.input ?? 0) + c.tokens.input, cached: (tokens?.cached ?? 0) + c.tokens.cached };
    }
  }
  return { answers, cost, tokens, calls };
}

/**
 * @typedef {{url:string, apiKey:string, model:string, timeoutMs:number, cacheMode?:'explicit'|'implicit'|'off',
 *   organization?:string, project?:string, maxQuestionsPerCall?:number}} LunaOptions
 */
