import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine, buildDeps } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { verdict } from '../src/contract.js';
import { predicateProbability } from '../src/luna/answers.js';
import { USD_PER_INPUT_TOKEN } from '../src/luna/client.js';
import { LEDGER_FIELDS } from '../src/ledger.js';
import { fakeLuna } from './helpers/fakeLuna.js';

const OK = { type: 'predicate', name: 'ok', instructions: 'Is the answer right?' };
const DEPS = Object.freeze({ store: Object.freeze({ marker: 'store-marker' }), loadCatalog: () => [], repoIndex: () => ({}) });
const STUB_USD = 1000 * USD_PER_INPUT_TOKEN;

/** A temp home folder, removed afterwards. The ledger and memory default into it. */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-engine-'));
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function configFor(home, overrides = {}) {
  return loadConfig({ env: { LUNA_CORE_HOME: home }, cwd: home, overrides });
}

function readLedger(home) {
  const text = fs.readFileSync(path.join(home, 'decisions.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

/** A stub kind module: Luna answers the predicate `ok`, the rules answer `rules`. */
function stub(name, extra = {}) {
  return Object.freeze({
    name,
    normalize(input) {
      if (typeof input?.task !== 'string' || !input.task.trim()) throw new TypeError(`${name}: task must be a non-empty string`);
      return { ...input };
    },
    plan: (input) => ({ state: { task: input.task }, questions: [OK], ctx: {} }),
    interpret(answers) {
      const p = predicateProbability(answers, 'ok');
      return verdict({ value: 'luna', p }, Math.max(p, 1 - p), ['luna answered']);
    },
    heuristic: () => verdict({ value: 'rules' }, null, ['rules']),
    summarize: (r) => `${name}: ${r.value}`,
    ...extra,
  });
}

const settledPlan = () => ({ settled: verdict({ value: 'settled' }, 1, ['already known']) });

test('settled source: a plan that settles makes no Luna call', () => withHome(async (home) => {
  const fake = fakeLuna({ predicates: { ok: 0.9 } });
  const kinds = { alpha: stub('alpha', { plan: settledPlan }) };
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'settled');
  assert.deepEqual(d.result, { value: 'settled' });
  assert.equal(d.confidence, 1);
  assert.deepEqual(d.reasons, ['already known']);
  assert.equal(d.calls, 0);
  assert.equal(d.cost, null);
  assert.equal(d.tokens, null);
  assert.equal(fake.calls.length, 0);
  assert.ok(Number.isFinite(d.latencyMs) && d.latencyMs >= 0);
  assert.equal('error' in d, false);
}));

test('luna source: cost, tokens and calls come from askLuna, and state carries the kind', () => withHome(async (home) => {
  const fake = fakeLuna({ predicates: { ok: 0.95 } });
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds: { alpha: stub('alpha') } });
  const d = await engine.decide('alpha', { task: 'pick a model' });
  assert.equal(d.source, 'luna');
  assert.deepEqual(d.result, { value: 'luna', p: 0.95 });
  assert.equal(d.confidence, 0.95);
  assert.deepEqual(d.reasons, ['luna answered']);
  assert.equal(d.calls, 1);
  assert.deepEqual(d.tokens, { input: 1000, cached: 900 });
  assert.ok(Math.abs(d.cost - STUB_USD) < 1e-12);
  assert.equal(fake.calls[0].state.kind, 'alpha');
  assert.equal(fake.calls[0].state.task, 'pick a model');
}));

test('luna+rules source: the gate sees Luna and the rules and its verdict is kept', () => withHome(async (home) => {
  const gate = (luna, rules) => verdict({ value: 'gated', luna: luna.result.value, rules: rules.result.value }, 0.5, ['gated'], 'luna+rules');
  const fake = fakeLuna({ predicates: { ok: 0.9 } });
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds: { alpha: stub('alpha', { gate }) } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'luna+rules');
  assert.deepEqual(d.result, { value: 'gated', luna: 'luna', rules: 'rules' });
  assert.deepEqual(d.reasons, ['gated']);
  assert.equal(d.calls, 1);
}));

test('rules source: a gate that takes the rules over keeps the Luna call in the spend', () => withHome(async (home) => {
  const gate = (luna, rules) => verdict(rules.result, null, ['rules win'], 'rules');
  const fake = fakeLuna({ predicates: { ok: 0.9 } });
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds: { alpha: stub('alpha', { gate }) } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.deepEqual(d.result, { value: 'rules' });
  assert.equal(d.calls, 1);
  assert.equal(d.confidence, null);
}));

