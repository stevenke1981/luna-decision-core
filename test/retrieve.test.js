import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { retrieve, LEXICAL_RATIO, MAX_RULE_CHUNKS } from '../src/domains/retrieve.js';
import { createRepoIndex } from '../src/index/repo.js';
import { askLuna } from '../src/luna/client.js';
import { answersByName } from '../src/luna/answers.js';
import { estimateTokens } from '../src/text.js';
import { fakeLuna, predicate } from './helpers/fakeLuna.js';

const { normalize, prepare, plan, interpret, heuristic, summarize } = retrieve;

async function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-retrieve-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cfgFor(dir, retrieveOverrides = {}) {
  return loadConfig({ env: { LUNA_CORE_HOME: dir }, cwd: dir, overrides: { retrieve: retrieveOverrides } });
}

/** A candidate chunk; the source is the id's path part. */
const cand = (id, text, extra = {}) => ({ id, source: id.split('#')[0], text, ...extra });

const answersOf = (...list) => answersByName({ answers: list });

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

function throwsType(fn, re) {
  assert.throws(fn, (e) => e instanceof TypeError && re.test(e.message));
}

test('normalize rejects bad input and returns a new object with the defaults applied', () => withDir(async (dir) => {
  const cfg = cfgFor(dir, { budgetTokens: 500 });
  const input = { query: '  how is the cache evicted  ', candidates: [cand('src/a.js#1', 'x')] };
  const before = structuredClone(input);
  const out = normalize(input, cfg);
  assert.equal(out.query, 'how is the cache evicted');
  assert.equal(out.budgetTokens, 500);
  assert.equal(out.force, false);
  assert.notEqual(out, input);
  assert.deepEqual(input, before, 'the input is not mutated');
  throwsType(() => normalize(null, cfg), /input must be an object/);
  throwsType(() => normalize({}, cfg), /query must be a non-empty string/);
  throwsType(() => normalize({ query: 'x', candidates: 'no' }, cfg), /candidates must be an array/);
  throwsType(() => normalize({ query: 'x', candidates: [cand('a#1', 't'), cand('a#1', 't')] }, cfg), /ids must be unique/);
  throwsType(() => normalize({ query: 'x', candidates: [{ id: '', source: 'a', text: 't' }] }, cfg), /non-empty id and source/);
  throwsType(() => normalize({ query: 'x', candidates: [cand('a#1', 5)] }, cfg), /text must be a string/);
  throwsType(() => normalize({ query: 'x', candidates: [cand('a#1', 't', { score: -1 })] }, cfg), /score must be a number/);
  throwsType(() => normalize({ query: 'x', candidates: [cand('a#1', 't', { startLine: 5, endLine: 2 })] }, cfg), /startLine <= endLine/);
  throwsType(() => normalize({ query: 'x', force: 'yes' }, cfg), /force must be a boolean/);
  throwsType(() => normalize({ query: 'x', budgetTokens: 0 }, cfg), /budgetTokens must be a positive integer/);
  throwsType(() => normalize({ query: 'x', root: 3 }, cfg), /root must be a non-empty string/);
}));

test('prepare fills candidates from the repository index only when they are absent and a root is given', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const calls = [];
  const deps = {
    repoIndex: (root) => {
      calls.push(root);
      return { search: (query, k) => { calls.push([query, k]); return [cand('src/x.js#1', 'text', { score: 2 })]; } };
    },
  };
  const found = await prepare(normalize({ query: 'cache eviction', root: '/repo' }, cfg), cfg, deps);
  assert.deepEqual(found.candidates.map((c) => c.id), ['src/x.js#1']);
  assert.deepEqual(calls, ['/repo', ['cache eviction', cfg.retrieve.shortlist]]);
  calls.length = 0;
  await prepare(normalize({ query: 'q', root: '/repo', candidates: [] }, cfg), cfg, deps);
  assert.equal(calls.length, 0, 'given candidates, even empty, are not replaced');
  const noRoot = await prepare(normalize({ query: 'q' }, cfg), cfg, deps);
  assert.deepEqual(noRoot.candidates, []);
  assert.equal(calls.length, 0, 'no root, no search');
  await assert.rejects(prepare(normalize({ query: 'q', root: '/r' }, cfg), cfg, {}), /no repoIndex dependency/);
}));

test('plan settles without a Luna call when there are no candidates', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const p = plan(normalize({ query: 'where is the cache' }, cfg), cfg);
  assert.equal(p.questions, undefined);
  assert.deepEqual(p.settled, {
    result: { needed: false, chunks: [], tokens: 0, considered: 0 },
    confidence: null,
    reasons: ['no candidates'],
  });
}));

