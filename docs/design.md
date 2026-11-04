# luna-decision-core — Design v1

One decision layer for coding-agent harnesses. OpenAI's **Luna** (`gpt-6-luna`, Decisions API
`POST /v1/decisions`: typed questions in, calibrated probabilities out, input tokens billed only)
answers six kinds of small questions; local **rules** gate every answer and take over when Luna is
unavailable, abstains or fails.

| kind | question | Luna question types |
|---|---|---|
| `route` | which model, how much reasoning effort | choice `model` + score `effort` |
| `skills` | which skills to load | one predicate per shortlisted skill |
| `retrieve` | is context needed, which chunks are relevant | predicate `need_retrieval` + one predicate per chunk |
| `memory_recall` | which stored memories apply | one predicate per shortlisted memory |
| `memory_write` | save / update / skip, which type, which target | choices `action`, `type`, `target` + predicate `durable` |
| `compress` | compact now? keep / summarize / drop per segment | predicate `compact_now` + one choice per segment |

Runtime: Node.js ≥ 22.15, ESM, **zero dependencies**, `node --test`. Windows and Linux.

## 1. Layers

```
bin/luna-core.js            CLI: probe | decide kinds | serve (HTTP) | mcp (stdio MCP)
src/server/http.js          HTTP JSON sidecar 127.0.0.1:8792
src/server/mcp.js           MCP stdio server (tools luna_route ... luna_compress)
src/engine.js               createEngine: normalize → prepare → plan → Luna → interpret → gate → finalize → ledger
src/ledger.js               JSONL decision log (no task text)
src/registry.js             kind name → kind module
src/domains/*.js            one module per kind (pure logic + finalize)
src/skills/catalog.js       SKILL.md scanner
src/index/{chunker,repo}.js repository chunk index (BM25)
src/memory/store.js         JSONL memory store
src/luna/{client,answers}.js  Decisions transport and answer parsing   (frozen, wave 0)
src/{rubric,text,contract,config,defaults,envfile}.js shared              (frozen, wave 0)
```

## 2. Modes and the decision flow

`config.mode`: `auto` (default: Luna, fall back to rules on any error/abstention), `luna` (strict:
a Luna failure fails the decision), `heuristic` (rules only, no network).

`engine.decide(kind, input)`:

1. `input = mod.normalize(input, cfg)` — TypeError on bad input (never falls back).
2. `input = await mod.prepare?.(input, cfg, deps)` — IO (catalog scan, index search, store search).
3. mode `heuristic` → `v = mod.heuristic(input, cfg)`, source `rules`.
4. else `p = mod.plan(input, cfg)`. `p.settled` → source `settled`, no call.
5. else `askLuna(lunaOptions(cfg), { kind, ...p.state }, p.questions, transport)` →
   `luna = mod.interpret(answersByName(r), p.ctx, cfg)`. If `luna.confidence != null &&
   luna.confidence < cfg.minConfidence` → abstain (an error: "Luna abstained ...").
   `rules = mod.heuristic(input, cfg)`; `v = mod.gate ? mod.gate(luna, rules, input, cfg) : luna`;
   source `v.source ?? 'luna'`.
6. On an error in 5: mode `luna` → rethrow (after the ledger records it); mode `auto` →
   `v = mod.heuristic(input, cfg)`, source `rules`, `error = err.message`.
7. `v = await mod.finalize?.(v, input, cfg, deps) ?? v`.
8. Decision returned and appended to the ledger:

```js
Decision = {
  kind, source: 'settled'|'luna'|'rules'|'luna+rules',
  result,                      // kind-specific, below
  confidence: number|null, reasons: string[],
  cost: number|null, tokens: {input, cached}|null, calls: number, latencyMs: number,
  error?: string,              // the Luna failure that caused a fallback
}
```

## 3. Kind module contract

See `src/contract.js` (normative). Every kind module exports one frozen object with `name`,
`normalize`, optional `prepare`, `plan`, `interpret`, `heuristic`, optional `gate`, optional
`finalize`, `summarize`. Rules:

