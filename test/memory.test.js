import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, lunaOptions } from '../src/config.js';
import { askLuna } from '../src/luna/client.js';
import { answersByName } from '../src/luna/answers.js';
import { createMemoryStore } from '../src/memory/store.js';
import { memoryRecall, memoryWrite, guessType, REMEMBER } from '../src/domains/memory.js';
import { MEMORY_TYPES } from '../src/defaults.js';
import { similarity } from '../src/text.js';
import { fakeLuna, choice, predicate } from './helpers/fakeLuna.js';

const FIXED = new Date('2026-01-02T03:04:05.000Z');
const PNPM_RULE = 'always use pnpm for package installs in this repo';
// Distinct, non-stop latin words: a text of n of them against a text of the same n plus one
// more word has Jaccard similarity exactly n / (n + 1), which pins the threshold boundaries.
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform',
  'victor', 'whiskey', 'xray', 'yankee', 'zulu'];
const ALREADY_STORED_SIMILARITY = 0.95;
const DUPLICATE_SIMILARITY = 0.8;

/** A config over a fresh home folder, a store on it, and the deps the kinds need. */
async function withWorld(overrides, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-memory-'));
  try {
    const cfg = loadConfig({ env: { LUNA_CORE_HOME: dir }, cwd: dir, overrides });
    const store = createMemoryStore(path.join(dir, 'memory.jsonl'), { now: () => FIXED });
    return await fn({ cfg, store, deps: { store } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** normalize, then prepare: the input a kind plans and decides on. */
async function prepared(kind, input, cfg, deps) {
  return kind.prepare(kind.normalize(input, cfg), cfg, deps);
}

/** Asks the plan's questions through fakeLuna, the way the engine does; answers by name. */
async function askFake(kind, plan, cfg, fake) {
  const body = await askLuna(lunaOptions(cfg), { kind: kind.name, ...plan.state }, plan.questions, fake.transport);
  return answersByName(body);
}

const byName = (questions) => Object.fromEntries(questions.map((q) => [q.name, q]));

test('guessType: URL → reference, deadlines → project, always/never → feedback, else user (EN and 中文)', () => {
  assert.equal(guessType('Design doc at https://example.com/spec'), 'reference');
  assert.equal(guessType('The release deadline is Friday'), 'project');
  assert.equal(guessType('Always run the linter before commit'), 'feedback');
  assert.equal(guessType('Never force-push to main'), 'feedback');
  assert.equal(guessType('這個專案的截止日是十二月'), 'project');
  assert.equal(guessType('不要自動提交'), 'feedback');
  assert.equal(guessType('我偏好繁體中文回覆'), 'user');
  assert.equal(guessType(undefined), 'user');
});

test('REMEMBER matches remember-style wording in English and 中文, and not plain statements', () => {
  const keep = ['Remember that the API is v2', 'Prefer pnpm over npm', "Don't commit .env", 'From now on, answer briefly',
    '記住：用 pnpm', '以後都寫測試', '總是先跑測試', '不要改 vendor', '我偏好 vim', '習慣用 zsh'];
  for (const s of keep) assert.ok(REMEMBER.test(s), s);
  for (const s of ['The build failed with exit code 1', '這個函式回傳陣列']) assert.ok(!REMEMBER.test(s), s);
});

test('memory_recall normalize trims the query, defaults limit to maxRecall, and rejects bad input', async () => {
  await withWorld({}, ({ cfg }) => {
    const input = { query: '  pnpm install  ' };
    assert.deepEqual(memoryRecall.normalize(input, cfg), { query: 'pnpm install', limit: cfg.memory.maxRecall });
    assert.deepEqual(input, { query: '  pnpm install  ' });
    assert.throws(() => memoryRecall.normalize({ query: ' ' }, cfg), /query must be a non-empty string/);
    assert.throws(() => memoryRecall.normalize({ query: 'x', limit: 0 }, cfg), /limit must be a positive integer/);
    assert.throws(() => memoryRecall.normalize(null, cfg), TypeError);
  });
});

test('memory_recall settles without a Luna call when no stored memory matches', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const input = await prepared(memoryRecall, { query: 'pnpm install' }, cfg, deps);
    const plan = memoryRecall.plan(input, cfg);
    assert.deepEqual(plan.settled.result, { memories: [], considered: 0 });
    assert.equal(plan.settled.confidence, null);
    assert.equal(plan.state, undefined);
  });
});

test('memory_recall asks one predicate per memory and excerpts long memory text to 400 characters', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    store.add({ type: 'project', text: `pnpm workspace ${'detail '.repeat(200)}` });
    const plan = memoryRecall.plan(await prepared(memoryRecall, { query: 'pnpm workspace' }, cfg, deps), cfg);
    assert.equal(plan.state.query, 'pnpm workspace');
    assert.deepEqual(plan.questions.map((q) => [q.name, q.type]), [['m0', 'predicate']]);
    assert.ok(plan.state.memories[0].text.length <= 400);
    assert.equal(plan.state.memories[0].id, 'm0');
  });
});

