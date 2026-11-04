import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createEngine } from '../src/engine.js';
import { fakeLuna } from './helpers/fakeLuna.js';

const task = '請建立分支並提交修正';
const catalog = [
  { name: 'git-workflow', description: 'Manage Git branches, commits and pull requests' },
  { name: 'photo-editing', description: 'Edit photographs, adjust contrast and crop images' },
];

async function withEngine(overrides, transport, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-semantic-'));
  try {
    const config = loadConfig({ cwd: home, env: { LUNA_CORE_HOME: home },
      overrides: { ...overrides, ledger: { enabled: false } } });
    await run(createEngine({ config, transport }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('semantic fallback is opt-in: the default still settles when words do not overlap', async () => {
  const fake = fakeLuna();
  await withEngine({}, fake.transport, async (engine) => {
    const decision = await engine.skills({ task, catalog });
    assert.equal(decision.source, 'settled');
    assert.equal(decision.result.considered, 0);
    assert.equal(fake.calls.length, 0);
  });
});

test('opt-in sends an English catalog for a Chinese task to the model without lexical hits', async () => {
  const fake = fakeLuna({ predicates: { s0: 0.95, s1: 0.1 } });
  await withEngine({ skills: { semanticFallback: true } }, fake.transport, async (engine) => {
    const decision = await engine.skills({ task, catalog });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].state.task, task);
    assert.deepEqual(fake.calls[0].state.skills.map((skill) => skill.name), catalog.map((skill) => skill.name));
    assert.deepEqual(decision.result.selected.map((skill) => skill.name), ['git-workflow']);
    assert.equal(decision.source, 'luna');
    assert.match(decision.reasons[0], /considered first 2 of 2/);
  });
});

test('semantic candidates are bounded and report when only part of the catalog was considered', async () => {
  const fake = fakeLuna({ predicates: { s0: 0.9 } });
  await withEngine({ skills: { semanticFallback: true, shortlist: 1 } }, fake.transport, async (engine) => {
    const decision = await engine.skills({ task, catalog });
    assert.equal(fake.calls[0].questions.length, 1);
    assert.equal(decision.result.considered, 1);
    assert.match(decision.reasons[0], /first 1 of 2/);
  });
});

test('heuristic mode and a failed model never manufacture semantic relevance', async () => {
  for (const mode of ['heuristic', 'auto']) {
    const fake = fakeLuna({ fail: new Error('provider unavailable') });
    await withEngine({ mode, skills: { semanticFallback: true } }, fake.transport, async (engine) => {
      const decision = await engine.skills({ task, catalog });
      assert.equal(decision.source, 'rules');
      assert.deepEqual(decision.result.selected, []);
      assert.equal(fake.calls.length, mode === 'heuristic' ? 0 : 1);
    });
  }
});

test('semantic fallback does not add calls for an empty catalog or an explicitly named skill', async () => {
  const fake = fakeLuna();
  await withEngine({ skills: { semanticFallback: true } }, fake.transport, async (engine) => {
    const empty = await engine.skills({ task, catalog: [] });
    assert.equal(empty.source, 'settled');
    const forced = await engine.skills({ task: '請使用 /git-workflow', catalog });
    assert.equal(forced.source, 'settled');
    assert.deepEqual(forced.result.selected.map((skill) => skill.name), ['git-workflow']);
    assert.equal(fake.calls.length, 0);
  });
});

test('semantic fallback requires a boolean setting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-semantic-'));
  try {
    assert.throws(() => loadConfig({ cwd: home, env: { LUNA_CORE_HOME: home },
      overrides: { skills: { semanticFallback: 'true' } } }), /skills.semanticFallback must be true or false/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
