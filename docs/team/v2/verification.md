# Decision reliability and usability — verification

Date: 2026-11-05 (Asia/Taipei)

## Scope and source identity

The request was to inspect, optimize, and improve `luna-decision-core` so the
decision model is easier to use. This change improves the decision adapter,
configuration, CLI, and skill candidate selection. It does not retrain a model or
establish a measured improvement in live model accuracy.

- Baseline: `bc513ded6ba923dda352a825e2466f6fd15f7d12`.
- Locally tested code: `70ead4a76dea5d765ee2394ee932f42ffe6347b3`.
- Published equivalent code: `78e6834389c01d9c890d1abfe4f3536262ec5320`.
- Matching Git tree for both code commits: `a78a99072728b24ff2de801d4fa9b0ed995adc7a`.
- Integration branch: `codex/improve-decision-usability-20261105`.
- Documentation and runnable example files are added after the tested code commit.
- Runtime: Linux, Node.js `v24.22.1`, dependency-free package.
- Remote `main` was fetched again and still matched the baseline before delivery.

The published code commit consolidates the local author commits. Its Git tree was
checked against the tested tree byte-for-byte before the delivery branch was created.
Commit metadata differs; tracked source, tests, file modes, and paths match exactly.

## Findings and corrections

| Finding reproduced on the baseline | Correction | Regression evidence |
| --- | --- | --- |
| Negative, nonnumeric, missing, or oversized probabilities could be normalized into high-confidence decisions; confidence `2` and score `999` were accepted. | Validate supplied distributions, confidence, score range, names, uniqueness, and coverage. Normalize only sum drift within `1e-6`; retain supported scalar fallback forms when no distribution was supplied. | `test/answers-validation.test.js`; malformed auto/strict engine results, typed choices, full distributions. |
| An invalid first batch could still cause later batches to be sent. | Check each batch against its requested questions before continuing. Refusal, missing/extra answers, wrong types, and bad probabilities stop the batch sequence. | `test/luna-transport.test.js`; partial completed-response usage remains recorded by the engine. |
| JSON body timeouts after HTTP headers were swallowed. | Extend timeout classification through body consumption; report the stage and pause subsequent requests. | Loopback HTTP tests with headers sent before a stalled body. |
| Cache compatibility was global across unrelated callers; `off` left implicit caching enabled. | Scope compatibility to endpoint, model, hashed key, organization, and project. For off, use explicit mode without a breakpoint. | Two-endpoint/account isolation and no-fallback-when-off tests. |
| A concurrent successful request could erase another request's new cooldown, and a cache-negotiation retry could bypass it. | Clear only expired cooldowns; retain active concurrent failure deadlines and recheck them before every send, including retries. Support numeric and HTTP-date Retry-After. | Barrier-controlled HTTP 200/429 and cache-retry tests. The reviewer reproduced the retry defect before its fix: 3 server requests instead of 2. |
| `route.contextHeadroom: 0`, misspelled fields, invalid directory types, and negative memory limits could pass configuration loading. | Reject unknown fields, invalid objects/types, unsafe ranges, duplicate efforts, and invalid limits before engine or storage use. | `test/config-validation.test.js`; existing security and configuration suites retained. |
| The CLI could not pass the complete route/history/candidate contracts. | Add bounded JSON file/stdin input for all six decisions, preserve JSON output, add readable text output and closed top-level input fields. | `test/cli-usability.test.js`; UTF-8/BOM, byte limits, conflict handling, all six kinds, real subprocess stdin, dryRun typo before writes. |
| No offline way to distinguish configuration readiness from a live model call. | Add read-only `doctor` with text/JSON, key presence, path checks, separate decision/generation models, and explicit untested access status. | `test/diagnostics.test.js` and CLI tests; no engine creation, provider calls, or storage writes. |
| Chinese tasks with English skill descriptions could settle before reaching Luna because lexical overlap was zero. | Add opt-in `skills.semanticFallback`, bounded by the existing shortlist, with explicit first-N-of-total reporting. | `test/skills-semantic.test.js`; confirms candidate delivery using a fake model, not real semantic accuracy. |
| The cost field was described as an upper bound and calls could be mistaken for HTTP attempts. | Document base-rate estimation and completed-transport counting, including their exclusions. | Source/README/design/workflow descriptions checked against the official API guide. |

## Executed verification