test('memory_recall keeps the memories at or above recallThreshold, most probable first, capped at limit', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    const probs = { 'pnpm install rules': 0.9, 'pnpm workspace layout': 0.3, 'pnpm lockfile policy': 0.7, 'pnpm cache location': 0.6 };
    for (const text of Object.keys(probs)) store.add({ type: 'project', text });
    const input = await prepared(memoryRecall, { query: 'pnpm install', limit: 2 }, cfg, deps);
    const plan = memoryRecall.plan(input, cfg);
    const fake = fakeLuna({ predicates: (name, state) => probs[state.memories.find((m) => m.id === name).text] });
    const v = memoryRecall.interpret(await askFake(memoryRecall, plan, cfg, fake), plan.ctx, cfg);
    assert.deepEqual(v.result.memories.map((m) => [m.text, m.probability]), [['pnpm install rules', 0.9], ['pnpm lockfile policy', 0.7]]);
    assert.equal(v.result.considered, 4);
    assert.ok(Math.abs(v.confidence - (0.9 + 0.7 + 0.7 + 0.6) / 4) < 1e-9);
  });
});

test('memory_recall reports no memory when every probability is under the threshold', async () => {
  await withWorld({ memory: { recallThreshold: 0.8 } }, async ({ cfg, store, deps }) => {
    store.add({ type: 'project', text: 'pnpm install rules' });
    const plan = memoryRecall.plan(await prepared(memoryRecall, { query: 'pnpm install' }, cfg, deps), cfg);
    const v = memoryRecall.interpret(await askFake(memoryRecall, plan, cfg, fakeLuna({ predicates: { m0: 0.6 } })), plan.ctx, cfg);
    assert.deepEqual(v.result, { memories: [], considered: 1 });
    assert.deepEqual(v.reasons, ['no memory reached the recall threshold']);
  });
});

test('memory_recall throws on a refused answer, so the engine can fall back', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    store.add({ type: 'project', text: 'pnpm install rules' });
    const plan = memoryRecall.plan(await prepared(memoryRecall, { query: 'pnpm install' }, cfg, deps), cfg);
    const answers = await askFake(memoryRecall, plan, cfg, fakeLuna({ refuse: ['m0'] }));
    assert.throws(() => memoryRecall.interpret(answers, plan.ctx, cfg), /refused "m0"/);
  });
});

test('memory_recall heuristic keeps memories scoring at least half the top score, capped at limit', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    store.add({ type: 'project', text: 'release checklist for the release branch' });
    store.add({ type: 'user', text: 'release notes style' });
    store.add({ type: 'user', text: 'tea preferences' });
    const input = await prepared(memoryRecall, { query: 'release' }, cfg, deps);
    const hits = store.search('release', 10);
    const expected = hits.filter((h) => h.score >= 0.5 * hits[0].score).map((h) => h.id);
    const r = memoryRecall.heuristic(input, cfg).result;
    assert.deepEqual(r.memories.map((m) => m.id), expected);
    assert.equal(r.considered, 2);
    assert.ok(r.memories.every((m) => m.probability === null));
    const one = memoryRecall.heuristic({ ...input, limit: 1 }, cfg).result;
    assert.deepEqual(one.memories.map((m) => m.id), [hits[0].id]);
    const none = await prepared(memoryRecall, { query: 'zebra' }, cfg, deps);
    assert.deepEqual(memoryRecall.heuristic(none, cfg).result, { memories: [], considered: 0 });
  });
});