test('plan asks the need predicate and one relevance predicate per chunk, and omits the need predicate when forced', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('src/a.js#1', 'alpha'), cand('src/b.js#1', 'beta')];
  const asked = plan(normalize({ query: 'where is alpha', candidates }, cfg), cfg);
  assert.deepEqual(asked.questions.map((q) => [q.name, q.type]), [['need_retrieval', 'predicate'], ['c0', 'predicate'], ['c1', 'predicate']]);
  assert.equal(asked.questions[1].instructions, 'Is chunk c0 relevant to the query?');
  const forced = plan(normalize({ query: 'where is alpha', candidates, force: true }, cfg), cfg);
  assert.deepEqual(forced.questions.map((q) => q.name), ['c0', 'c1']);
  assert.equal(forced.ctx.force, true);
}));

test('plan state carries excerpts with line ranges and redacts only the secret-looking spans', () => withDir(async (dir) => {
  const cfg = cfgFor(dir, { excerptChars: 60 });
  const long = `def cache() {}\n${'x'.repeat(500)}`;
  const candidates = [
    cand('src/cache.js#1', long, { startLine: 1, endLine: 40 }),
    cand('src/keys.js#3', 'function login() {\n  const password: hunter2hunter2;\n}', { startLine: 3, endLine: 9 }),
  ];
  const p = plan(normalize({ query: 'where is the cache', candidates }, cfg), cfg);
  assert.equal(p.state.query, 'where is the cache');
  assert.deepEqual(p.state.chunks.map((c) => [c.id, c.source]), [['c0', 'src/cache.js:1-40'], ['c1', 'src/keys.js:3-9']]);
  assert.ok(p.state.chunks[0].text.length <= 60);
  assert.equal(p.state.chunks[1].text, 'function login() {\n  const [redacted]\n}');
  assert.ok(!JSON.stringify(p.state).includes('hunter2'));
  const leaky = plan(normalize({ query: 'rotate sk-abcdefghijklmnopqrstuvwx now, then sk-zyxwvutsrqponmlkjihgfedc', candidates: [candidates[0]] }, cfg), cfg);
  assert.equal(leaky.state.query, 'rotate [redacted] now, then [redacted]');
  assert.ok(!JSON.stringify(leaky.state).includes('sk-'));
  assert.equal(p.ctx.candidates[1].text.includes('hunter2'), true, 'the rules still see the full text');
}));

test('interpret: not needed gives no chunks, and the certainty of the need answer as confidence', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('src/a.js#1', 'alpha'), cand('src/b.js#1', 'beta')];
  const p = plan(normalize({ query: 'what does this do', candidates }, cfg), cfg);
  const v = interpret(answersOf(predicate('need_retrieval', 0.2), predicate('c0', 0.9), predicate('c1', 0.9)), p.ctx, cfg);
  assert.deepEqual(v.result, { needed: false, chunks: [], tokens: 0, considered: 2 });
  near(v.confidence, 0.8);
  assert.deepEqual(v.reasons, ['luna: no retrieval needed']);
}));

test('interpret keeps chunks at or above the threshold, most probable first, ties in input order', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('a#1', 'A'), cand('b#1', 'B'), cand('c#1', 'C'), cand('d#1', 'D')];
  const p = plan(normalize({ query: 'anything', candidates }, cfg), cfg);
  const answers = answersOf(predicate('need_retrieval', 0.9), predicate('c0', 0.5), predicate('c1', 0.9), predicate('c2', 0.49), predicate('c3', 0.9));
  const v = interpret(answers, p.ctx, cfg);
  assert.equal(v.result.needed, true);
  assert.deepEqual(v.result.chunks.map((c) => c.id), ['b#1', 'd#1', 'a#1']);
  assert.equal(v.result.chunks[0].probability, 0.9);
  assert.equal(v.result.considered, 4);
  near(v.confidence, 0.9);
  const strict = interpret(answers, p.ctx, cfgFor(dir, { threshold: 0.8 }));
  assert.deepEqual(strict.result.chunks.map((c) => c.id), ['b#1', 'd#1']);
  const atHalf = interpret(answersOf(predicate('need_retrieval', 0.5), predicate('c0', 0.9), predicate('c1', 0.1), predicate('c2', 0.1), predicate('c3', 0.1)), p.ctx, cfg);
  assert.equal(atHalf.result.needed, true, 'a need probability of exactly 0.5 counts as needed');
  const justBelow = interpret(answersOf(predicate('need_retrieval', 0.49), predicate('c0', 0.9), predicate('c1', 0.1), predicate('c2', 0.1), predicate('c3', 0.1)), p.ctx, cfg);
  assert.equal(justBelow.result.needed, false);
}));