- Pure except `prepare`/`finalize`, which do IO only through `deps`.
- Never mutate inputs; return new objects.
- Question names: `[a-z][a-z0-9_]*`, indexed ids via `indexId(prefix, i)`.
- State never contains secrets; long texts are cut with `excerpt()`. The engine also applies
  `redactDeep` (contract) to every state before it is sent, as a second line of defence.
- `interpret` throws on malformed answers (via `src/luna/answers.js`), never guesses.
- `heuristic` and `interpret` return the **same result shape**.
- Named constants for every threshold not in `defaults.js` (no magic numbers).

## 4. Kinds

Effort descriptions (score levels) used by `route`, by label:
`none`/`minimal` "nothing to think about", `low` "routine: lookups, reads, a trivial change",
`medium` "ordinary engineering: a small feature, a focused edit, one clear failure", `high` "hard
engineering: design, cross-module refactor, subtle bug, two or three failures in a row", `xhigh`
"very hard or risky: architecture, security, concurrency, data integrity, or stuck after many
failures", `max` "the hardest: many interacting constraints, proofs, novel algorithms, still
failing after high effort".

### 4.1 `route` — `src/domains/route.js`, export `route`

Input: `{ task: string, steps?: Step[], contextTokens?: number ≥0, requires?: string[],
localOnly?: boolean, candidates?: string[] }`, `Step = { kind: 'read'|'edit'|'verify'|'exec'|'tool',
command: string, failed: boolean|null }`.

Eligible models (normalize/plan, same in heuristic): `cfg.route.models` filtered by `candidates`
(if given; unknown ids → TypeError), `contextWindow ≥ ceil(contextTokens × contextHeadroom)`,
`capabilities ⊇ requires`, `localOnly → m.local`; sorted by `tier` then `id`. None eligible →
`Error('route: no eligible model (...)')` from normalize (all modes).

Plan: state `{ task: excerpt 2000, recent_steps: last 8 {kind, command: excerpt 160, status
ok|failed|pending}, failures_in_a_row, context_tokens, models: [{id, tier, strengths}] }`.
Questions: choice `model` (only when ≥ 2 eligible; choices `{value: id, description: "tier N:
strengths"}`), score `effort` (levels = `cfg.ladder`, descriptions above).

Interpret: model = eligible[`quantileIndex(probs in tier order, modelQuantile)`] (single eligible →
it); effort = ladder[`scoreLevel(..., effortQuantile)`], then clamped to the model's `efforts`
(nearest by EFFORTS index, ties upward). Confidence = min(model choice confidence, effort
confidence) (effort only when one model).

Result: `{ model, effort, fallbackChain: string[] /* eligible ids with higher tier, ascending */,
modelProbabilities: {id: p}|null, effortProbabilities: {label: p}|null }`.

Heuristic: difficulty d (ladder index): greeting → 0; failure streak ≥ 3 or the same failing
command twice in the last 6 → top; streak 2 → 2; streak 1 → max(1, base); `HARD_TASK` /
`DEEP_QUESTION` / task > 600 chars → 2; else 1 (clamped to ladder). Model: d ≤ 1 → eligible[0];
d = 2 → eligible[floor((n−1)/2)]; d ≥ 3 → eligible[n−1]. Effort = ladder[d] clamped to the model.

Gate: when `steps` end in a failure streak ≥ 1, take the higher of Luna's and the rules' model
tier and effort (source `luna+rules` if anything changed); otherwise Luna's.

### 4.2 `skills` — `src/domains/skills.js`, export `skills`; `src/skills/catalog.js`

Input: `{ task, catalog?: Skill[], dirs?: string[], maxSkills? }`, `Skill = { name, description,
path? }`. Prepare: `catalog ??= deps.loadCatalog(dirs ?? cfg.skills.dirs)`.

Catalog: `loadCatalog(dirs) → Skill[]` scans `<dir>/*/SKILL.md` (one level) and parses YAML
front matter between `---` lines: `name:` and `description:` (plain, single- or double-quoted,
or a `>`/`|` block of indented lines). Missing name → folder name. Missing dir → skipped. Sorted by
name; duplicates by name keep the first dir's.

