# Decision reliability and usability improvement

Date: 2026-11-05 (Asia/Taipei)

## Goal and baseline

Make the decision model easier to configure, invoke, and diagnose without changing
the default provider, routing policy, permission boundaries, or execution model.
Baseline: `bc513ded6ba923dda352a825e2466f6fd15f7d12`.
The baseline suite passed all 392 tests on Linux with Node.js 24.22.1.

## Work and ownership

| Owner | Scope | Acceptance |
| --- | --- | --- |
| Primary agent | Configuration validation, optional semantic skill candidates, integration, documentation | Invalid settings and misspelled fields fail before network or storage effects; an opt-in bounded catalog can reach Luna without lexical overlap; examples run offline. |
| Transport author | Answer parsing and Decisions transport | Invalid model answers cannot become high-confidence decisions; malformed batches stop further calls; timeouts and cache compatibility stay isolated. |
| CLI author | CLI input, text output, offline diagnostics | Full decision inputs work from JSON files or stdin; existing JSON output stays compatible; diagnostics perform no network calls or writes. |
| Independent reviewer | Read-only review of the integrated candidate | Reproduce defects, examine the final diff, and report remaining issues with evidence. |

Each author uses a separate Git worktree. The primary agent integrates local
commits, runs the complete suite, and records exact verification scope.

## Constraints

- Keep the package dependency-free and retain Node.js >= 22.15 compatibility.
- Preserve existing default model choices, confidence thresholds, modes, and
  permission checks; configured candidates are not claims of account access.
- Use local fake transports and loopback servers for verification. A real paid
  Decisions request is not part of the baseline or regression suite.
- Do not merge, deploy, change accounts, or expose credentials.
- Separate local test results, remote CI, and live provider verification.

## Evidence

The final report will record source and candidate commits, executed commands,
test results, independent review findings, and untested environments. Official
Decisions API documentation is used to check wire-format assumptions; unit tests
alone do not establish production model quality.
