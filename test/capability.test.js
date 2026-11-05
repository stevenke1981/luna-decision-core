import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeControl, capabilityDecision, FAILURE_KINDS } from '../src/capability.js';
import { route } from '../src/domains/route.js';
import { createEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { fakeLuna } from './helpers/fakeLuna.js';
import { contract, failure, models, runExamples } from '../examples/capability/seven-principles.mjs';

const decide = (extra = {}, catalog = models) => capabilityDecision(normalizeControl(contract(extra)), { model: models[0].id, effort: 'medium' }, catalog);
const receipt = (criterion, extra = {}) => ({ criterion, revision: 'fixture-v1', status: 'pass', source: 'test', reference: `fixture://${criterion}`, ...extra });
const config = (t, mode = 'heuristic') => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return loadConfig({ cwd: home, env: { LUNA_CORE_HOME: home }, overrides: { mode, route: { models } } });
};

test('seven principles execute as asserted offline examples', async () => assert.equal((await runExamples()).length, 7));
test('normalization and planning do not mutate caller-owned objects', () => {
  const raw = contract({ tasks: [{ id: 'one' }] });
  const before = structuredClone(raw);
  const c = normalizeControl(raw);
  capabilityDecision(c, c.current, models);
  assert.deepEqual(raw, before);
  assert.deepEqual(c.tasks[0].dependsOn, []);
});
test('one evidenced failure repairs and retries the same stage', () => {
  const d = decide({ attempts: [failure(1)] });
  assert.equal(d.nextAction, 'retry'); assert.equal(d.verifiedFailures, 1); assert.equal(d.effort, 'medium');
});
test('two evidenced failures raise only the native effort', () => {
  const d = decide({ attempts: [failure(1), failure(2)] });
  assert.equal(d.nextAction, 'raise_effort'); assert.equal(d.model, 'worker-demo'); assert.equal(d.effort, 'high');
});
test('switching effort starts at zero rather than reusing old failures', () => {
  const attempts = [failure(1), failure(2)];
  assert.equal(decide({ current: { model: 'worker-demo', effort: 'high' }, attempts }).nextAction, 'execute');
  const d = decide({ current: { model: 'worker-demo', effort: 'high' }, attempts: [...attempts, failure(3, { effort: 'high' })] });
  assert.equal(d.nextAction, 'retry'); assert.equal(d.verifiedFailures, 1);
});
test('two failures at native max escalate to next eligible model, not a universal max', () => {
  const d = decide({ current: { model: 'worker-demo', effort: 'high' }, attempts: [failure(1, { effort: 'high' }), failure(2, { effort: 'high' })] });
  assert.equal(d.nextAction, 'escalate_model'); assert.equal(d.model, 'expert-demo'); assert.equal(d.effort, 'low');
});
test('model switch and new task do not inherit old failure stages', () => {
  const attempts = [failure(1, { effort: 'high' }), failure(2, { effort: 'high' })];
  assert.equal(decide({ current: { model: 'expert-demo', effort: 'low' }, attempts }).nextAction, 'execute');
  const d = decide({ taskId: 'new-task', attempts });
  assert.equal(d.verifiedFailures, 0); assert.equal(d.attemptsUsed, 0); assert.equal(d.nextAction, 'execute');
});
test('native max without a stronger eligible model reports a blocker', () => {
  assert.equal(decide({ current: { model: 'worker-demo', effort: 'high' }, attempts: [failure(1, { effort: 'high' }), failure(2, { effort: 'high' })] }, [models[0]]).nextAction, 'report_blocker');
});
const remedies = { auth: 'repair_auth', permission: 'request_authorization', network: 'repair_transport', rate_limit: 'wait_rate_limit', tool: 'repair_tools', schema: 'repair_config', context: 'gather_context', model_unavailable: 'discover_capabilities', unknown: 'diagnose' };
for (const [kind, action] of Object.entries(remedies)) test(`${kind} failure does not consume a reasoning escalation`, () => {
  const d = decide({ attempts: [failure(1, { failureKind: kind }), failure(2, { failureKind: kind })] });
  assert.equal(d.nextAction, action); assert.equal(d.model, 'worker-demo'); assert.equal(d.effort, 'medium'); assert.equal(d.canExecute, false);
});
test('same error plus same hypothesis triggers a strategy change', () => {
  assert.equal(decide({ attempts: [failure(1, { hypothesis: 'same' }), failure(2, { hypothesis: 'same' })] }).nextAction, 'change_strategy');
});
test('duplicate evidence references cannot manufacture two failures', () => {
  const d = decide({ attempts: [failure(1, { evidenceRef: 'fixture://same-run' }), failure(2, { evidenceRef: 'fixture://same-run' })] });
  assert.equal(d.verifiedFailures, 1); assert.equal(d.nextAction, 'retry');
});
test('model self-report and missing evidence cannot trigger an escalation', () => {
  for (const change of [{ source: 'model' }, { evidenceRef: undefined }]) {
    const attempts = [failure(1, change), failure(2, change)].map((a) => JSON.parse(JSON.stringify(a)));
    assert.equal(decide({ attempts }).nextAction, 'diagnose');
  }
});
test('success interrupts the failure streak but does not imply acceptance', () => {
  const d = decide({ attempts: [failure(1), failure(2, { outcome: 'pass' })] });
  assert.equal(d.nextAction, 'verify'); assert.equal(d.acceptance.status, 'pending');
});
test('attempt budget stops work without changing the model', () => {
  assert.equal(decide({ maxAttempts: 2, attempts: [failure(1), failure(2)] }).nextAction, 'budget_exhausted');
});
test('all criteria need current revision external receipts, not confidence', () => {
  const complete = [receipt('focus-tests'), receipt('manual-typing-check', { source: 'human' })];
  assert.equal(decide({ evidence: complete }).nextAction, 'complete');
  for (const change of [{ revision: 'old' }, { source: 'model' }, { status: 'not_run' }, { reference: undefined }]) {
    const evidence = complete.map((e) => JSON.parse(JSON.stringify({ ...e, ...change })));
    assert.notEqual(decide({ evidence }).nextAction, 'complete');
  }
});
test('later external failure or not-run receipt invalidates earlier pass even without a ref', () => {
  for (const status of ['fail', 'not_run']) {
    const evidence = [receipt('focus-tests'), receipt('manual-typing-check'), { criterion: 'focus-tests', revision: 'fixture-v1', status, source: 'test' }];
    assert.notEqual(decide({ evidence }).nextAction, 'complete');
  }
});
test('required context wins over optional context within budget; stale sources are omitted', () => {
  const d = decide({ contextBudgetTokens: 10, context: [
    { id: 'optional', source: 'old.md', tokens: 10, relevance: 1 },
    { id: 'required', source: 'current.js', tokens: 8, required: true },
    { id: 'stale', source: 'stale.md', tokens: 1, stale: true },
  ] });
  assert.deepEqual(d.context.selected.map((x) => x.id), ['required']);
  assert.equal(d.context.tokens, 8); assert.equal(d.nextAction, 'execute');
});
test('oversized or stale mandatory context blocks rather than silently dropping it', () => {
  for (const change of [{ tokens: 11 }, { tokens: 1, stale: true }]) {
    const d = decide({ contextBudgetTokens: 10, context: [{ id: 'source', source: 'current.js', required: true, ...change }] });
    assert.equal(d.nextAction, 'gather_context'); assert.deepEqual(d.context.missing, ['source']);
  }
});
test('missing tools block and an observed available tool unblocks', () => {
  assert.equal(decide({ requiredTools: ['ffprobe'] }).nextAction, 'repair_tools');
  assert.equal(decide({ requiredTools: ['ffprobe'], availableTools: ['ffprobe'] }).nextAction, 'execute');
});
test('planner respects dependencies, concurrency and case-insensitive parent write locks', () => {
  const d = decide({ maxParallel: 3, tasks: [
    { id: 'core', writes: ['src/'] }, { id: 'collider', writes: ['SRC\\./focus.rs'] },
    { id: 'docs', writes: ['docs'] }, { id: 'integration', dependsOn: ['core'] },
  ] });
  assert.deepEqual(d.parallel.ready, ['core', 'docs']);
});
test('running task consumes concurrency and write locks', () => {
  const d = decide({ maxParallel: 2, tasks: [
    { id: 'running', status: 'running', writes: ['src'] },
    { id: 'collision', writes: ['src/focus.rs'] }, { id: 'docs', writes: ['docs'] },
  ] });
  assert.deepEqual(d.parallel.ready, ['docs']); assert.deepEqual(d.parallel.running, ['running']);
});
test('all-done work requests verification; pending dependencies wait', () => {
  assert.equal(decide({ tasks: [{ id: 'one', status: 'done' }] }).nextAction, 'verify');
  assert.equal(decide({ tasks: [{ id: 'one', status: 'running' }, { id: 'two', dependsOn: ['one'] }] }).nextAction, 'await_dependencies');
});
test('unknown native efforts require host discovery rather than a guessed setting', () => {
  assert.equal(decide({}, [{ ...models[0], efforts: [] }]).nextAction, 'discover_capabilities');
  assert.equal(decide({ current: { model: 'worker-demo', effort: 'max' } }).nextAction, 'discover_capabilities');
});
const invalid = [
  { acceptance: [] }, { acceptance: ['same', 'same'] }, { surprise: true }, { maxParallel: 0 },
  { contextBudgetTokens: 0.5 }, { attempts: [failure(1), failure(1)] },
  { tasks: [{ id: 'a', dependsOn: ['b'] }] },
  { tasks: [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }] },
  { evidence: [receipt('unknown')] }, { tasks: [{ id: 'a', writes: ['../secret'] }] },
  { tasks: [{ id: 'a', writes: ['C:\\src'] }] }, { tasks: [{ id: 'a', writes: ['src/*.js'] }] },
];
for (const [i, extra] of invalid.entries()) test(`malformed control boundary ${i + 1} is rejected`, () => assert.throws(() => normalizeControl(contract(extra)), TypeError));
test('current model must satisfy candidate and context eligibility', (t) => {
  const cfg = config(t);
  const input = route.normalize({ task: 'work', candidates: ['expert-demo'], control: contract() }, cfg);
  assert.throws(() => route.heuristic(input, cfg), /not eligible/);
});
test('classified legacy transport failures no longer force maximum effort', (t) => {
  const cfg = config(t);
  const steps = [{ kind: 'verify', command: 'same', failed: true }, { kind: 'verify', command: 'same', failed: true }];
  for (const failureKind of FAILURE_KINDS.filter((x) => !['reasoning', 'implementation'].includes(x))) {
    const input = route.normalize({ task: 'rename a variable', steps: [...steps, { kind: 'tool', command: 'read', failed: true, failureKind }] }, cfg);
    const d = route.heuristic(input, cfg);
    assert.equal(d.result.model, 'worker-demo'); assert.equal(d.result.effort, 'medium');
    assert.equal(route.plan(input, cfg).state.recent_steps.at(-1).failureKind, failureKind);
  }
});
test('ongoing controlled stage is settled locally even in strict Luna mode', async (t) => {
  const cfg = config(t, 'luna');
  const engine = createEngine({ config: cfg, transport: () => { throw new Error('must not call provider'); } });
  const d = await engine.decide('route', { task: 'work', control: contract({ attempts: [failure(1), failure(2)] }) });
  assert.equal(d.source, 'settled'); assert.equal(d.calls, 0); assert.equal(d.result.control.nextAction, 'raise_effort');
  const ledger = fs.readFileSync(cfg.ledger.path, 'utf8');
  assert.ok(!ledger.includes('fixture://')); assert.ok(!ledger.includes('crew-focus'));
});
test('fresh controlled route still supports Luna selection and applies evidence gate', async (t) => {
  const cfg = config(t, 'luna');
  const fake = fakeLuna({ choices: { model: { 'worker-demo': 1, 'expert-demo': 0 } }, scores: { effort: [0, 1, 0, 0, 0] } });
  const engine = createEngine({ config: cfg, transport: fake.transport });
  const c = contract(); delete c.current;
  const d = await engine.decide('route', { task: c.goal, control: c });
  assert.equal(fake.calls.length, 1); assert.equal(d.result.control.nextAction, 'execute');
  assert.deepEqual(fake.calls[0].state.outcome.acceptance, c.acceptance);
});