Plan: forced = skills referenced in the task as a `/name` command (at the start or after
whitespace/an opening quote), or by a distinctive name (containing `-` or `:`) as a whole word;
case-insensitive, name ≥ 4 chars. A plain word such as `testing` written in prose is left to Luna. Shortlist = `createBm25(name + description)` top `cfg.skills.shortlist`,
excluding forced. Empty shortlist → settled. State `{ task: excerpt 2000, skills: [{id: s<i>,
name, description: excerpt 300}] }`; predicate `s<i>`: `Should skill s<i> ("name") be loaded for
this task?`.

Interpret: selected = forced (reason `forced`) then shortlist with p ≥ threshold, by p desc
(reason `luna`), capped at maxSkills. Confidence = mean certainty of the shortlist predicates.

Result: `{ selected: [{ name, path|null, probability|null, reason }], considered: n }`.

Heuristic: forced, then BM25 hits with score ≥ `LEXICAL_RATIO`(0.6) × top score and top score ≥
`LEXICAL_MIN`(2.0), reason `lexical`, capped.

### 4.3 `retrieve` — `src/domains/retrieve.js`, export `retrieve`; `src/index/*`

Input: `{ query, root?: string, candidates?: Chunk[], budgetTokens?, force?: boolean }`,
`Chunk = { id, source, startLine?, endLine?, text, score? }`. Prepare: `candidates ??= root ?
deps.repoIndex(root).search(query, cfg.retrieve.shortlist) : []`. `root` is resolved to an
absolute path and must lie in `retrieve.allowedRoots` (empty: under `cfg.cwd`, the folder the
config was loaded for); before indexing, its real path (links resolved) must lie there too. Luna
sees at most `shortlist` candidates, best score first.

Index: `chunkFile(relPath, text, {chunkLines, chunkOverlap}) → Chunk[]` (line windows, ids
`relPath#startLine`, 1-based inclusive lines, posix paths). `createRepoIndex(root, rcfg)` walks
`root` synchronously (skip `ignoreDirs`, non-listed extensions, files > `maxFileBytes`, files with
a NUL byte in the first 8 KB; skip folders/files refused with EACCES/EPERM/EBUSY/ENOENT/ELOOP,
counted in `skipped`; stop at `maxFiles` or after `maxWalkMs`, setting `truncated`), BM25 over `source + text`; returns frozen
`{ search(query, k) → Chunk[] with score, files, chunks }`.

Plan: no candidates → settled `{needed: false, chunks: [], tokens: 0, considered: 0}` reason
`no candidates`. State `{ query: excerpt 2000, chunks: [{id: c<i>, source: "path:start-end",
text: excerpt excerptChars}] }`; predicate `need_retrieval` (omitted when `force`) and predicate
`c<i>` per candidate (`Is chunk c<i> relevant to the query?`).

Interpret: needed = force || p(need) ≥ 0.5. Not needed → no chunks. Else chunks with p ≥
threshold by p desc, added while the running `estimateTokens(text)` total ≤ budgetTokens (skip
one that does not fit, try the next). Confidence = certainty(p(need)) or mean chunk certainty
when forced.

Result: `{ needed, chunks: [{ id, source, startLine|null, endLine|null, text, probability|null }],
tokens, considered }`.

Heuristic: needed = force || (not `GREETING` and ≥ 2 query terms). Rank by candidate `score`
(input order if absent), keep score ≥ `LEXICAL_RATIO`(0.3) × top, fill the budget, at most
`MAX_RULE_CHUNKS`(6).

### 4.4 `memory_recall`, `memory_write` — `src/domains/memory.js`, exports `memoryRecall`, `memoryWrite`; `src/memory/store.js`

Store: `createMemoryStore(file, { now = () => new Date() } = {})` over a JSONL file (one record
per line): `{ id: 'm_' + 10 hex, type, text, source, created, updated }` (ISO strings). Methods:
`list()` (copies), `get(id)`, `search(query, k) → records + score` (BM25 on text), `add({type,
text, source})`, `update(id, {text?, type?})` (bumps `updated`; unknown id → Error), `remove(id) →
boolean`, `warnings` (unparseable lines are skipped and reported, never dropped from disk until
the next write rewrites valid records only). Writes are atomic (temp file + rename, retried on
Windows EPERM/EBUSY/EACCES) and run under an O_EXCL lock file `<file>.lock` (wait up to ~2 s; a
lock older than 10 s is stale and removed); they create the folder, append lines skipped on load
to `<file>.rejected` (no raw text for secret lines), and **refuse** a text matching `SECRET`. Reads the file on each call (no stale cache).