test('memory_recall summarize gives a short count line', () => {
  assert.equal(memoryRecall.summarize({ memories: [{}, {}], considered: 5 }), '2 of 5 memories');
});

test('memory_write normalize defaults source and dryRun, and validates source, type, dryRun and observation', async () => {
  await withWorld({}, ({ cfg }) => {
    assert.deepEqual(memoryWrite.normalize({ observation: ' Use pnpm ' }, cfg),
      { observation: 'Use pnpm', source: 'user', type: null, dryRun: false });
    assert.deepEqual(memoryWrite.normalize({ observation: 'x', source: 'tool', type: 'reference', dryRun: true }, cfg),
      { observation: 'x', source: 'tool', type: 'reference', dryRun: true });
    assert.throws(() => memoryWrite.normalize({ observation: 'x', source: 'web' }, cfg), /source must be/);
    assert.throws(() => memoryWrite.normalize({ observation: 'x', type: 'secret' }, cfg), /type must be/);
    assert.throws(() => memoryWrite.normalize({ observation: 'x', dryRun: 'yes' }, cfg), /dryRun must be a boolean/);
    assert.throws(() => memoryWrite.normalize({ observation: '' }, cfg), /observation must be a non-empty string/);
  });
});

test('memory_write settles a secret as skip: no state, no similar search, and the secret in no result or reason', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    for (const observation of ['remember password: hunter2hunter2 for staging', 'remember key sk-abcdefghijklmnopqrstuvwx']) {
      const input = await prepared(memoryWrite, { observation }, cfg, deps);
      assert.deepEqual(input.similar, []);
      const plan = memoryWrite.plan(input, cfg);
      assert.equal(plan.state, undefined);
      assert.equal(plan.settled.result.action, 'skip');
      assert.equal(plan.settled.result.text, null);
      assert.deepEqual(plan.settled.reasons, ['looks like a secret; not stored']);
      assert.ok(!JSON.stringify(plan.settled).includes('hunter2') && !JSON.stringify(plan.settled).includes('sk-abc'));
      const heuristic = memoryWrite.heuristic(input, cfg);
      assert.equal(heuristic.result.action, 'skip');
      assert.ok(!JSON.stringify(heuristic).includes('hunter2') && !JSON.stringify(heuristic).includes('sk-abc'));
    }
    assert.deepEqual(store.list(), []);
  });
});

test('memory_write settles a near-identical observation (similarity at least 0.95) as skip, already stored', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    const rec = store.add({ type: 'feedback', text: 'always use pnpm' });
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation: 'Always use pnpm' }, cfg, deps), cfg);
    assert.equal(plan.settled.result.action, 'skip');
    assert.equal(plan.settled.result.targetId, null);
    assert.deepEqual(plan.settled.reasons, [`already stored as ${rec.id}`]);
    assert.equal(store.list().length, 1);
  });
});

test('memory_write without similar memories offers save_new and skip only, asks type and durable, and sends only the observation fields', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation: 'Ship the v2 release on Friday' }, cfg, deps), cfg);
    const q = byName(plan.questions);
    assert.deepEqual(q.action.choices.map((c) => c.value), ['save_new', 'skip']);
    assert.deepEqual(q.type.choices.map((c) => c.value), MEMORY_TYPES);
    assert.ok(q.durable);
    assert.equal(q.target, undefined);
    assert.deepEqual(plan.state.similar, []);
    assert.deepEqual(Object.keys(plan.state).sort(), ['observation', 'similar', 'source']);
  });
});

test('memory_write drops the type question when the caller gives a type', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation: 'Ship the v2 release on Friday', type: 'reference' }, cfg, deps), cfg);
    assert.equal(byName(plan.questions).type, undefined);
    const fake = fakeLuna({ predicates: { durable: 0.9 }, choices: { action: 'save_new' } });
    const v = memoryWrite.interpret(await askFake(memoryWrite, plan, cfg, fake), plan.ctx, cfg);
    assert.equal(v.result.type, 'reference');
  });
});

