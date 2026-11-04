// The contract every decision kind implements, and small helpers they share. See
// docs/design.md §3 for the full specification.
//
// A kind module exports one frozen object:
//   name                                   one of KINDS (defaults.js)
//   normalize(input, cfg) -> input          pure; validates, applies defaults, returns a NEW
//                                           object; throws TypeError on bad input
//   prepare?(input, cfg, deps) -> input     async; IO only through `deps`; returns a NEW object
//   plan(input, cfg) -> {settled: Verdict}  the rules settle it, no Luna call
//                    | {state, questions, ctx}
//   interpret(answers, ctx, cfg) -> Verdict answers keyed by name (answersByName); throws on a
//                                           malformed answer
//   heuristic(input, cfg) -> Verdict        rules-only answer, same result shape as interpret
//   gate?(luna, rules, input, cfg) -> Verdict   rules that may override Luna (default: luna)
//   finalize?(verdict, input, cfg, deps) -> Verdict  applies effects; async allowed
//   summarize(result) -> string             one short line for the ledger and CLI
//
// Verdict = { result: object, confidence: number|null, reasons: string[], source?: string }
// The engine sets `source` ('settled' | 'luna' | 'rules' | 'luna+rules'); gate sets
// 'luna+rules' when its rules changed Luna's result.
//
// deps (built by the engine):
//   store                 memory store (src/memory/store.js createMemoryStore)
//   loadCatalog(dirs)     skills catalog (src/skills/catalog.js), cached by the engine
//   repoIndex(root)       repository index (src/index/repo.js createRepoIndex), cached

/** A verdict object. */
export function verdict(result, confidence, reasons, source) {
  return { result, confidence: confidence ?? null, reasons: [...(reasons ?? [])], ...(source ? { source } : {}) };
}

/** How decided a probability is: 1 at 0 or 1, 0.5 at 0.5. */
export function certainty(p) {
  return Math.max(p, 1 - p);
}

/** Mean of numbers, or null for none. */
export function mean(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** Throws TypeError unless `v` is a non-empty string; returns it trimmed. */
export function requireText(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return v.trim();
}

/** Indexed question/state ids: prefix + position, e.g. s0, s1 (valid question names). */
export function indexId(prefix, i) {
  return `${prefix}${i}`;
}

// Words that mark a hard or deep request, English and Chinese. Shared by route and others.
export const HARD_TASK = /\b(?:design\w*|architect\w*|refactor\w*|race|races|deadlock\w*|concurren\w*|security|secure|vulnerab\w*|prove|proof\w*|optimi[sz]\w*|performance|migrat\w*|why|root cause|debug\w*|investigat\w*)\b|設計|架構|重構|除錯|根因|為什麼|為何|優化|效能|安全|並行|遷移/i;
export const DEEP_QUESTION = /\b(?:how (?:does|do|did|is|are|come)|explain (?:how|why)|in depth|deep dive|trade-?offs?|algorithm\w*|complexity|analy[sz]\w*|analys[ie]s|compar\w*)\b|深入|原理|分析|比較|權衡|取捨|演算法|複雜度|推導|證明|怎麼運作|如何運作|運作機制/i;
export const GREETING = /^\s*(hi|hello|hey|yo|thanks|thank you|ok|okay|你好|嗨|謝謝|好的?|收到)\W*$/i;
// A secret-looking string: never stored in memory, never sent in a memory_write state. It covers
// PEM keys, well-known token prefixes, JWTs, Bearer and Authorization credentials, URL
// credentials (scheme://user:pass@host), and key/value pairs whose key names a secret
// (DB_PASSWORD=..., "apiKey": "...", client_secret = "...", password: abc).
// A key name starts at the beginning of a run of name characters, so each run is scanned once.
const SECRET_KEY_NAME = String.raw`(?<![\w.-])[\w.-]*(?:password|passwd|pwd|secret(?:[_-]?key)?|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)`;
const SECRET_VALUE = String.raw`(?:"[^"\r\n]{3,}"|'[^'\r\n]{3,}'|[^\s"'\r\n]{3,})`;
const SECRET_PARTS = [
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`,
  String.raw`\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})`,
  String.raw`\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+`,
  String.raw`\bbearer\s+(?=[\w.~+/=-]*\d)[\w.~+/=-]{12,}`,
  String.raw`\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+[\w.~+/=-]{3,}`,
  String.raw`${SECRET_KEY_NAME}["']?\s*[:=]\s*${SECRET_VALUE}`,
  String.raw`\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@]+:[^\s/@]{3,}@`,
  String.raw`密碼\s*[:：=]\s*\S+`,
];
export const SECRET = new RegExp(SECRET_PARTS.map((part) => `(?:${part})`).join('|'), 'i');

const SECRET_ALL = new RegExp(SECRET.source, 'gi');
export const REDACTED = '[redacted]';

/** `text` with every secret-looking span replaced by REDACTED. */
export function redact(text) {
  return String(text).replace(SECRET_ALL, REDACTED);
}

/**
 * A message with every copy of the given literal secrets (the API key) and every secret-looking
 * span replaced by REDACTED. Accepts an Error (its message is used) or anything printable.
 */
export function scrub(text, secrets = []) {
  let out = text instanceof Error ? text.message : String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join(REDACTED);
  return redact(out);
}

/** A deep copy of plain JSON data with every string redacted. Applied to every Luna state. */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}