`memory_recall` input `{ query, limit? }`; prepare: `memories = deps.store.search(query,
cfg.memory.shortlist)`. None → settled `{memories: [], considered: 0}`. State `{ query, memories:
[{id: m<i>, type, text: excerpt 400}] }`; predicate per memory. Result `{ memories: [{id, type,
text, probability|null}], considered }`, p ≥ recallThreshold by p desc, capped at limit ??
maxRecall. Heuristic: BM25 score ≥ 0.5 × top, capped.

`memory_write` input `{ observation, source?: 'user'|'agent'|'tool' (default 'user'), type?,
dryRun?: boolean }`; prepare: `similar = deps.store.search(observation, 5)`.
Plan settles `skip` when the observation matches `SECRET` (reason `looks like a secret`; the text
never enters the state) or `similarity ≥ 0.95` to a similar memory (`already stored`). State
`{ observation: excerpt 1000, source, similar: [{id: m<i>, type, text: excerpt 400}] }`. Questions:
choice `action` (`save_new`, `update`, `skip`; `update` only when similar exist), choice `type`
(user, feedback, project, reference), predicate `durable`, choice `target` over `m<i>` when ≥ 2
similar. Interpret: durable < durableThreshold → `skip`; `update` with one similar → that target.
Result `{ action: 'save_new'|'update'|'skip', type, targetId|null, text, applied: false,
memory: null }`; confidence = action confidence.

Heuristic: secret → skip; best similarity ≥ duplicateSimilarity → `update` that one (skip if ≥
0.95); else save when `REMEMBER` (remember, always, never, prefer, don't, from now on, 記住,
以後, 總是, 不要, 偏好, 習慣) matches, else skip. Type: URL → reference; deadline/release/
milestone/專案/截止/上線 → project; always/never/don't/不要/總是/別 → feedback; else user.

Finalize (`memoryWrite`): unless `dryRun` or action `skip`: `save_new` → `deps.store.add`,
`update` → `deps.store.update(targetId, {text, type})`; sets `applied: true`, `memory: record`.

### 4.5 `compress` — `src/domains/compress.js`, export `compress`, plus `applyCompression`

Input `{ window: positive int, segments: [{ id, role: 'system'|'user'|'assistant'|'tool', text,
turn: int ≥ 0, tokens?, pinned? }], goal?: string, force?: boolean }`. Tokens default to
`estimateTokens(text)`. usage = Σ tokens; ratio = usage / window; current = max turn.

Eligible: not pinned, role ≠ system, `turn ≤ current − keepRecentTurns`.
Plan: ratio < softRatio and not force → settled `compact: false` (`under the soft limit`); no
eligible → settled `compact: false` (`nothing eligible`). Asked = eligible by tokens desc, first
`maxSegmentsAsked` (the rest default to keep). State `{ goal: excerpt 1000, usage: {tokens,
window}, segments: [{id: g<i>, role, age: current − turn, tokens, text: excerpt excerptChars,
keepTail}] }`. Questions: predicate `compact_now` only when ratio < hardRatio and not force;
choice `g<i>` (keep, summarize, drop) per asked segment.

Interpret: compact = force || ratio ≥ hard || p(compact_now) ≥ 0.5; actions `{segmentId: keep|
summarize|drop}` (empty when not compact). Confidence = certainty(compact_now) when asked, else
mean choice confidence.

Gate (the engine runs gate only after Luna; `heuristic` calls the same exported escalation
helper `escalate(actions, input, cfg)` itself): estimate tokens after actions (summarize → `min(tokens,
estimateTokens(summary))` with summary length ≤ summaryChars; drop → 0). While above
`targetRatio × window`, walk eligible segments oldest first: keep → summarize; then a second pass
summarize → drop for `tool` segments. Changes → source `luna+rules`.

Heuristic: compact = force || ratio ≥ softRatio. Actions: tool older than 6 turns → drop; tool >
500 tokens → summarize; assistant > 800 tokens → summarize; else keep; then escalate as above.

