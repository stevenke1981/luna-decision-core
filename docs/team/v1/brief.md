# Team brief — luna-decision-core v1

Repo: `D:\luna-decision-core` (git, branch `main`). Node ≥ 22.15, ESM, zero dependencies.
Read first, in order: `docs/design.md` (the spec — authoritative), `src/contract.js`,
`src/luna/answers.js`, `src/luna/client.js`, `src/text.js`, `src/defaults.js`, `src/config.js`,
`test/helpers/fakeLuna.js`, `test/foundation.test.js` (test style).

Reference (read-only, for style and Decisions API shape): `D:\luna-decision-openai\src\decisions.js`.

## Hard rules

1. Touch **only the files you own** (list in your task). Do not edit wave-0 files
   (`src/luna/*`, `src/rubric.js`, `src/text.js`, `src/contract.js`, `src/config.js`,
   `src/defaults.js`, `src/envfile.js`, `test/helpers/*`, `test/foundation.test.js`, `docs/*`).
   If you believe a shared file is wrong, say so in your report — do not change it.
2. No `git add`, `commit`, `stash`, `checkout`, `reset`. No new dependencies; no `npm install`.
3. Run only your own tests: `node --test test/<yours>.test.js` (from the repo root).
4. Tests use `fakeLuna` or plain answer objects — **never** the network or a real key.
   Temp files under `os.tmpdir()` with `fs.mkdtempSync`, removed in `finally`.
   A server in a test listens on port 0 and is closed at the end.
5. Immutable style: never mutate inputs or config; return new objects. Functions < 50 lines,
   files < 400 lines where possible. Named constants, no magic numbers. JSDoc on exports.
6. Errors: throw `TypeError` for bad input, `Error` otherwise; messages start with the kind
   name (e.g. `route: ...`). Never swallow errors silently.
7. Every behaviour in the spec section you own has a test (normal, edge, failure). Aim ≥ 90 %
   of your branches.

## Acceptance

- `node --test test/<yours>.test.js` passes with ≥ the tests listed in your task.
- Output shapes match `docs/design.md` exactly (field names, value sets).
- `node -e "import('./src/<your module>.js')"` loads without error.

## Report format (your final message, ≤ 40 lines)

```
FILES: <created/changed files>
TESTS: <command> → <pass>/<total>
SPEC DEVIATIONS: <none | list with reason>
SHARED-FILE ISSUES: <none | list>
OPEN QUESTIONS / RISKS: <...>
```