test('heuristic mode answers from the rules and never calls the transport or plans', () => withHome(async (home) => {
  const fake = fakeLuna({ predicates: { ok: 0.9 } });
  let plans = 0;
  const kinds = { alpha: stub('alpha', { plan: () => { plans++; throw new Error('plan must not run in heuristic mode'); } }) };
  const engine = createEngine({ config: configFor(home, { mode: 'heuristic' }), transport: fake.transport, kinds });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.deepEqual(d.result, { value: 'rules' });
  assert.equal(d.calls, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(plans, 0);
}));

test('auto fallback: a transport error falls back to the rules and records the error', () => withHome(async (home) => {
  const engine = createEngine({
    config: configFor(home),
    transport: async () => { throw new Error('Luna HTTP 503: busy'); },
    kinds: { alpha: stub('alpha') },
  });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.deepEqual(d.result, { value: 'rules' });
  assert.equal(d.error, 'Luna HTTP 503: busy');
  assert.equal(d.calls, 0);
  assert.equal(d.cost, null);
}));

test('auto fallback: a malformed answer falls back and keeps the cost of the call that returned it', () => withHome(async (home) => {
  const transport = async () => ({ answers: [], usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 0 } } });
  const engine = createEngine({ config: configFor(home), transport, kinds: { alpha: stub('alpha') } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.match(d.error, /no predicate answer for "ok"/);
  assert.equal(d.calls, 1);
  assert.ok(Math.abs(d.cost - 500 * USD_PER_INPUT_TOKEN) < 1e-12);
}));

test('auto fallback: abstaining below minConfidence falls back with the abstention as the error', () => withHome(async (home) => {
  const fake = fakeLuna({ predicates: { ok: 0.25 } });
  const engine = createEngine({ config: configFor(home, { minConfidence: 0.8 }), transport: fake.transport, kinds: { alpha: stub('alpha') } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.match(d.error, /^alpha: Luna abstained/);
  assert.equal(d.calls, 1);
}));

test('abstention only below minConfidence: equal is accepted, and a null confidence never abstains', () => withHome(async (home) => {
  const equal = fakeLuna({ predicates: { ok: 0.25 } });
  const atBoundary = createEngine({ config: configFor(home, { minConfidence: 0.75 }), transport: equal.transport, kinds: { alpha: stub('alpha') } });
  assert.equal((await atBoundary.decide('alpha', { task: 'x' })).source, 'luna');

  const nullConfidence = stub('alpha', { interpret: () => verdict({ value: 'luna' }, null, []) });
  const engine = createEngine({ config: configFor(home, { minConfidence: 0.99 }), transport: fakeLuna().transport, kinds: { alpha: nullConfidence } });
  assert.equal((await engine.decide('alpha', { task: 'x' })).source, 'luna');
}));

test('strict luna mode: a Luna failure is logged, then rethrown unchanged', () => withHome(async (home) => {
  const thrown = new Error('Luna HTTP 500: boom');
  const engine = createEngine({
    config: configFor(home, { mode: 'luna' }),
    transport: async () => { throw thrown; },
    kinds: { alpha: stub('alpha') },
  });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), (err) => err === thrown);
  const lines = readLedger(home);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'alpha');
  assert.equal(lines[0].source, null);
  assert.equal(lines[0].error, 'Luna HTTP 500: boom');
  assert.equal(lines[0].summary, null);
  assert.equal(engine.stats().errors, 1);
  assert.equal(engine.stats().decisions, 0);
}));

test('strict luna mode: an abstention fails the decision too', () => withHome(async (home) => {
  const engine = createEngine({
    config: configFor(home, { mode: 'luna', minConfidence: 0.9 }),
    transport: fakeLuna({ predicates: { ok: 0.5 } }).transport,
    kinds: { alpha: stub('alpha') },
  });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), /abstained/);
  assert.match(readLedger(home)[0].error, /abstained/);
}));

test('normalize TypeError propagates in every mode, without a Luna call', () => withHome(async (home) => {
  for (const mode of ['auto', 'luna', 'heuristic']) {
    const fake = fakeLuna({ predicates: { ok: 0.9 } });
    const engine = createEngine({ config: configFor(home, { mode }), transport: fake.transport, kinds: { alpha: stub('alpha') } });
    await assert.rejects(engine.decide('alpha', { task: '   ' }), TypeError);
    assert.equal(fake.calls.length, 0, mode);
  }
}));