test('interpret skips a chunk that does not fit the token budget and takes the next one that does', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('big#1', 'word '.repeat(200)), cand('small#1', 'tiny'), cand('other#1', 'tiny2')];
  const p = plan(normalize({ query: 'anything here', candidates, budgetTokens: 10 }, cfg), cfg);
  const v = interpret(answersOf(predicate('need_retrieval', 0.9), predicate('c0', 0.95), predicate('c1', 0.8), predicate('c2', 0.7)), p.ctx, cfg);
  assert.deepEqual(v.result.chunks.map((c) => c.id), ['small#1', 'other#1']);
  assert.equal(v.result.tokens, estimateTokens('tiny') + estimateTokens('tiny2'));
}));

test('interpret with force skips the need answer and reports the mean certainty of the relevance answers', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('src/a.js#1', 'alpha'), cand('src/b.js#1', 'beta')];
  const p = plan(normalize({ query: 'anything at all', candidates, force: true }, cfg), cfg);
  const v = interpret(answersOf(predicate('c0', 0.9), predicate('c1', 0.3)), p.ctx, cfg);
  assert.equal(v.result.needed, true);
  assert.deepEqual(v.result.chunks.map((c) => c.id), ['src/a.js#1']);
  near(v.confidence, (0.9 + 0.7) / 2);
  assert.deepEqual(v.reasons, ['forced: retrieval on']);
}));

test('interpret throws on a refused, missing, mistyped or out-of-range answer, even when not needed', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('src/a.js#1', 'alpha'), cand('src/b.js#1', 'beta')];
  const p = plan(normalize({ query: 'where is alpha', candidates }, cfg), cfg);
  const refusal = { type: 'refusal', name: 'need_retrieval' };
  assert.throws(() => interpret(answersOf(refusal, predicate('c0', 0.9), predicate('c1', 0.9)), p.ctx, cfg), /Luna refused "need_retrieval"/);
  assert.throws(() => interpret(answersOf(predicate('need_retrieval', 0.9), predicate('c0', 0.9)), p.ctx, cfg), /no predicate answer for "c1"/);
  const mistyped = { type: 'choice', name: 'c1', choice: 'x', probabilities: [] };
  assert.throws(() => interpret(answersOf(predicate('need_retrieval', 0.9), predicate('c0', 0.9), mistyped), p.ctx, cfg), /no predicate answer for "c1"/);
  assert.throws(() => interpret(answersOf(predicate('need_retrieval', 0.9), predicate('c0', 0.9), predicate('c1', 1.5)), p.ctx, cfg), /no probability for "c1"/);
  assert.throws(() => interpret(answersOf(predicate('need_retrieval', 0.1), predicate('c0', 0.9)), p.ctx, cfg), /no predicate answer for "c1"/);
}));

test('heuristic: a greeting or a single-term query needs no retrieval, and force overrides both', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('src/a.js#1', 'login bug fix')];
  for (const query of ['hi', 'thanks!', 'refactor']) {
    const v = heuristic(normalize({ query, candidates }, cfg));
    assert.equal(v.result.needed, false, query);
    assert.deepEqual(v.reasons, ['rules: no retrieval needed']);
  }
  assert.equal(heuristic(normalize({ query: 'fix the login bug', candidates }, cfg)).result.needed, true);
  assert.equal(heuristic(normalize({ query: 'hi', candidates, force: true }, cfg)).result.needed, true);
}));

test('heuristic keeps chunks scoring at least LEXICAL_RATIO of the best, best first, at most MAX_RULE_CHUNKS', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const scores = [10, 4, 2.9, 8, 9, 7, 6, 5];
  const candidates = scores.map((score, i) => cand(`f${i}.js#1`, `text ${i}`, { score }));
  const v = heuristic(normalize({ query: 'cache eviction policy', candidates, budgetTokens: 1000 }, cfg));
  assert.deepEqual(v.result.chunks.map((c) => c.id), ['f0.js#1', 'f4.js#1', 'f3.js#1', 'f5.js#1', 'f6.js#1', 'f7.js#1']);
  assert.equal(v.result.chunks.length, MAX_RULE_CHUNKS);
  assert.ok(v.result.chunks.every((c) => c.probability === null));
  const edge = heuristic(normalize({ query: 'cache eviction policy', candidates: [cand('x#1', 'a', { score: 10 }), cand('y#1', 'b', { score: 3 })] }, cfg));
  assert.deepEqual(edge.result.chunks.map((c) => c.id), ['x#1', 'y#1'], 'a score exactly LEXICAL_RATIO of the best is kept');
  assert.equal(LEXICAL_RATIO, 0.3);
  assert.equal(MAX_RULE_CHUNKS, 6);
}));