test('memory_write excerpts the observation to 1000 characters and each similar text to 400', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    store.add({ type: 'project', text: `pnpm rules and the detail notes ${'detail '.repeat(300)}` });
    const observation = `pnpm rules ${'detail '.repeat(200)}`;
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation }, cfg, deps), cfg);
    assert.ok(plan.state.observation.length <= 1000);
    assert.ok(plan.state.similar[0].text.length <= 400);
  });
});

test('memory_write asks the target only with two or more similar memories; update is offered with one', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    const observation = 'release deadline moved to March 10 for the v2 launch';
    store.add({ type: 'project', text: 'release deadline is March 3 for the v2 launch' });
    const one = memoryWrite.plan(await prepared(memoryWrite, { observation }, cfg, deps), cfg);
    assert.equal(byName(one.questions).target, undefined);
    assert.ok(byName(one.questions).action.choices.some((c) => c.value === 'update'));
    store.add({ type: 'project', text: 'v2 launch checklist and release notes' });
    const two = await prepared(memoryWrite, { observation }, cfg, deps);
    const plan = memoryWrite.plan(two, cfg);
    assert.deepEqual(byName(plan.questions).target.choices.map((c) => c.value), ['m0', 'm1']);
    const fake = fakeLuna({ predicates: { durable: 0.9 }, choices: { action: 'update', type: 'project', target: 'm1' } });
    const v = memoryWrite.interpret(await askFake(memoryWrite, plan, cfg, fake), plan.ctx, cfg);
    assert.equal(v.result.targetId, two.similar[1].id);
  });
});

test('memory_write skips a non-durable observation even when Luna asks to save it', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation: 'Build is green at commit abc123 right now' }, cfg, deps), cfg);
    const fake = fakeLuna({ predicates: { durable: 0.1 }, choices: { action: 'save_new', type: 'user' } });
    const v = memoryWrite.interpret(await askFake(memoryWrite, plan, cfg, fake), plan.ctx, cfg);
    assert.equal(v.result.action, 'skip');
    assert.equal(v.result.targetId, null);
    assert.ok(v.reasons.some((r) => /not durable/.test(r)));
  });
});

test('memory_write update applies the single similar memory, with the type and the confidence Luna gives', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    const rec = store.add({ type: 'user', text: PNPM_RULE });
    const observation = `${PNPM_RULE} now`;
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation }, cfg, deps), cfg);
    const fake = fakeLuna({ predicates: { durable: 0.9 }, choices: { action: 'update', type: 'feedback' } });
    const v = memoryWrite.interpret(await askFake(memoryWrite, plan, cfg, fake), plan.ctx, cfg);
    assert.deepEqual([v.result.action, v.result.targetId, v.result.type], ['update', rec.id, 'feedback']);
    assert.equal(v.result.text, observation);
    assert.ok(Math.abs(v.confidence - 0.9) < 1e-9);
  });
});

test('memory_write rejects an update answer when no similar memory was asked', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation: 'Ship the v2 release on Friday' }, cfg, deps), cfg);
    const answers = answersByName({ answers: [choice('action', { update: 0.9, skip: 0.1 }), predicate('durable', 0.9), choice('type', { user: 1, feedback: 0, project: 0, reference: 0 })] });
    assert.throws(() => memoryWrite.interpret(answers, plan.ctx, cfg), /unknown choice/);
  });
});

test('memory_write throws on a refused durable answer', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation: 'Ship the v2 release on Friday' }, cfg, deps), cfg);
    const answers = await askFake(memoryWrite, plan, cfg, fakeLuna({ refuse: ['durable'], choices: { action: 'save_new' } }));
    assert.throws(() => memoryWrite.interpret(answers, plan.ctx, cfg), /refused "durable"/);
  });
});

test('memory_write update targets the similar memory when Luna picks one of two', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    store.add({ type: 'project', text: 'release deadline is March 3 for the v2 launch' });
    store.add({ type: 'project', text: 'v2 launch checklist and release notes' });
    const plan = memoryWrite.plan(await prepared(memoryWrite, { observation: 'release deadline moved to March 10 for the v2 launch' }, cfg, deps), cfg);
    const fake = fakeLuna({ predicates: { durable: 0.9 }, choices: { action: 'update', type: 'project', target: 'm0' } });
    const v = memoryWrite.interpret(await askFake(memoryWrite, plan, cfg, fake), plan.ctx, cfg);
    assert.equal(v.result.targetId, plan.ctx.similar[0].record.id);
  });
});