test('prepare and finalize receive the deps and run in every mode', () => withHome(async (home) => {
  const seen = [];
  const kinds = {
    alpha: stub('alpha', {
      async prepare(input, cfg, deps) {
        seen.push(deps);
        return { ...input, marker: deps.store.marker };
      },
      async finalize(v, input, cfg, deps) {
        seen.push(deps);
        return { ...v, result: { ...v.result, marker: input.marker, finalized: true } };
      },
    }),
  };
  const fake = fakeLuna({ predicates: { ok: 0.9 } });
  for (const mode of ['auto', 'heuristic']) {
    const engine = createEngine({ config: configFor(home, { mode }), transport: fake.transport, kinds, deps: DEPS });
    const d = await engine.decide('alpha', { task: 'x' });
    assert.equal(d.result.marker, 'store-marker', mode);
    assert.equal(d.result.finalized, true, mode);
  }
  assert.equal(fake.calls.length, 1);
  assert.equal(seen.length, 4);
  assert.ok(seen.every((deps) => deps === DEPS));
}));

test('a prepare failure propagates without a Luna call or a fallback', () => withHome(async (home) => {
  const fake = fakeLuna({ predicates: { ok: 0.9 } });
  const kinds = { alpha: stub('alpha', { prepare: async () => { throw new Error('index unreadable'); } }) };
  const engine = createEngine({ config: configFor(home), transport: fake.transport, kinds, deps: DEPS });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), /index unreadable/);
  assert.equal(fake.calls.length, 0);
}));

test('unknown kind is a TypeError, from decide and from a shortcut whose kind is not injected', () => withHome(async (home) => {
  const engine = createEngine({ config: configFor(home, { mode: 'heuristic' }), kinds: { alpha: stub('alpha') } });
  await assert.rejects(engine.decide('nope', { task: 'x' }), (err) => err instanceof TypeError && /unknown kind/.test(err.message));
  await assert.rejects(engine.compress({ task: 'x' }), TypeError);
}));

test('stats count decisions, calls, cost and fallbacks by kind, and return a copy', () => withHome(async (home) => {
  let failNext = false;
  const fake = fakeLuna({ predicates: { ok: 0.95 } });
  const send = (...args) => {
    if (failNext) {
      failNext = false;
      throw new Error('Luna HTTP 503: busy');
    }
    return fake.transport(...args);
  };
  const kinds = {
    alpha: stub('alpha'),
    beta: stub('beta', { plan: settledPlan }),
  };
  const engine = createEngine({ config: configFor(home), transport: send, kinds });
  await engine.decide('alpha', { task: 'one' });
  await engine.decide('beta', { task: 'two' });
  failNext = true;
  await engine.decide('alpha', { task: 'three' });
  await engine.decide('alpha', { task: 'four' });

  const s = engine.stats();
  assert.equal(s.decisions, 4);
  assert.equal(s.lunaCalls, 2);
  assert.equal(s.errors, 1);
  assert.equal(s.fallbacks, 1);
  assert.ok(Math.abs(s.cost - 2 * STUB_USD) < 1e-12);
  assert.deepEqual(s.byKind.alpha, { decisions: 3, luna: 2, rules: 1, settled: 0, fallbacks: 1 });
  assert.deepEqual(s.byKind.beta, { decisions: 1, luna: 0, rules: 0, settled: 1, fallbacks: 0 });

  s.decisions = 99;
  s.byKind.alpha.luna = 99;
  const again = engine.stats();
  assert.equal(again.decisions, 4);
  assert.equal(again.byKind.alpha.luna, 2);
}));

test('batching respects luna.maxQuestionsPerCall and the decision reports every call', () => withHome(async (home) => {
  const questions = ['q0', 'q1', 'q2', 'q3', 'q4'].map((name) => ({ type: 'predicate', name, instructions: `Is ${name}?` }));
  const kinds = {
    alpha: stub('alpha', {
      plan: (input) => ({ state: { task: input.task }, questions, ctx: {} }),
      interpret: (answers) => verdict({ answered: Object.keys(answers).length }, 0.9, []),
    }),
  };
  const fake = fakeLuna({ predicates: { q0: 0.9 } });
  const engine = createEngine({ config: configFor(home, { luna: { maxQuestionsPerCall: 2 } }), transport: fake.transport, kinds });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.deepEqual(fake.calls.map((c) => c.questions.length), [2, 2, 1]);
  assert.equal(d.calls, 3);
  assert.equal(d.result.answered, 5);
  assert.equal(d.tokens.input, 3000);
}));

test('a gate that returns an unknown source fails the decision (a kind bug, not a fallback)', () => withHome(async (home) => {
  const gate = () => verdict({ value: 'x' }, 0.5, [], 'bogus');
  const engine = createEngine({ config: configFor(home), transport: fakeLuna({ predicates: { ok: 0.9 } }).transport, kinds: { alpha: stub('alpha', { gate }) } });
  await assert.rejects(engine.decide('alpha', { task: 'x' }), /invalid source "bogus"/);
}));

