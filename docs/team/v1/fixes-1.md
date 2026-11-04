# Fix wave 1 — from the independent review of fa58ed3

Verdict: ACCEPT WITH FIXES. Reviewer scratch reproductions live in
`C:\Users\eda\AppData\Local\Temp\claude\8b906a8768701197\bb769b8e-8d58-4f11-a2b0-2fa66ba2ce0d\scratchpad\`
(`redact.mjs`, `eng.mjs`, `exfil.mjs`, `memadd.mjs`, `root.mjs`, `stale.mjs`, `cfgtest.mjs`,
`corrupt.mjs`, `mutate.mjs`) — read them, re-run them after your fix, they must stop reproducing.

The lead already added config keys (do not re-add): `retrieve.allowedRoots` (absolute paths;
empty = process cwd and below), `retrieve.maxWalkMs` (5000), top-level `cacheTtlMs` (30000), all
validated in src/config.js. The rubric is now v2.

## F1 — secrets and config trust (owner: fixer-security)
Files: src/contract.js, src/config.js, src/luna/client.js, test/foundation.test.js, test/security.test.js (new).
1. HIGH — `SECRET` misses: `DB_PASSWORD=hunter2hunter2`, `AWS_SECRET_ACCESS_KEY=...`, `MY_API_KEY=...`,
   `{"password": "hunter2hunter2"}`, `{"apiKey":"..."}`, `Authorization: Bearer <JWT>`, `github_pat_...`,
   `glpat-...`, `client_secret = "..."`, `postgres://u:pw@host`, `NPM_TOKEN: abcdef12345`, `password: abc`.
   Allow `[\w.-]*` prefixes on key names (password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|
   private[_-]?key|client[_-]?secret|auth), optional closing quote before `[:=]`, quoted values, values
   ≥ 3 chars; add Bearer tokens, JWTs (`eyJ...\.eyJ...\....`), `github_pat_`, `glpat-`, URL credentials
   (`scheme://user:pass@`). Must still NOT match ordinary prose ("the token budget is large",
   "password reset flow", "secret santa", "api key rotation docs"). Table-driven tests both ways.
2. HIGH — a cwd-discovered `luna-core.config.json` may not set `luna.url`, `memory.path`,
   `ledger.path`, `skills.dirs` or `retrieve.allowedRoots`: those keys are honoured only from an
   explicit file (`file` option / `LUNA_CORE_CONFIG`) or the home config; in a cwd config they throw
   a clear error naming the key. Additionally `luna.url` must be `https:` unless the host is
   127.0.0.1/localhost (tests use http on loopback).
3. MEDIUM — client.js: error messages built from response bodies pass through `redact()` and have
   the literal apiKey replaced with `[key]` before being thrown.
4. LOW — `apiKey` on the loaded config is non-enumerable (still readable as `cfg.apiKey`), so
   `JSON.stringify(cfg)` never contains it. Model entries: validate `capabilities` (array of strings,
   default []), `local` (boolean, default false), `strengths` (string, default '') — fill defaults.

## F2 — memory store robustness (owner: fixer-memory)
Files: src/memory/store.js, src/domains/memory.js, test/store.test.js, test/memory.test.js.
1. MEDIUM — cross-process safety: an `O_EXCL` lockfile `<file>.lock` around every read-modify-write
   (retry with small sleeps via Atomics.wait up to ~2 s; a lock older than 10 s is stale and
   removed); retry `renameSync` on EPERM/EBUSY/EACCES a few times (Windows). Test: spawn 6 child
   processes (node -e) adding 5 records each to one file → exactly 30 records, no error.
2. LOW — lines skipped on load (unparseable, invalid, secret) are appended to `<file>.rejected`
   on the next write instead of being silently dropped. Test it.
3. Boundary tests (mutants survived): `durable` exactly at durableThreshold, similarity exactly at
   ALREADY_STORED and at duplicateSimilarity.

## F3 — index, retrieve and engine caches (owner: fixer-retrieve)
Files: src/index/repo.js, src/domains/retrieve.js, src/engine.js, test/index.test.js, test/retrieve.test.js, test/engine.test.js.
1. MEDIUM — repo walk skips (does not throw on) EACCES/EPERM/EBUSY/ENOENT/ELOOP dirs and files and
   stops after `maxWalkMs` (inject a clock for the test); the index reports `skipped` count and
   `truncated: boolean`.
2. MEDIUM — retrieve `normalize` resolves `root` to an absolute path and rejects (TypeError) a root
   outside `cfg.retrieve.allowedRoots` (or, when empty, outside `process.cwd()`); compare with
   path.relative, case-insensitive on win32, no `..` escape. Existing tests that use temp roots must
   pass `allowedRoots` overrides. Also the test/integration.test.js temp roots — tell the lead the
   exact override needed (do not edit integration.test.js).
3. MEDIUM — engine caches (catalog by dirs, repo index by root) expire after `cfg.cacheTtlMs`
   (0 = no cache); inject `now` in createEngine options for tests.
4. Boundary test: retrieve budget exact fit (sum == budgetTokens is kept).

## F4 — compress and skills boundaries (owner: fixer-compress)
Files: src/domains/compress.js, src/domains/skills.js, test/compress.test.js, test/skills.test.js.
1. Tests for surviving mutants: keepRecentTurns boundary (`turn <= newest - keep`), `ratio` exactly
   at hardRatio, escalation pass 2 drops only `tool` segments (an assistant segment must never be
   dropped by escalation), skills `LEXICAL_RATIO` equality.
2. LOW — the `[summarized N→M tokens]` marker reports M as the tokens of the whole new text.
3. compress.js is 445 lines (> 400 soft limit): move the pure helpers (extractiveSummary,
   applyCompression, token math) into a new src/domains/compress-apply.js, re-exported from
   compress.js so imports keep working. Output must be identical (tests unchanged pass).