test('heuristic without scores keeps input order and skips chunks that do not fit the budget', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('a#1', 'word '.repeat(40)), cand('b#1', 'x'.repeat(40)), cand('c#1', 'y'.repeat(8))];
  const v = heuristic(normalize({ query: 'where is the parser', candidates, budgetTokens: 15 }, cfg));
  assert.deepEqual(v.result.chunks.map((c) => c.id), ['b#1', 'c#1']);
  assert.equal(v.result.tokens, 12);
  assert.equal(v.result.considered, 3);
}));

test('heuristic and interpret return the same result shape', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  const candidates = [cand('src/a.js#1', 'alpha beta', { startLine: 1, endLine: 2, score: 1 })];
  const rules = heuristic(normalize({ query: 'alpha beta gamma', candidates }, cfg));
  const luna = interpret(answersOf(predicate('need_retrieval', 0.9), predicate('c0', 0.9)), plan(normalize({ query: 'alpha beta gamma', candidates }, cfg), cfg).ctx, cfg);
  for (const v of [rules, luna]) {
    assert.deepEqual(Object.keys(v.result).sort(), ['chunks', 'considered', 'needed', 'tokens']);
    assert.deepEqual(Object.keys(v.result.chunks[0]).sort(), ['endLine', 'id', 'probability', 'source', 'startLine', 'text']);
  }
  assert.equal(rules.result.chunks[0].probability, null);
  assert.equal(luna.result.chunks[0].probability, 0.9);
}));

test('summarize gives counts and never the query or the chunk text', () => {
  const result = { needed: true, chunks: [{ text: 'PRIVATE-XYZ' }], tokens: 12, considered: 5 };
  assert.equal(summarize(result), '1 of 5 chunks, 12 tokens');
  assert.equal(summarize({ needed: false, chunks: [], tokens: 0, considered: 3 }), 'not needed; 3 considered');
  assert.ok(!summarize(result).includes('XYZ'));
});

test('the kind object is frozen, and plan and interpret never mutate their inputs', () => withDir(async (dir) => {
  const cfg = cfgFor(dir);
  assert.equal(retrieve.name, 'retrieve');
  assert.ok(Object.isFrozen(retrieve));
  assert.throws(() => { retrieve.name = 'other'; }, TypeError);
  const input = normalize({ query: 'where is alpha', candidates: [cand('src/a.js#1', 'alpha')] }, cfg);
  const snapshot = structuredClone(input);
  const p = plan(input, cfg);
  assert.deepEqual(input, snapshot);
  const ctxSnapshot = structuredClone(p.ctx);
  interpret(answersOf(predicate('need_retrieval', 0.9), predicate('c0', 0.9)), p.ctx, cfg);
  assert.deepEqual(p.ctx, ctxSnapshot);
}));

test('end to end: the repository index, Luna through the fake transport, then the verdict', () => withDir(async (dir) => {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'cache.js'), 'export function evict(cache) {\n  // LRU eviction of the cache\n}\n');
  fs.writeFileSync(path.join(repo, 'src', 'parse.js'), 'export const parse = (s) => s.trim();\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\nCache notes\n');
  const cfg = cfgFor(dir, { chunkLines: 2, chunkOverlap: 0, shortlist: 5 });
  const deps = { repoIndex: (root) => createRepoIndex(root, cfg.retrieve) };
  const prepared = await prepare(normalize({ query: 'how does cache eviction work', root: repo }, cfg), cfg, deps);
  assert.ok(prepared.candidates.length > 0);
  const p = plan(prepared, cfg);
  const fake = fakeLuna({
    predicates: (name, state) => {
      if (name === 'need_retrieval') return 0.9;
      return state.chunks.find((c) => c.id === name)?.text.includes('evict') ? 0.9 : 0.1;
    },
  });
  const body = await askLuna({ maxQuestionsPerCall: 16 }, { kind: 'retrieve', ...p.state }, p.questions, fake.transport);
  const v = interpret(answersByName({ answers: body.answers }), p.ctx, cfg);
  assert.equal(fake.calls.length, 1);
  assert.equal(v.result.needed, true);
  assert.ok(v.result.chunks.length >= 1 && v.result.chunks.every((c) => c.probability >= 0.5));
  assert.ok(v.result.chunks.some((c) => c.source === 'src/cache.js' && c.text.includes('evict')));
  assert.ok(fake.calls[0].state.chunks.every((c) => !path.isAbsolute(c.source.split(':')[0])));
}));