test('the ledger line carries the summary and no input text', () => withHome(async (home) => {
  const engine = createEngine({
    config: configFor(home),
    transport: fakeLuna({ predicates: { ok: 0.9 } }).transport,
    kinds: { alpha: stub('alpha') },
  });
  await engine.decide('alpha', { task: 'PRIVATE-TASK-TEXT-42' });
  const raw = fs.readFileSync(path.join(home, 'decisions.jsonl'), 'utf8');
  assert.equal(raw.includes('PRIVATE'), false);
  const [line] = readLedger(home);
  assert.deepEqual(Object.keys(line).sort(), ['ts', ...LEDGER_FIELDS].sort());
  assert.equal(line.summary, 'alpha: luna');
  assert.equal(line.source, 'luna');
  assert.equal(line.calls, 1);
}));

test('a disabled ledger writes nothing', () => withHome(async (home) => {
  const engine = createEngine({
    config: configFor(home, { mode: 'heuristic', ledger: { enabled: false } }),
    kinds: { alpha: stub('alpha') },
  });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'rules');
  assert.equal(fs.existsSync(path.join(home, 'decisions.jsonl')), false);
}));

test('the shortcuts dispatch to their kinds', () => withHome(async (home) => {
  const names = ['route', 'skills', 'retrieve', 'memory_recall', 'memory_write', 'compress'];
  const kinds = Object.fromEntries(names.map((name) => [name, stub(name)]));
  const engine = createEngine({ config: configFor(home, { mode: 'heuristic' }), kinds });
  const shortcuts = { route: 'route', skills: 'skills', retrieve: 'retrieve', recall: 'memory_recall', remember: 'memory_write', compress: 'compress' };
  for (const [method, kind] of Object.entries(shortcuts)) {
    assert.equal((await engine[method]({ task: 'x' })).kind, kind, method);
  }
}));

test('a kind without prepare or finalize needs no deps, so none are loaded', () => withHome(async (home) => {
  const engine = createEngine({ config: configFor(home), transport: fakeLuna({ predicates: { ok: 0.9 } }).transport, kinds: { alpha: stub('alpha') } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'luna');
}));

test('a gate verdict without a source keeps the luna source', () => withHome(async (home) => {
  const gate = (luna) => verdict(luna.result, luna.confidence, ['kept']);
  const engine = createEngine({ config: configFor(home), transport: fakeLuna({ predicates: { ok: 0.9 } }).transport, kinds: { alpha: stub('alpha', { gate }) } });
  const d = await engine.decide('alpha', { task: 'x' });
  assert.equal(d.source, 'luna');
  assert.deepEqual(d.reasons, ['kept']);
}));

test('default deps create the store on first use and cache catalogs by dirs and indexes by resolved root', () => withHome(async (home) => {
  const made = { stores: [], catalogs: 0, indexes: 0 };
  const factories = {
    createMemoryStore: (file) => { made.stores.push(file); return { file }; },
    loadCatalog: (dirs) => { made.catalogs++; return dirs.map((d) => ({ name: d })); },
    createRepoIndex: (root) => { made.indexes++; return { root }; },
  };
  const config = configFor(home);
  const deps = buildDeps(config, factories, {});
  assert.deepEqual(made.stores, [], 'no store before first use');
  assert.equal(deps.store, deps.store);
  assert.deepEqual(made.stores, [config.memory.path]);

  assert.equal(deps.loadCatalog(['a', 'b']), deps.loadCatalog(['a', 'b']));
  deps.loadCatalog(['a']);
  assert.equal(made.catalogs, 2);

  assert.equal(deps.repoIndex(path.join(home, 'sub', '..')), deps.repoIndex(home));
  assert.equal(made.indexes, 1);
  assert.equal(made.stores.length, 1);
}));

test('injected deps win over the factories', () => withHome(async (home) => {
  const injectedStore = { search: () => [] };
  const factories = {
    createMemoryStore: () => { throw new Error('must not create a store'); },
    loadCatalog: () => { throw new Error('must not load a catalog'); },
    createRepoIndex: () => { throw new Error('must not index'); },
  };
  const loadCatalog = () => [{ name: 'injected' }];
  const deps = buildDeps(configFor(home), factories, { store: injectedStore, loadCatalog });
  assert.equal(deps.store, injectedStore);
  assert.equal(deps.loadCatalog, loadCatalog);
  assert.equal(typeof deps.repoIndex, 'function');
}));

test('createEngine requires a config', () => {
  assert.throws(() => createEngine({ kinds: {} }), (err) => err instanceof TypeError && /config is required/.test(err.message));
});