test('memory_write heuristic: remember-style text saves, a near-duplicate updates, the rest skips (EN)', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    const rec = store.add({ type: 'user', text: PNPM_RULE });
    const decide = async (observation) => memoryWrite.heuristic(await prepared(memoryWrite, { observation }, cfg, deps), cfg).result;
    const dup = await decide(`${PNPM_RULE} now`);
    assert.deepEqual([dup.action, dup.targetId], ['update', rec.id]);
    const url = await decide('Remember the API base is https://api.example.com/v2');
    assert.deepEqual([url.action, url.type], ['save_new', 'reference']);
    const deadline = await decide('Remember the release deadline is March 3');
    assert.deepEqual([deadline.action, deadline.type], ['save_new', 'project']);
    const never = await decide('Never commit the .env file');
    assert.deepEqual([never.action, never.type], ['save_new', 'feedback']);
    const plain = await decide('The build passed in 4 seconds');
    assert.deepEqual([plain.action, plain.type], ['skip', 'user']);
  });
});

test('memory_write heuristic: 中文 wording saves with the guessed type, and a caller type wins', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const decide = async (observation, extra = {}) => {
      const r = memoryWrite.heuristic(await prepared(memoryWrite, { observation, ...extra }, cfg, deps), cfg).result;
      return [r.action, r.type];
    };
    assert.deepEqual(await decide('記住：專案截止日是 12 月 1 日'), ['save_new', 'project']);
    assert.deepEqual(await decide('以後都用繁體中文回答'), ['save_new', 'user']);
    assert.deepEqual(await decide('不要自動 push 到 main'), ['save_new', 'feedback']);
    assert.deepEqual(await decide('記住這個網址 https://example.com/spec'), ['save_new', 'reference']);
    assert.deepEqual(await decide('今天天氣不錯'), ['skip', 'user']);
    assert.deepEqual(await decide('記住：專案截止日是 12 月 1 日', { type: 'reference' }), ['save_new', 'reference']);
  });
});

test('memory_write finalize saves a new memory or updates the target; skip and dryRun leave the store unchanged', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    const rec = store.add({ type: 'user', text: PNPM_RULE });
    const run = async (input) => {
      const p = await prepared(memoryWrite, input, cfg, deps);
      return memoryWrite.finalize(memoryWrite.heuristic(p, cfg), p, cfg, deps);
    };
    const saved = await run({ observation: 'Remember the release deadline is March 3' });
    assert.equal(saved.result.applied, true);
    assert.equal(saved.result.memory.type, 'project');
    assert.equal(store.list().length, 2);
    const updated = await run({ observation: `${PNPM_RULE} now` });
    assert.equal(updated.result.memory.id, rec.id);
    assert.equal(store.get(rec.id).text, `${PNPM_RULE} now`);
    const skipped = await run({ observation: 'The build passed in 4 seconds' });
    assert.deepEqual([skipped.result.applied, skipped.result.memory], [false, null]);
    const dry = await run({ observation: 'Remember the ship date is May 5', dryRun: true });
    assert.deepEqual([dry.result.action, dry.result.applied, dry.result.memory], ['save_new', false, null]);
    assert.equal(store.list().length, 2);
  });
});

test('memory_write finalize needs a memory store in deps', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const p = await prepared(memoryWrite, { observation: 'Remember the ship date is May 5' }, cfg, deps);
    await assert.rejects(memoryWrite.finalize(memoryWrite.heuristic(p, cfg), p, cfg, {}), /no memory store in deps/);
  });
});

test('memory_write summarize gives action, target and type, never the text', () => {
  assert.equal(memoryWrite.summarize({ action: 'update', type: 'feedback', targetId: 'm_0123456789', text: 'x' }), 'update m_0123456789 (feedback)');
  assert.equal(memoryWrite.summarize({ action: 'skip', type: 'user', targetId: null, text: null }), 'skip (user)');
});

