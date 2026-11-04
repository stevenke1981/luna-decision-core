// End to end through the real registry and default deps: every kind, in auto mode with a fake
// Luna, in heuristic mode, and with Luna failing. Temp folders only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { KIND_MODULES } from '../src/registry.js';
import { KINDS } from '../src/defaults.js';
import { fakeLuna } from './helpers/fakeLuna.js';

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-int-'));
  const skills = path.join(dir, 'skills');
  for (const [name, description] of [['rust-testing', 'Write and run Rust unit tests with cargo test'], ['frontend-design', 'Design web pages, CSS and layout']]) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  }
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'cache.js'), 'export function evictCache(lru) {\n  // evict the least recently used cache entry\n  return lru.pop();\n}\n');
  fs.writeFileSync(path.join(repo, 'src', 'other.js'), 'export const unrelated = 1;\n');
  const config = (mode) => loadConfig({
    env: { LUNA_CORE_HOME: dir, OPENAI_API_KEY: 'sk-test-not-real' }, cwd: dir,
    overrides: { mode, skills: { dirs: [skills] } },
  });
  return { dir, repo, config, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const segments = () => Array.from({ length: 6 }, (_, i) => ({
  id: `seg${i}`, role: i === 0 ? 'system' : i % 2 ? 'tool' : 'assistant', turn: i, text: `line ${i}\n${'output '.repeat(300)}\nerror: failed ${i}`,
}));

test('the registry has a module for every kind, each with the full contract', () => {
  assert.deepEqual(Object.keys(KIND_MODULES).sort(), [...KINDS].sort());
  for (const [name, mod] of Object.entries(KIND_MODULES)) {
    assert.equal(mod.name, name);
    for (const fn of ['normalize', 'plan', 'interpret', 'heuristic', 'summarize']) assert.equal(typeof mod[fn], 'function', `${name}.${fn}`);
    assert.ok(Object.isFrozen(mod), `${name} frozen`);
  }
});

test('auto mode: every kind decides through Luna and the ledger holds no user text', async () => {
  const f = fixture();
  try {
    const fake = fakeLuna({
      predicates: (name) => ({ s0: 0.9, need_retrieval: 0.9, c0: 0.9, durable: 0.9, compact_now: 0.9 })[name] ?? 0.1,
      choices: { action: 'save_new', type: 'feedback', model: 'claude-opus-5-5' },
      scores: { effort: [0, 0.2, 0.7, 0.1, 0] },
    });
    const engine = createEngine({ config: f.config('auto'), transport: fake.transport });
    const route = await engine.route({ task: 'design a thread-safe cache' });
    assert.equal(route.source, 'luna');
    assert.ok(route.result.model && route.result.effort);

    const skills = await engine.skills({ task: 'add cargo tests for the parser' });
    assert.equal(skills.source, 'luna');
    assert.ok(skills.result.selected.length >= 1);

    const retrieve = await engine.retrieve({ query: 'how does evictCache pick the entry', root: f.repo });
    assert.equal(retrieve.source, 'luna');
    assert.equal(retrieve.result.needed, true);
    assert.ok(retrieve.result.chunks.some((c) => c.source.includes('cache.js')));

    const write = await engine.remember({ observation: 'Always run the tests before committing' });
    assert.equal(write.result.action, 'save_new');
    assert.equal(write.result.applied, true);
    const recall = await engine.recall({ query: 'should I run the tests before committing' });
    assert.ok(['luna', 'settled'].includes(recall.source));

    const compress = await engine.compress({ window: 3000, segments: segments(), goal: 'fix the failure' });
    assert.equal(compress.result.compact, true);
    assert.ok(compress.result.tokensAfter <= compress.result.tokensBefore);

    for (const call of fake.calls) assert.ok(KINDS.includes(call.state.kind));
    const ledger = fs.readFileSync(f.config('auto').ledger.path, 'utf8');
    assert.equal(ledger.trim().split('\n').length, 6);
    for (const text of ['thread-safe', 'cargo tests', 'evictCache', 'Always run', 'fix the failure']) assert.ok(!ledger.includes(text), text);
    assert.equal(engine.stats().decisions, 6);
  } finally {
    f.cleanup();
  }
});

test('a secret in any task never reaches the Luna state', async () => {
  const f = fixture();
  try {
    const fake = fakeLuna({});
    const engine = createEngine({ config: f.config('auto'), transport: fake.transport });
    await engine.skills({ task: `use rust tests, my key is ${KEY}` });
    await engine.recall({ query: `tests ${KEY}` }).catch(() => {});
    await engine.route({ task: `deploy with ${KEY}` });
    for (const call of fake.calls) assert.ok(!JSON.stringify(call.state).includes(KEY), call.state.kind);
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\n-----END RSA PRIVATE KEY-----';
    await engine.route({ task: `store this ${pem} somewhere` });
    assert.ok(!JSON.stringify(fake.calls.at(-1).state).includes('MIIEowIBAAKCAQEAxyz'));
  } finally {
    f.cleanup();
  }
});

test('heuristic mode decides every kind without a single Luna call', async () => {
  const f = fixture();
  try {
    const fake = fakeLuna({});
    const engine = createEngine({ config: f.config('heuristic'), transport: fake.transport });
    const results = [
      await engine.route({ task: 'rename a variable' }),
      await engine.skills({ task: 'use rust-testing for the parser' }),
      await engine.retrieve({ query: 'evictCache least recently used', root: f.repo }),
      await engine.remember({ observation: 'Remember: I prefer pnpm over npm' }),
      await engine.recall({ query: 'pnpm or npm' }),
      await engine.compress({ window: 3000, segments: segments() }),
    ];
    assert.equal(fake.calls.length, 0);
    for (const d of results) assert.ok(['rules', 'settled'].includes(d.source), d.kind);
    assert.deepEqual(results[1].result.selected.map((s) => s.name), ['rust-testing']);
    assert.equal(results[3].result.action, 'save_new');
    assert.equal(results[4].result.memories.length, 1);
  } finally {
    f.cleanup();
  }
});

test('auto falls back to the rules when Luna fails; strict luna mode fails loudly', async () => {
  const f = fixture();
  try {
    const down = fakeLuna({ fail: new Error('Luna HTTP 503: unavailable') });
    const auto = createEngine({ config: f.config('auto'), transport: down.transport });
    const d = await auto.route({ task: 'debug a race in the scheduler' });
    assert.equal(d.source, 'rules');
    assert.match(d.error, /503/);
    const strict = createEngine({ config: f.config('luna'), transport: down.transport });
    await assert.rejects(strict.route({ task: 'debug a race in the scheduler' }), /503/);
  } finally {
    f.cleanup();
  }
});