`applyCompression(segments, actions, ccfg) → { segments, tokensBefore, tokensAfter }` (new
array): drop removes; summarize replaces text with `extractiveSummary(text, summaryChars)` =
first 2 lines + lines matching `/error|fail|exception|warn|todo|fixme|decid|result|錯誤|失敗|決定|結論/i`
+ last 2 lines, deduplicated, in order, cut to summaryChars, prefixed `[summarized N→M tokens] `
(M counts the whole new text), and recomputes tokens; `compress.summaryChars` ≥ 64. The pure
helpers live in `src/domains/compress-apply.js`, re-exported by `compress.js`. Finalize sets `result.segments`, `tokensBefore`, `tokensAfter`,
`ratioAfter`.

Result: `{ compact, actions, segments|null, tokensBefore, tokensAfter, ratioAfter }`.

## 5. Engine, ledger, registry — `src/engine.js`, `src/ledger.js`, `src/registry.js`

`createEngine({ config, transport?, kinds?, deps?, ledger? })` → frozen `{ decide(kind, input),
route, skills, retrieve, recall, remember, compress, stats() }`. `kinds` defaults to the registry
(tests inject stubs). `deps` defaults: lazy `store` = `createMemoryStore(cfg.memory.path)`,
`loadCatalog` cached by `dirs.join('|')`, `repoIndex(root)` cached by resolved root; both caches expire
after `cfg.cacheTtlMs` (0 = no cache). Unknown kind →
TypeError. `stats()` → `{ decisions, lunaCalls, cost, fallbacks, errors, byKind: {kind: {decisions,
luna, rules, settled, fallbacks}} }` (returns a copy).

Ledger `createLedger({ path, enabled })` → `{ append(decision) }`: one JSON line `{ ts, kind,
source, confidence, cost, tokens, calls, latencyMs, error, summary }` where `summary =
mod.summarize(result)`; never the task, query, observation or segments. Append errors are
swallowed **once with a warning to stderr** (the decision still returns).

## 6. Interfaces — `bin/luna-core.js`, `src/server/http.js`, `src/server/mcp.js`

CLI (JSON to stdout, errors to stderr, exit 1 on error, 2 on usage):
`luna-core probe` (one live Luna call: route kind with a fixed task; prints decision, cost,
tokens), `route --task T [--context-tokens N] [--requires a,b] [--local-only]`, `skills --task T
[--dir D ...]`, `retrieve --query Q [--root R] [--budget N] [--force]`, `recall --query Q`,
`remember --text T [--source user] [--dry-run]`, `compress --file transcript.json` (input object
JSON), `serve [--port N]`, `mcp`, `config` (effective config without the key), `--mode`,
`--config`, `--version`, `--help`. Loads env files first.

HTTP: `GET /health` → `{ok, version, mode}`; `POST /v1/decide/:kind` JSON body → Decision; `GET
/v1/stats`. Binds 127.0.0.1 by default; body limit 1 MB; 400 on bad JSON/TypeError, 404 unknown
route, 502 on a strict-mode Luna error, 500 otherwise.

MCP (stdio, JSON-RPC 2.0, newline-delimited, protocol `2025-06-18`): `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`, `ping`. Tools `luna_route`,
`luna_skills`, `luna_retrieve`, `luna_recall`, `luna_remember`, `luna_compress`, closed JSON
schemas (`additionalProperties: false`). Result `content: [{type: 'text', text: JSON}]`,
`isError: true` on failure. Nothing but JSON-RPC on stdout.

## 7. Safety

- The API key only from env; never logged, never in config output, never in the ledger. It is
  a non-enumerable config property; Luna error bodies have it replaced by `[key]` (`scrub`).
- Config trust: `luna.url`, `memory.path`, `ledger.path`, `skills.dirs`, `retrieve.allowedRoots`
  are accepted only from an explicit config file, `LUNA_CORE_CONFIG` or the home config, never
  from a working-folder `luna-core.config.json`. `luna.url` must be https or loopback.
- Memory refuses secrets (contract `SECRET`) both in Luna state and on disk.
- Ledger stores no user text.
- The HTTP server binds loopback by default.
- `luna` mode never fakes a Luna success.
