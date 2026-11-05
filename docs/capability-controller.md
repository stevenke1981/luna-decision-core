# Evidence-driven capability control

This is an **opt-in extension of `route`**, not another model provider or an execution engine.
Existing inputs without `control` retain their result shape. An optional `steps[].failureKind`
excludes explicitly classified infrastructure failures from legacy failure-based escalation.
Unknown, unclassified legacy failures keep the old behavior for compatibility.

## Run the offline reference

```sh
npm test
npm run examples:capability
node bin/luna-core.js route --mode heuristic --config examples/capability/offline.config.json --input examples/capability/route-input.json
```

These commands use synthetic `worker-demo` / `expert-demo` catalogs and receipts. They make no
provider calls and do not modify Crew, Sigma, Night Lamp, or the user's installed agents.
The seven examples assert their outcomes; they are contract tests, not model-quality benchmarks.
See [the practical walkthrough](seven-principles.zh-TW.md).

## Contract

`control` is accepted by the library, CLI JSON input, HTTP `POST /v1/decide/route`, and MCP
`luna_route`. Its closed schema is exported as `CONTROL_SCHEMA` from `src/capability.js`.
Required fields: `taskId`, `revision`, `goal`, and a nonempty array of acceptance-criterion IDs.
`task` remains required by `route`; keep it consistent with `control.goal`.

| Field | Meaning |
| --- | --- |
| `constraints` | Outcome constraints forwarded to a fresh Luna routing request; the host must enforce them. |
| `current` | The model and native effort actually in use, not merely recommended. |
| `attempts` | Oldest-first host observations, uniquely identified, scoped to `taskId`. Include model, effort, outcome and, for failures, a root cause. |
| `evidence` | Criterion, artifact revision, pass/fail/not_run, source, and a reference to an actual receipt. |
| `context` | Candidate metadata: source, estimated tokens, relevance, required/stale flags and trust label. No file content is fetched here. |
| `requiredTools`, `availableTools` | Tools needed and capabilities actually observed in the executing host. Names alone grant no authorization. |
| `tasks` | Dependency graph with pending/running/done states and literal workspace-relative write resources. `*` locks all resources. |
| `maxParallel` | Total running plus newly ready work; default 1, maximum 16. |
| `maxAttempts` | All observations for the current task, including blocked attempts; default 8, maximum 128. |
| `contextBudgetTokens` | Candidate-context allocation only; default 4000. Also supply outer `contextTokens` for the entire request's model-window eligibility. |

The host owns this history; the core is stateless. Use a new `taskId` for a new job and a new
`revision` after artifact changes. Keep attempt IDs and receipt references distinct. There is
no implicit history import or persistent-memory write. This does not alter provider/cost policy.

## Escalation and stopping

Only `reasoning` or `implementation` failures with a `test`, `tool`, or `human` receipt count.
A model's own claim is not evidence. Two distinct, consecutive failures at the *current*
model/effort raise to its next declared native effort. The host applies the change and updates
`current`; the previous stage's failures no longer count. Two failures at native maximum select
the next higher eligible configured tier. The new model starts at its lowest declared effort.
No higher eligible model means `report_blocker`. Empty/unsupported effort declarations mean
`discover_capabilities`, not an invented `max` or universal provider mapping.

Repeated identical error fingerprints **and unchanged hypotheses** produce `change_strategy`
instead of another escalation. Missing classifications or receipts produce `diagnose`.
`auth`, `permission`, `network`, `rate_limit`, `tool`, `schema`, `context`, and
`model_unavailable` yield specific repair actions. The core does not rotate accounts, bypass a
stop instruction, retry HTTP calls, or change cost policy to solve these problems.

Required stale/oversized context is reported as missing rather than silently discarded. Context
trust labels are preserved; the host must treat retrieved text as data, not instructions.
The scheduler respects dependencies, running work, the parallel limit, and parent-path write
conflicts (case-insensitive for conservative Windows use). It does not launch agents, lock a real
filesystem, or resolve symlinks; the host must normalize aliases and enforce isolation.

Completion requires every criterion to have a current-revision external pass receipt with a
reference. A later external fail/not_run receipt invalidates an earlier pass. Worker success
without full acceptance yields `verify`. Exhausted attempt budget yields `budget_exhausted`.

## Host integration boundary

1. Inspect live backend support and apply account, permission, model-ban and spend filters to
   `route.models` / `candidates` before routing. The configured catalog is not live discovery.
2. Supply the task contract, current stage and observed tool/context state. Execute only an
   authorized action; `canExecute` means the controller found no planning blocker, **not** consent.
3. Read back actual model/effort and tool results. Validate receipt ownership, content, artifact
   revision and pass/fail status. This pure controller checks metadata, not files or signatures.
4. Update `current` only after the backend confirms a switch. Append a new attempt with its
   receipt and changed hypothesis. Re-evaluate. Stop/hand off on non-executable actions.
5. Deliver artifacts, observed verification and unresolved limitations. Do not call this a
   desktop installation, real worker execution, or paid-provider validation.

Fresh ready contracts can still ask Luna in `auto`/`luna` mode. Ongoing stages with `current`,
completion and repair decisions are settled locally and report `source: settled`, `calls: 0`.
`heuristic` mode always stays offline. The ledger retains its existing minimal summary, not the
new raw task history or receipt paths. No agent has been silently switched by these changes.

## Evaluation and provenance

Compare candidate policies on fixed representative tasks and artifact revisions. Record task
success, regressions, human usability, model/tool cost and elapsed time separately. Report
unknown cost as unknown, not zero; avoid optimizing a single uncalibrated confidence score.
Choose weights only for an explicit use case and retain hard safety/budget constraints.
No benchmark improvement or model-accuracy claim is established by the offline tests here.

Primary references, consulted 2026-11-05:

- [OpenAI reasoning best practices](https://developers.openai.com/api/docs/guides/reasoning-best-practices): clear goals and constraints, without prescribing hidden reasoning steps.
- [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning): effort controls are model/API dependent; verify the executing backend.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): maintain relevant context rather than indiscriminately adding history.
- [Anthropic building effective agents](https://www.anthropic.com/engineering/building-effective-agents): prefer the simplest effective workflow; parallelize decomposable work.
- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices): task-specific evaluations and continuous regression checks.

The exact two-failure policy, field names and thresholds are project engineering choices, not
vendor recommendations or scientific laws. The earlier conversational model/effort table is
not treated as authoritative provider capability data.