test('the kind objects are frozen and no step mutates its input', async () => {
  assert.ok(Object.isFrozen(memoryRecall) && Object.isFrozen(memoryWrite));
  assert.deepEqual([memoryRecall.name, memoryWrite.name], ['memory_recall', 'memory_write']);
  assert.throws(() => { memoryWrite.name = 'other'; }, TypeError);
  await withWorld({}, async ({ cfg, store, deps }) => {
    store.add({ type: 'user', text: PNPM_RULE });
    const raw = { observation: PNPM_RULE.replace('always', 'Always'), source: 'agent' };
    const rawSnapshot = JSON.stringify(raw);
    const input = await prepared(memoryWrite, raw, cfg, deps);
    memoryWrite.plan(input, cfg);
    memoryWrite.heuristic(input, cfg);
    assert.equal(JSON.stringify(raw), rawSnapshot);
    const recall = { query: 'pnpm' };
    const recallSnapshot = JSON.stringify(recall);
    const recallInput = await prepared(memoryRecall, recall, cfg, deps);
    memoryRecall.plan(recallInput, cfg);
    memoryRecall.heuristic(recallInput, cfg);
    assert.equal(JSON.stringify(recall), recallSnapshot);
  });
});

// ------------------------------------------------ boundaries (threshold equality)

test('memory_write keeps an observation whose durable answer is exactly durableThreshold, and skips one just under it', async () => {
  await withWorld({}, async ({ cfg, deps }) => {
    const threshold = cfg.memory.durableThreshold;
    const observation = 'Ship the v2 release on Friday';
    const decide = async (durable) => {
      const plan = memoryWrite.plan(await prepared(memoryWrite, { observation }, cfg, deps), cfg);
      const fake = fakeLuna({ predicates: { durable }, choices: { action: 'save_new', type: 'project' } });
      return memoryWrite.interpret(await askFake(memoryWrite, plan, cfg, fake), plan.ctx, cfg).result.action;
    };
    assert.equal(await decide(threshold), 'save_new');
    assert.equal(await decide(threshold - 0.01), 'skip');
  });
});

test('memory_write settles an observation at similarity exactly 0.95 as already stored, and asks Luna just below it', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    const stored = `${WORDS.slice(0, 19).join(' ')} extra`;
    const rec = store.add({ type: 'user', text: stored });
    const at = WORDS.slice(0, 19).join(' ');
    const below = WORDS.slice(0, 18).join(' ');
    assert.equal(similarity(at, stored), ALREADY_STORED_SIMILARITY);
    assert.equal(similarity(below, stored), 0.9);
    const settled = memoryWrite.plan(await prepared(memoryWrite, { observation: at }, cfg, deps), cfg).settled;
    assert.deepEqual([settled.result.action, settled.reasons], ['skip', [`already stored as ${rec.id}`]]);
    const asked = memoryWrite.plan(await prepared(memoryWrite, { observation: below }, cfg, deps), cfg);
    assert.equal(asked.settled, undefined);
    assert.ok(asked.questions.some((q) => q.name === 'action'));
  });
});

test('memory_write heuristic updates the similar memory at similarity exactly duplicateSimilarity (0.8)', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    assert.equal(cfg.memory.duplicateSimilarity, DUPLICATE_SIMILARITY);
    const rec = store.add({ type: 'user', text: `${WORDS.slice(0, 4).join(' ')} extra` });
    const same = WORDS.slice(0, 4).join(' ');
    assert.equal(similarity(same, rec.text), DUPLICATE_SIMILARITY);
    const dup = memoryWrite.heuristic(await prepared(memoryWrite, { observation: same }, cfg, deps), cfg).result;
    assert.deepEqual([dup.action, dup.targetId], ['update', rec.id]);
  });
});

test('memory_write heuristic does not update at similarity 0.75, just below duplicateSimilarity', async () => {
  await withWorld({}, async ({ cfg, store, deps }) => {
    const rec = store.add({ type: 'user', text: `${WORDS.slice(0, 3).join(' ')} extra` });
    const near = WORDS.slice(0, 3).join(' ');
    assert.equal(similarity(near, rec.text), 0.75);
    const result = memoryWrite.heuristic(await prepared(memoryWrite, { observation: near }, cfg, deps), cfg).result;
    assert.equal(result.action, 'skip');
    assert.equal(result.targetId, null);
  });
});
