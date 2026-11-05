// Synthetic, offline fixtures. No actual Crew/Night Lamp work, agent, or provider is run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../../src/engine.js';
import { loadConfig } from '../../src/config.js';

export const models = [
  { id: 'worker-demo', tier: 1, contextWindow: 200000, capabilities: ['tools'], local: true, efforts: ['low', 'medium', 'high'], strengths: 'offline fixture, not a provider model' },
  { id: 'expert-demo', tier: 2, contextWindow: 200000, capabilities: ['tools'], local: true, efforts: ['low', 'high'], strengths: 'offline fixture, not a provider model' },
];
export const contract = (extra = {}) => ({
  taskId: 'crew-focus', revision: 'fixture-v1', goal: 'Add opt-in focus following without interrupting typing.',
  acceptance: ['focus-tests', 'manual-typing-check'],
  constraints: ['Keep focus following off by default.', 'Preserve manual focus control.'],
  current: { model: 'worker-demo', effort: 'medium' }, ...extra,
});
export const failure = (n, extra = {}) => ({
  id: `attempt-${n}`, taskId: 'crew-focus', model: 'worker-demo', effort: 'medium',
  outcome: 'fail', failureKind: 'implementation', source: 'test',
  evidenceRef: `fixture://test-run-${n}`, fingerprint: 'focus-race', hypothesis: `hypothesis-${n}`, ...extra,
});
export const cases = [
  { key: '01-goal', expected: 'execute', control: contract() },
  { key: '02-context', expected: 'gather_context', control: contract({
    contextBudgetTokens: 500, context: [
      { id: 'current-focus-code', source: 'src/focus.rs@old', tokens: 200, required: true, stale: true },
      { id: 'unrelated-history', source: 'archive.md', tokens: 900 },
    ],
  }) },
  { key: '03-reasoning', expected: 'raise_effort', control: contract({ attempts: [failure(1), failure(2)] }) },
  { key: '04-tools', expected: 'repair_tools', control: contract({
    goal: 'Verify a Night Lamp media export.', requiredTools: ['ffprobe'], availableTools: ['git'],
  }) },
  { key: '05-team', expected: 'execute', control: contract({
    maxParallel: 2, tasks: [
      { id: 'core', writes: ['src/focus.rs'] }, { id: 'docs', writes: ['docs/focus.md'] },
      { id: 'integrate', dependsOn: ['core', 'docs'], writes: ['src'] },
    ],
  }) },
  { key: '06-verification', expected: 'complete', control: contract({ evidence: [
    { criterion: 'focus-tests', revision: 'fixture-v1', status: 'pass', source: 'test', reference: 'fixture://tests-pass' },
    { criterion: 'manual-typing-check', revision: 'fixture-v1', status: 'pass', source: 'human', reference: 'fixture://manual-pass' },
  ] }) },
  { key: '07-feedback', expected: 'change_strategy', control: contract({ attempts: [
    failure(1, { hypothesis: 'increase-delay' }), failure(2, { hypothesis: 'increase-delay' }),
  ] }) },
];

export async function runExamples() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-capability-examples-'));
  try {
    const config = loadConfig({ cwd: home, env: { LUNA_CORE_HOME: home }, overrides: {
      mode: 'heuristic', ledger: { enabled: false }, route: { models },
    } });
    const engine = createEngine({ config, transport: async () => { throw new Error('Offline example attempted a network call'); } });
    const rows = [];
    for (const item of cases) {
      const d = await engine.decide('route', { task: item.control.goal, control: item.control });
      const c = d.result.control;
      assert.equal(c.nextAction, item.expected, item.key);
      assert.equal(d.calls, 0);
      if (item.key === '03-reasoning') assert.equal(c.effort, 'high');
      if (item.key === '05-team') assert.deepEqual(c.parallel.ready, ['core', 'docs']);
      rows.push({ example: item.key, action: c.nextAction, model: c.model, effort: c.effort, calls: d.calls });
    }
    return rows;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ synthetic: true, providerCalls: 0, results: await runExamples() }, null, 2));
}
