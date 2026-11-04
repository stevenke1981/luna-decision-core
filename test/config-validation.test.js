import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createEngine } from '../src/engine.js';

async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-config-'));
  try {
    return await run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const load = (home, overrides) => loadConfig({ cwd: home, env: { LUNA_CORE_HOME: home }, overrides });

test('a misspelled config field fails before a default silently takes its place', () => withHome((home) => {
  fs.writeFileSync(path.join(home, 'luna-core.config.json'), JSON.stringify({ luna: { timeotMs: 900 } }));
  assert.throws(() => load(home), /unknown field "luna.timeotMs".*timeoutMs/);
  assert.deepEqual(fs.readdirSync(home), ['luna-core.config.json']);
}));

test('unknown fields and non-object sections are rejected in programmatic overrides', () => withHome((home) => {
  assert.throws(() => load(home, { minimumConfidence: 0.7 }), /unknown field "minimumConfidence"/);
  for (const section of ['luna', 'route', 'skills', 'retrieve', 'memory', 'compress', 'ledger', 'server']) {
    for (const value of [null, [], 'invalid', false]) {
      assert.throws(() => load(home, { [section]: value }), new RegExp(`${section} must be an object`));
    }
  }
  assert.throws(() => load(home, 'invalid'), /overrides must be an object/);
}));

test('prototype keys are rejected in programmatic overrides before merging', () => withHome((home) => {
  const bad = JSON.parse('{"luna":{"__proto__":{"polluted":true}}}');
  assert.throws(() => load(home, bad), /"__proto__" is not allowed/);
  assert.equal({}.polluted, undefined);
}));

test('invalid context headroom cannot admit a request larger than the model window', () => withHome((home) => {
  for (const contextHeadroom of [0, -1, 0.5, '1.2', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => load(home, { route: { contextHeadroom } }), /route.contextHeadroom.*>= 1/);
  }
  const config = load(home, { mode: 'heuristic', route: { contextHeadroom: 1 }, ledger: { enabled: false } });
  const engine = createEngine({ config });
  return assert.rejects(engine.route({ task: 'rename a variable', contextTokens: 10_000_000 }), /no eligible model/);
}));

test('decision model and API batching limits fail during configuration loading', () => withHome((home) => {
  for (const model of ['', '  ', null, 7, ' gpt-6-luna ']) {
    assert.throws(() => load(home, { luna: { model } }), /luna.model must be/);
  }
  for (const maxQuestionsPerCall of [0, -1, 1.5, 401, Number.NaN]) {
    assert.throws(() => load(home, { luna: { maxQuestionsPerCall } }), /luna.maxQuestionsPerCall.*1 to 400/);
  }
  assert.equal(load(home, { luna: { maxQuestionsPerCall: 400 } }).luna.maxQuestionsPerCall, 400);
  assert.throws(() => load(home, { luna: { timeoutMs: 2_147_483_648 } }), /luna.timeoutMs must be an integer/);
}));

test('malformed folders and file filters fail before catalog loading or indexing', () => withHome((home) => {
  for (const dirs of ['C:/Skills', [null], [''], ['   '], ['folder\0name']]) {
    assert.throws(() => load(home, { skills: { dirs } }), /skills.dirs/);
  }
  for (const extensions of ['.js', ['js'], [null], ['']]) {
    assert.throws(() => load(home, { retrieve: { extensions } }), /retrieve.extensions/);
  }
  assert.throws(() => load(home, { retrieve: { ignoreDirs: 'node_modules' } }), /retrieve.ignoreDirs/);
  assert.deepEqual(load(home, { skills: { dirs: [] }, retrieve: { extensions: [], ignoreDirs: [] } }).skills.dirs, []);
}));

test('retrieval sizes, overlap and memory limits require useful integer values', () => withHome((home) => {
  for (const field of ['maxFileBytes', 'maxFiles', 'excerptChars']) {
    for (const value of [0, -1, 0.5, '100']) {
      assert.throws(() => load(home, { retrieve: { [field]: value } }), /retrieve: maxFileBytes, maxFiles and excerptChars/);
    }
  }
  assert.throws(() => load(home, { retrieve: { chunkOverlap: 0.5 } }), /chunkOverlap must be a non-negative integer/);
  for (const field of ['shortlist', 'maxRecall']) {
    for (const value of [0, -5, 1.5, '5']) {
      assert.throws(() => load(home, { memory: { [field]: value } }), /memory.shortlist and memory.maxRecall/);
    }
  }
}));

test('false and zero paths are rejected instead of silently becoming default paths', () => withHome((home) => {
  for (const section of ['memory', 'ledger']) {
    for (const value of [false, 0, [], {}, null, '   ']) {
      assert.throws(() => load(home, { [section]: { path: value } }), new RegExp(`${section}.path must be a path string`));
    }
    assert.ok(load(home, { [section]: { path: '' } })[section].path.startsWith(home));
  }
  for (const enabled of ['false', 0, null]) {
    assert.throws(() => load(home, { ledger: { enabled } }), /ledger.enabled must be true or false/);
  }
  assert.throws(() => load(home, { server: { host: '' } }), /server.host must be a non-empty host string/);
}));

test('model typos, empty identifiers, and duplicate efforts are diagnosed at setup', () => withHome((home) => {
  const base = { id: 'worker', tier: 1, contextWindow: 1000, efforts: ['low', 'high'] };
  assert.throws(() => load(home, { route: { models: [{ ...base, contextWindows: 2000 }] } }), /route.models: unknown field/);
  assert.throws(() => load(home, { route: { models: [{ ...base, id: ' ' }] } }), /missing, untrimmed or duplicate id/);
  assert.throws(() => load(home, { route: { models: [{ ...base, efforts: ['low', 'low'] }] } }), /without repeats/);
  const config = load(home, { route: { models: [base] } });
  assert.deepEqual(config.route.models[0].capabilities, []);
  assert.equal(config.route.models[0].local, false);
}));