| Check | Result | Evidence |
| --- | --- | --- |
| Baseline `npm test` | **PASS** | 392 tests, 0 failures, exit 0. |
| Integrated `node --test --test-reporter=tap 'test/**/*.test.js'` | **PASS** | 451 tests, 0 failures, 0 skipped, exit 0; 59 tests added to the baseline; tested code commit above. |
| `git diff --check` | **PASS** | Exit 0. |
| Existing six-model config and new semantic config loaded through `loadConfig()` | **PASS** | Both accepted; existing model defaults remain usable. |
| `node bin/luna-core.js doctor --mode heuristic` | **PASS** | Exit 0; readable offline report; live access explicitly untested. |
| `node bin/luna-core.js route --input examples/route-input.json --mode heuristic --format text` | **PASS** | Exit 0; complete result, source, reasons, and host-application reminder. |
| Semantic example in heuristic mode | **PASS** | Exit 0, rules source, zero model calls, no invented semantic selections. |
| Independent reviewer, configuration and semantic slice | **PASS** | Separate agent reviewed `24420474acbc43c26815663416706abf32dae058`; 15 focused tests and additional compatibility probes passed. |
| Independent reviewer, final integrated code | **PASS** | Separate agent reviewed `70ead4a76dea5d765ee2394ee932f42ffe6347b3`, reran all 451 tests and its own concurrent cooldown reproduction; no blocking findings remain. |
| Relative links in the six changed documentation files | **PASS** | 16 local links checked; none missing. |

Integrated TAP summary:

```text
1..451
# tests 451
# suites 0
# pass 451
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Local log SHA-256:

```text
baseline: efb9b9c3e5813fe1e44afab90d50f80cfdcbe05a404e90ba9d6ba1a3a00efb96
integrated: 03e97ff3907a3657f4d06f3305ed07ebc650d2925e37bbb3c6e9ec8ad624cf4d
```

Tests use fake transports and loopback servers. Two existing memory tests now
expect refusal to fail at `askLuna`, before `interpret`; their refusal conditions
were preserved. No valid-response fixtures were weakened to obtain a pass.

## Compatibility and use

- Existing decision stdout remains JSON. Text output is opt-in.
- Existing CLI flags, HTTP endpoints, MCP framing, default provider, model
  catalog, confidence thresholds, and routing policy remain in place.
- `--input` cannot be mixed with per-command input flags; put the entire input
  in JSON. Use `dryRun` inside a remember input, not `--dry-run` alongside it.
- JSON file/stdin input is limited to 1 MiB. The legacy `compress --file` command
  now uses the same limit and accepts a UTF-8 BOM.
- Unknown configuration/model fields now fail instead of being ignored. Correct
  misspelled fields and remove private metadata from configuration objects.
- Supplied malformed answer distributions are rejected. Existing supported
  scalar answer forms without a distribution remain accepted for compatibility.
- `skills.semanticFallback` defaults to false. When enabled, it only acts when
  both lexical and explicitly forced candidate lists are empty. It considers
  the first configured number of catalog entries, not the full large catalog.
- `doctor` is offline. A key marked set has not been authenticated; a configured
  model has not been checked for account or host availability.
- A route is a recommendation. The surrounding harness still applies the chosen
  model and effort and reports real validation outcomes on subsequent calls.

See [the practical workflow](../../decision-workflow.zh-TW.md) for PowerShell,
stdin, semantic candidate examples, and result interpretation.

## Limits and unexecuted checks

| Check | Status at source-report preparation |
| --- | --- |
| Real paid Luna / Decisions API request | **NOT_RUN** |
| Live decision quality, latency, or cache-hit benchmark | **NOT_RUN** |
| Account access to generation candidates | **NOT_RUN** |
| Codex / Claude Code host end-to-end integration | **NOT_RUN** |
| Local Windows / Node 22.15 execution of this candidate | **NOT_RUN**; the prior v1 report is historical evidence only. |
| Remote GitHub Actions for the final delivery commit | Tracked in the pull request after push; this source report does not claim a remote CI result. |
| Merge / release / deployment | **NOT_RUN** |

## Primary sources consulted

Accessed 2026-11-05:

1. [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
   — typed answer semantics, multi-question batches, confidence, explicit and
   implicit caching, cache disable behavior, and pricing caveats.
2. [Create a decision API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create)
   — choice/score/predicate request and response types and request limits.

Official documentation verification establishes the intended protocol contract;
it does not replace a live provider test or an application-specific labeled evaluation.
