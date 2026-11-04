import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compress, applyCompression, extractiveSummary, escalate,
  TOOL_DROP_AGE, TOOL_SUMMARIZE_TOKENS, ASSISTANT_SUMMARIZE_TOKENS,
} from '../src/domains/compress.js';
import * as applyModule from '../src/domains/compress-apply.js';
import { loadConfig, lunaOptions } from '../src/config.js';
import { answersByName } from '../src/luna/answers.js';
import { askLuna } from '../src/luna/client.js';
import { estimateTokens } from '../src/text.js';
import { fakeLuna, predicate, choice } from './helpers/fakeLuna.js';

const KEEP = 'keep';
const SUMMARIZE = 'summarize';
const DROP = 'drop';
const ACTIONS = [KEEP, SUMMARIZE, DROP];
const ESCALATED = 'rules escalated to reach the target ratio';

/** A loaded config; the temp home is removed right away (the config lives in memory). */
function cfgWith(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-test-'));
  try {
    return loadConfig({ env: { LUNA_CORE_HOME: dir }, cwd: dir, overrides });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CFG = cfgWith();

function assertTypeError(fn, re) {
  assert.throws(fn, (err) => err instanceof TypeError && re.test(err.message), `expected TypeError matching ${re}`);
}

/** `n` lines of repetitive work log; about 13 tokens a line. */
function log(tag, n = 60) {
  return Array.from({ length: n }, (_, i) => `${tag} line ${i} details about the work being done here`).join('\n');
}

const seg = (id, role, turn, text = 'x', extra = {}) => ({ id, role, turn, text, ...extra });

const tokensOf = (segments) => compress.normalize({ window: 1, segments }).segments.reduce((sum, s) => sum + s.tokens, 0);

/** Normalized input whose usage is `ratio` of the window (rounded up, so the ratio is at most `ratio`). */
function inputAt(segments, ratio, extra = {}) {
  return compress.normalize({ window: Math.ceil(tokensOf(segments) / ratio), segments, ...extra });
}

const probsFor = (chosen) => Object.fromEntries(ACTIONS.map((v) => [v, v === chosen ? 0.8 : 0.1]));

/** Answers for the questions of a plan: compact_now at `compactP`, every choice at `choose(name)`. */
function answersFor(questions, { compactP = 0.9, choose = () => DROP, confidence } = {}) {
  return answersByName({
    answers: questions.map((q) => (q.type === 'predicate'
      ? predicate(q.name, compactP)
      : choice(q.name, probsFor(choose(q.name)), confidence))),
  });
}

function planOrFail(input, cfg = CFG) {
  const p = compress.plan(input, cfg);
  assert.equal(p.settled, undefined, 'expected a plan for Luna, got a settled verdict');
  return p;
}

const sum = (segments) => segments.reduce((acc, s) => acc + s.tokens, 0);

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

// A plan in the soft-to-hard band with one old tool segment and one recent segment.
function bandSegments() {
  return [seg('old', 'tool', 0, log('old')), seg('cur', 'user', 9, 'now')];
}

const CURRENT_TOKENS = 5;

/** Two segments that sum to `total` tokens in a window of `window`: an old tool segment and the current one. */
function exactInput(total, window) {
  return compress.normalize({
    window,
    segments: [seg('old', 'tool', 0, 'x', { tokens: total - CURRENT_TOKENS }), seg('cur', 'user', 10, 'now', { tokens: CURRENT_TOKENS })],
  });
}

test('normalize rejects duplicate segment ids', () => {
  assertTypeError(() => compress.normalize({ window: 100, segments: [seg('a', 'user', 0), seg('a', 'tool', 1)] }), /duplicate segment id "a"/);
});

test('normalize rejects a bad role, turn, tokens, pinned flag, text or id', () => {
  const bad = [
    [{ role: 'bot' }, /role must be one of/],
    [{ turn: -1 }, /turn must be an integer/],
    [{ turn: 1.5 }, /turn must be an integer/],
    [{ tokens: -3 }, /tokens must be an integer/],
    [{ tokens: 2.5 }, /tokens must be an integer/],
    [{ pinned: 'yes' }, /pinned must be a boolean/],
    [{ text: 42 }, /text must be a string/],
    [{ id: '' }, /segment id must be a non-empty string/],
  ];
  for (const [patch, re] of bad) {
    assertTypeError(() => compress.normalize({ window: 100, segments: [{ id: 'a', role: 'user', turn: 0, text: 'x', ...patch }] }), re);
  }
});

test('normalize rejects a bad window, segments, goal, force or input', () => {
  assertTypeError(() => compress.normalize(null), /input must be an object/);
  for (const window of [0, -5, 1.5, '100', undefined]) {
    assertTypeError(() => compress.normalize({ window, segments: [] }), /window must be a positive integer/);
  }
  assertTypeError(() => compress.normalize({ window: 10, segments: 'x' }), /segments must be an array/);
  assertTypeError(() => compress.normalize({ window: 10, segments: [1] }), /segment 0 must be an object/);
  assertTypeError(() => compress.normalize({ window: 10, segments: [], goal: 5 }), /goal must be a string/);
  assertTypeError(() => compress.normalize({ window: 10, segments: [], force: 'yes' }), /force must be a boolean/);
});

test('normalize fills tokens, defaults pinned and returns new objects without the input mutated', () => {
  const raw = [seg('a', 'tool', 0, 'hello world, this is text', { extra: 1 }), seg('b', 'user', 1, 'x', { pinned: true, tokens: 7 })];
  const before = structuredClone(raw);
  const out = compress.normalize({ window: 500, segments: raw });
  assert.equal(out.segments[0].tokens, estimateTokens('hello world, this is text'));
  assert.equal(out.segments[0].pinned, false);
  assert.equal('extra' in out.segments[0], false, 'unknown fields are dropped');
  assert.equal(out.segments[1].tokens, 7);
  assert.equal(out.segments[1].pinned, true);
  assert.equal(out.force, false);
  assert.equal(out.goal, '');
  assert.notEqual(out.segments[0], raw[0]);
  assert.deepEqual(raw, before);
});

test('plan settles under the soft limit without asking Luna', () => {
  const input = compress.normalize({ window: 10000, segments: [seg('a', 'user', 0, 'short'), seg('b', 'assistant', 5, 'ok')] });
  const p = compress.plan(input, CFG);
  assert.equal(p.settled.result.compact, false);
  assert.deepEqual(p.settled.reasons, ['under the soft limit']);
  assert.equal(p.settled.confidence, null);
  assert.equal(p.settled.result.segments, null);
  assert.equal(p.settled.result.tokensAfter, p.settled.result.tokensBefore);
});

test('plan settles when nothing is eligible, even above the soft limit and when forced', () => {
  const segments = [
    seg('sys', 'system', 0, log('sys')),
    seg('pin', 'tool', 0, log('pin'), { pinned: true }),
    seg('recent', 'user', 9, log('recent')),
  ];
  for (const force of [false, true]) {
    const p = compress.plan(inputAt(segments, 0.9, { force }), CFG);
    assert.equal(p.settled.result.compact, false);
    assert.deepEqual(p.settled.reasons, ['nothing eligible']);
  }
});

test('pinned, system and recent segments are never asked, listed in the state or compacted', () => {
  const segments = [
    seg('sys', 'system', 0, log('sys')),
    seg('pin', 'assistant', 1, log('pin'), { pinned: true }),
    seg('old', 'tool', 2, log('old')),
    seg('mid', 'assistant', 4, log('mid')),
    seg('new', 'tool', 9, log('new')),
    seg('cur', 'user', 10, 'now'),
  ];
  const input = inputAt(segments, 0.7);
  const p = planOrFail(input);
  assert.equal(p.state.segments.length, 2, 'only the two eligible segments are in the state');
  assert.equal(p.questions.filter((q) => q.type === 'choice').length, 2);
  assert.ok(!JSON.stringify(p.state).includes('sys line'), 'system text is not in the state');
  assert.ok(!JSON.stringify(p.state).includes('pin line'), 'pinned text is not in the state');
  const fin = compress.finalize(compress.interpret(answersFor(p.questions, { choose: () => DROP }), p.ctx, CFG), input, CFG);
  assert.equal(fin.result.actions.sys, KEEP);
  assert.equal(fin.result.actions.pin, KEEP);
  assert.equal(fin.result.actions.new, KEEP);
  assert.equal(fin.result.actions.cur, KEEP);
  assert.deepEqual(fin.result.segments.map((s) => s.id), ['sys', 'pin', 'new', 'cur']);
});

test('maxSegmentsAsked asks only the largest segments; the rest stay kept', () => {
  const cfg = cfgWith({ compress: { maxSegmentsAsked: 2 } });
  const segments = [
    seg('a', 'tool', 0, log('a', 10)),
    seg('b', 'tool', 1, log('b', 40)),
    seg('c', 'assistant', 2, log('c', 20)),
    seg('d', 'tool', 3, log('d', 60)),
    seg('e', 'user', 4, log('e', 30)),
    seg('cur', 'user', 10, 'now'),
  ];
  const input = inputAt(segments, 0.7);
  const p = planOrFail(input, cfg);
  assert.equal(p.questions.filter((q) => q.type === 'choice').length, 2);
  assert.equal(p.state.segments.length, 2);
  const v = compress.interpret(answersFor(p.questions, { choose: () => DROP }), p.ctx, cfg);
  assert.deepEqual(v.result.actions, { a: KEEP, b: DROP, c: KEEP, d: DROP, e: KEEP, cur: KEEP });
});

test('compact_now is asked only between the soft and hard limits', () => {
  const segments = bandSegments();
  const asksCompactNow = (ratio, extra) => {
    const p = compress.plan(inputAt(segments, ratio, extra), CFG);
    return p.settled ? 'settled' : p.questions.some((q) => q.name === 'compact_now');
  };
  assert.equal(asksCompactNow(0.5), 'settled', 'below soft: settled, no question');
  assert.equal(asksCompactNow(0.7), true, 'in the band: asked');
  assert.equal(asksCompactNow(0.7, { force: true }), false, 'forced: not asked');
  assert.equal(asksCompactNow(0.9), false, 'at or above hard: not asked');
});

test('a segment exactly keepRecentTurns older than the current turn is eligible, one turn newer is not', () => {
  assert.equal(CFG.compress.keepRecentTurns, 2, 'the turns below assume the default');
  const segments = [
    seg('old', 'tool', 0, log('o', 20)),
    seg('edge', 'assistant', 8, log('e', 20)), // 10 - 2: eligible
    seg('newer', 'assistant', 9, log('n', 20)), // 9 is past the newest eligible turn
    seg('cur', 'user', 10, 'now'),
  ];
  const p = planOrFail(inputAt(segments, 0.7));
  assert.deepEqual(p.ctx.asked.map((a) => a.id).sort(), ['edge', 'old']);
});

test('a ratio exactly at the hard limit compacts without asking compact_now', () => {
  assert.equal(CFG.compress.hardRatio, 85 / 100, 'the fixture sits exactly on the hard limit');
  const input = exactInput(85, 100);
  const p = planOrFail(input);
  assert.ok(!p.questions.some((q) => q.name === 'compact_now'), 'compact_now is asked only below the hard limit');
  const v = compress.interpret(answersFor(p.questions, { choose: () => DROP }), p.ctx, CFG);
  assert.equal(v.result.compact, true);
  assert.equal(v.result.actions.old, DROP);
  assert.deepEqual(v.reasons, ['ratio 0.85 at or above the hard limit']);
});

test('a ratio exactly at the soft limit is not under it: plan asks Luna and the rules compact', () => {
  assert.equal(CFG.compress.softRatio, 60 / 100, 'the fixture sits exactly on the soft limit');
  const input = exactInput(60, 100);
  const p = planOrFail(input);
  assert.ok(p.questions.some((q) => q.name === 'compact_now'));
  assert.equal(compress.heuristic(input, CFG).result.compact, true);
});

test('force compacts under the soft limit and does not ask compact_now', () => {
  const input = compress.normalize({ window: 100000, segments: bandSegments(), force: true });
  const p = planOrFail(input);
  assert.ok(!p.questions.some((q) => q.name === 'compact_now'));
  const v = compress.interpret(answersFor(p.questions, { choose: () => SUMMARIZE }), p.ctx, CFG);
  assert.equal(v.result.compact, true);
  assert.equal(v.result.actions.old, SUMMARIZE);
  assert.deepEqual(v.reasons, ['forced']);
});

test('interpret compacts when compact_now reaches 0.5 and returns actions only when compacting', () => {
  const p = planOrFail(inputAt(bandSegments(), 0.7));
  const yes = compress.interpret(answersFor(p.questions, { compactP: 0.5, choose: () => DROP }), p.ctx, CFG);
  assert.equal(yes.result.compact, true);
  assert.equal(yes.result.actions.old, DROP);
  assert.equal(yes.result.actions.cur, KEEP);
  const no = compress.interpret(answersFor(p.questions, { compactP: 0.2, choose: () => DROP }), p.ctx, CFG);
  assert.equal(no.result.compact, false);
  assert.deepEqual(no.result.actions, {});
  assert.equal(no.result.segments, null);
  assert.equal(no.result.tokensAfter, no.result.tokensBefore);
  assert.deepEqual(no.reasons, ['compact_now 0.20']);
});

test('interpret confidence is certainty(compact_now) when asked, else the mean choice confidence', () => {
  const band = planOrFail(inputAt(bandSegments(), 0.7));
  const low = compress.interpret(answersFor(band.questions, { compactP: 0.3, confidence: 0.9 }), band.ctx, CFG);
  assert.ok(Math.abs(low.confidence - 0.7) < 1e-9, `certainty(0.3) is 0.7, got ${low.confidence}`);
  const high = compress.interpret(answersFor(band.questions, { compactP: 0.8, confidence: 0.9 }), band.ctx, CFG);
  assert.ok(Math.abs(high.confidence - 0.8) < 1e-9);
  const hard = planOrFail(inputAt(bandSegments(), 0.9));
  const mean = compress.interpret(answersFor(hard.questions, { confidence: 0.6 }), hard.ctx, CFG);
  assert.ok(Math.abs(mean.confidence - 0.6) < 1e-9, `mean of choice confidences, got ${mean.confidence}`);
  assert.deepEqual(mean.reasons, ['ratio 0.90 at or above the hard limit']);
});

test('interpret throws on a refused compact_now, a missing choice and an unknown choice', () => {
  const p = planOrFail(inputAt(bandSegments(), 0.7));
  const refused = answersByName({ answers: [{ type: 'refusal', name: 'compact_now' }, choice('g0', probsFor(KEEP))] });
  assert.throws(() => compress.interpret(refused, p.ctx, CFG), /refused "compact_now"/);
  const missing = answersByName({ answers: [predicate('compact_now', 0.9)] });
  assert.throws(() => compress.interpret(missing, p.ctx, CFG), /no choice answer for "g0"/);
  const unknown = answersByName({ answers: [predicate('compact_now', 0.9), { type: 'choice', name: 'g0', choice: 'archive', probabilities: [] }] });
  assert.throws(() => compress.interpret(unknown, p.ctx, CFG), /unknown choice for "g0"/);
});

test('heuristic drops old tool output, summarizes big tool and assistant output, keeps the rest', () => {
  const segments = [
    seg('sys', 'system', 0, log('sys', 80)),
    seg('old-tool', 'tool', 1, log('ot', 30)),
    seg('edge-tool', 'tool', 3, log('et', 30)),
    seg('boundary-tool', 'tool', 4, log('bt', 60)),
    seg('small-tool', 'tool', 5, 'tiny output'),
    seg('big-asst', 'assistant', 7, log('ba', 80)),
    seg('mid-asst', 'assistant', 7, log('ma', 40)),
    seg('user', 'user', 8, 'please continue'),
    seg('cur', 'user', 10, 'now'),
  ];
  const input = inputAt(segments, 0.7);
  const v = compress.heuristic(input, CFG);
  assert.equal(v.result.compact, true);
  assert.deepEqual(v.result.actions, {
    sys: KEEP, 'old-tool': DROP, 'edge-tool': DROP, 'boundary-tool': SUMMARIZE,
    'small-tool': KEEP, 'big-asst': SUMMARIZE, 'mid-asst': KEEP, user: KEEP, cur: KEEP,
  });
  assert.ok(!v.reasons.includes(ESCALATED), 'no escalation needed at the default target');
  assert.equal(v.source, undefined, 'the engine sets the source');
});

test('heuristic thresholds are the named constants', () => {
  assert.equal(TOOL_DROP_AGE, 6);
  assert.equal(TOOL_SUMMARIZE_TOKENS, 500);
  assert.equal(ASSISTANT_SUMMARIZE_TOKENS, 800);
});

test('heuristic does not compact under the soft limit, forced compacts, nothing eligible settles', () => {
  const segments = [seg('old', 'tool', 0, log('old', 30)), seg('cur', 'user', 10, 'now')];
  const under = compress.heuristic(inputAt(segments, 0.5), CFG);
  assert.equal(under.result.compact, false);
  assert.deepEqual(under.result.actions, {});
  assert.deepEqual(under.reasons, ['under the soft limit']);
  const forced = compress.heuristic(compress.normalize({ window: 100000, segments, force: true }), CFG);
  assert.equal(forced.result.compact, true);
  assert.equal(forced.result.actions.old, DROP);
  assert.deepEqual(forced.reasons, ['forced']);
  const none = compress.heuristic(inputAt([seg('cur', 'user', 0, log('cur', 30))], 0.9), CFG);
  assert.equal(none.result.compact, false);
  assert.deepEqual(none.reasons, ['nothing eligible']);
});

// Two eligible segments (tool at turn 1, assistant at turn 3) and one recent user segment at turn 6.
// Each long segment is about 780 tokens and summarizes to about 52.
function escalationInput(recentTokens) {
  return compress.normalize({
    window: 10000,
    segments: [
      seg('t1', 'tool', 1, log('t', 60)),
      seg('a3', 'assistant', 3, log('a', 60)),
      seg('r6', 'user', 6, 'recent', { tokens: recentTokens }),
    ],
  });
}

test('escalate reaches targetRatio: keep to summarize first, then tool summarize to drop', () => {
  const input = escalationInput(4900);
  const limit = CFG.compress.targetRatio * input.window;
  const res = escalate({}, input, CFG);
  assert.equal(res.changed, true);
  assert.deepEqual(res.actions, { t1: DROP, a3: SUMMARIZE });
  const applied = applyCompression(input.segments, res.actions, CFG.compress);
  assert.ok(applied.tokensAfter <= limit, `${applied.tokensAfter} is at or below ${limit}`);
});

test('escalate summarizes only as far as needed, oldest first', () => {
  const input = escalationInput(4000);
  const res = escalate({}, input, CFG);
  assert.deepEqual(res.actions, { t1: SUMMARIZE });
  assert.equal(res.changed, true);
});

test('escalate leaves actions alone when already under the target', () => {
  const input = escalationInput(100);
  const res = escalate({ t1: KEEP }, input, CFG);
  assert.equal(res.changed, false);
  assert.deepEqual(res.actions, { t1: KEEP });
});

test('escalate never touches pinned, system or recent segments, even when still above the target', () => {
  const input = compress.normalize({
    window: 10000,
    segments: [
      seg('sys', 'system', 0, log('sys')),
      seg('pin', 'tool', 0, log('pin'), { pinned: true }),
      seg('t1', 'tool', 1, log('t')),
      seg('r6', 'user', 6, 'recent', { tokens: 9000 }),
    ],
  });
  const res = escalate({}, input, CFG);
  assert.equal(res.actions.sys, undefined);
  assert.equal(res.actions.pin, undefined);
  assert.equal(res.actions.r6, undefined);
  assert.equal(res.actions.t1, DROP, 'the only eligible segment is escalated to drop');
});

test('escalation pass 2 drops tool segments only: a summarized assistant segment stays a summary', () => {
  const input = escalationInput(4960);
  const res = escalate({}, input, CFG);
  assert.deepEqual(res.actions, { t1: DROP, a3: SUMMARIZE });
  const applied = applyCompression(input.segments, res.actions, CFG.compress);
  assert.ok(applied.tokensAfter > CFG.compress.targetRatio * input.window, 'still above the target, yet the assistant summary is not dropped');
});

test('escalation does not count a move that saves no tokens as a change', () => {
  const input = compress.normalize({
    window: 10000,
    segments: [seg('small', 'tool', 1, 'abc', { tokens: 1 }), seg('r6', 'user', 6, 'recent', { tokens: 9000 })],
  });
  const res = escalate({}, input, CFG);
  assert.equal(res.changed, false);
  assert.deepEqual(res.actions, {});
});

test('the rules summarize tool output above 500 tokens and assistant text above 800, not at those sizes', () => {
  const segments = [
    seg('tool-at', 'tool', 5, log('a'), { tokens: TOOL_SUMMARIZE_TOKENS }),
    seg('tool-over', 'tool', 5, log('b'), { tokens: TOOL_SUMMARIZE_TOKENS + 1 }),
    seg('asst-at', 'assistant', 5, log('c'), { tokens: ASSISTANT_SUMMARIZE_TOKENS }),
    seg('asst-over', 'assistant', 5, log('d'), { tokens: ASSISTANT_SUMMARIZE_TOKENS + 1 }),
    seg('cur', 'user', 10, 'now'),
  ];
  // force keeps the usage far below the target, so escalation never changes the rule actions.
  const input = compress.normalize({ window: 100000, segments, force: true });
  const v = compress.heuristic(input, CFG);
  assert.deepEqual(v.result.actions, {
    'tool-at': KEEP, 'tool-over': SUMMARIZE, 'asst-at': KEEP, 'asst-over': SUMMARIZE, cur: KEEP,
  });
});

test('gate returns source luna+rules only when the rules changed Luna result', () => {
  const luna = { result: { compact: true, actions: { t1: KEEP, a3: KEEP } }, confidence: 0.8, reasons: ['compact_now 0.90'] };
  const input = escalationInput(4900);
  const gated = compress.gate(luna, null, input, CFG);
  assert.equal(gated.source, 'luna+rules');
  assert.equal(gated.confidence, 0.8);
  assert.deepEqual(gated.reasons, ['compact_now 0.90', ESCALATED]);
  assert.deepEqual(gated.result.actions, { t1: DROP, a3: SUMMARIZE, r6: KEEP });
  const small = escalationInput(100);
  assert.equal(compress.gate(luna, null, small, CFG), luna, 'unchanged: Luna verdict returned as it is');
  const notCompact = { result: { compact: false, actions: {} }, confidence: 0.9, reasons: [] };
  assert.equal(compress.gate(notCompact, null, input, CFG), notCompact);
});

test('extractiveSummary keeps the first, last and key lines in order and drops the rest', () => {
  const text = ['first line', 'second line', 'filler 1', 'filler 2', 'filler 3', 'TODO: fix the parser',
    'filler 4', 'Error: code 2 on exit', 'filler 5', 'penultimate', 'last line'].join('\n');
  assert.equal(extractiveSummary(text, 1000), [
    'first line', 'second line', 'TODO: fix the parser', 'Error: code 2 on exit', 'penultimate', 'last line',
  ].join('\n'));
});

test('extractiveSummary cuts to maxChars keeping the head and the tail, skips blank lines and rejects bad input', () => {
  const text = ['first line', 'second line', 'filler 1', 'filler 2', 'filler 3', 'TODO: fix the parser',
    'filler 4', 'Error: code 2 on exit', 'filler 5', 'penultimate', 'last line'].join('\n');
  const cut = extractiveSummary(text, 30);
  assert.equal(cut.length, 30);
  assert.ok(cut.includes('…'));
  assert.ok(cut.startsWith('first line'));
  assert.ok(cut.endsWith('last line'));
  assert.equal(extractiveSummary('\n\n  \nalpha\n\nbeta\n', 100), 'alpha\nbeta');
  assert.equal(extractiveSummary('', 10), '');
  assert.equal(extractiveSummary('a'.repeat(50), 1), '…');
  assertTypeError(() => extractiveSummary(5, 10), /summary text must be a string/);
  assertTypeError(() => extractiveSummary('x', 0), /maxChars must be a positive integer/);
});

test('applyCompression: drop removes, summarize shrinks with a marker, keep copies, token math adds up', () => {
  const segments = compress.normalize({
    window: 9000,
    segments: [
      seg('keep', 'user', 0, 'keep me'),
      seg('gone', 'tool', 1, log('g', 40)),
      seg('sum', 'assistant', 2, log('s', 60)),
      seg('kept2', 'user', 3, 'plain'),
    ],
  }).segments;
  const out = applyCompression(segments, { gone: DROP, sum: SUMMARIZE }, CFG.compress);
  assert.deepEqual(out.segments.map((s) => s.id), ['keep', 'sum', 'kept2']);
  const summarized = out.segments.find((s) => s.id === 'sum');
  assert.ok(summarized.text.startsWith(`[summarized ${segments[2].tokens}→`), summarized.text.slice(0, 40));
  assert.match(summarized.text, /^\[summarized \d+→\d+ tokens\] /);
  assert.equal(summarized.tokens, estimateTokens(summarized.text));
  assert.ok(summarized.tokens < segments[2].tokens);
  assert.equal(out.tokensBefore, sum(segments));
  assert.equal(out.tokensAfter, sum(out.segments));
  assert.equal(out.segments[0].text, 'keep me');
  assert.notEqual(out.segments[0], segments[0]);
  assert.deepEqual(applyCompression(segments, {}, CFG.compress).segments, segments);
});

test('a summary, marker included, stays within summaryChars', () => {
  const segments = compress.normalize({ window: 9000, segments: [seg('long', 'tool', 0, log('L', 200), { tokens: 5000 })] }).segments;
  for (const summaryChars of [60, 120, 400]) {
    const out = applyCompression(segments, { long: SUMMARIZE }, { summaryChars });
    assert.ok(out.segments[0].text.length <= summaryChars, `${out.segments[0].text.length} chars for summaryChars ${summaryChars}`);
    assert.match(out.segments[0].text, /^\[summarized 5000→\d+ tokens\] /);
  }
});

test('the summary marker reports the tokens of the whole summarized text at every budget', () => {
  const segments = compress.normalize({ window: 9000, segments: [seg('long', 'tool', 0, log('L', 200))] }).segments;
  for (let summaryChars = 40; summaryChars <= 400; summaryChars += 7) {
    const [out] = applyCompression(segments, { long: SUMMARIZE }, { summaryChars }).segments;
    const m = /^\[summarized (\d+)→(\d+) tokens\] /.exec(out.text);
    assert.ok(m, `the summary starts with its marker at summaryChars ${summaryChars}`);
    assert.equal(Number(m[1]), segments[0].tokens, 'the marker names the original tokens');
    assert.equal(Number(m[2]), out.tokens, `marker ${m[2]} for a ${out.tokens}-token summary at summaryChars ${summaryChars}`);
    assert.ok(out.text.length <= summaryChars, `${out.text.length} chars for summaryChars ${summaryChars}`);
  }
});

test('a summary that is not smaller than its segment does not replace it', () => {
  // The marker makes the summary of 'abc' 7 tokens: a 7-token segment is kept, an 8-token one summarized.
  const same = compress.normalize({ window: 1000, segments: [seg('same', 'assistant', 0, 'abc', { tokens: 7 })] }).segments;
  assert.equal(applyCompression(same, { same: SUMMARIZE }, CFG.compress).segments[0].text, 'abc');
  const bigger = compress.normalize({ window: 1000, segments: [seg('bigger', 'assistant', 0, 'abc', { tokens: 8 })] }).segments;
  assert.match(applyCompression(bigger, { bigger: SUMMARIZE }, CFG.compress).segments[0].text, /^\[summarized 8→7 tokens\] abc$/);
});

test('applyCompression rejects an unknown segment id or action', () => {
  const segments = compress.normalize({ window: 100, segments: [seg('keep', 'user', 0, 'x')] }).segments;
  assertTypeError(() => applyCompression(segments, { nope: DROP }, CFG.compress), /unknown segment "nope"/);
  assertTypeError(() => applyCompression(segments, { keep: 'archive' }, CFG.compress), /unknown action "archive"/);
});

test('a summarize that would not shrink a segment keeps it, and the verdict reports keep', () => {
  const segments = compress.normalize({ window: 1000, segments: [seg('tiny', 'assistant', 0, 'short', { tokens: 2 })] }).segments;
  const out = applyCompression(segments, { tiny: SUMMARIZE }, CFG.compress);
  assert.equal(out.segments[0].text, 'short');
  assert.equal(out.tokensAfter, 2);
  const segs = [seg('tiny', 'assistant', 0, 'short', { tokens: 2 }), seg('big', 'tool', 1, log('b')), seg('cur', 'user', 9, 'now')];
  const p = planOrFail(inputAt(segs, 0.7));
  const v = compress.interpret(answersFor(p.questions, { choose: () => SUMMARIZE }), p.ctx, CFG);
  assert.equal(v.result.actions.tiny, KEEP, 'reported as keep: nothing to gain');
  assert.equal(v.result.actions.big, SUMMARIZE);
});

test('compress re-exports the helpers from compress-apply.js, as the same functions', () => {
  assert.equal(applyCompression, applyModule.applyCompression);
  assert.equal(extractiveSummary, applyModule.extractiveSummary);
  assert.deepEqual([...applyModule.ACTIONS], [KEEP, SUMMARIZE, DROP]);
});

test('finalize applies the actions when compacting and sets the result fields', () => {
  const segments = bandSegments();
  const input = inputAt(segments, 0.7);
  const before = structuredClone(segments);
  const p = planOrFail(input);
  const v = compress.interpret(answersFor(p.questions, { compactP: 0.9, confidence: 0.75, choose: () => DROP }), p.ctx, CFG);
  const fin = compress.finalize(v, input, CFG);
  assert.deepEqual(fin.result.segments.map((s) => s.id), ['cur']);
  assert.equal(fin.result.tokensBefore, sum(input.segments));
  assert.equal(fin.result.tokensAfter, sum(fin.result.segments));
  assert.equal(fin.result.ratioAfter, fin.result.tokensAfter / input.window);
  assert.equal(fin.confidence, v.confidence);
  assert.equal(fin.source, undefined);
  assert.deepEqual(segments, before, 'the input segments are not changed');
});

test('finalize leaves segments null and tokensAfter equal to tokensBefore when not compacting', () => {
  const input = inputAt(bandSegments(), 0.7);
  const p = planOrFail(input);
  const v = compress.interpret(answersFor(p.questions, { compactP: 0.1 }), p.ctx, CFG);
  const fin = compress.finalize(v, input, CFG);
  assert.equal(fin.result.compact, false);
  assert.equal(fin.result.segments, null);
  assert.equal(fin.result.tokensAfter, fin.result.tokensBefore);
  assert.equal(fin.result.ratioAfter, fin.result.tokensBefore / input.window);
  const settled = compress.finalize(compress.plan(inputAt(bandSegments(), 0.5), CFG).settled, inputAt(bandSegments(), 0.5), CFG);
  assert.equal(settled.result.segments, null);
});

test('the state carries excerpts, not whole texts, and the goal is cut to 1000 characters', () => {
  const segments = [seg('old', 'assistant', 0, 'x'.repeat(5000)), seg('cur', 'user', 9, 'now')];
  const input = compress.normalize({ window: Math.ceil(tokensOf(segments) / 0.7), segments, goal: 'g'.repeat(3000) });
  const p = planOrFail(input);
  assert.equal(p.state.goal.length, 1000);
  const [s] = p.state.segments;
  assert.ok(s.text.length <= CFG.compress.excerptChars, `excerpt ${s.text.length} chars`);
  assert.ok(s.text.includes(' … '), 'the excerpt keeps the tail');
  assert.equal(s.keepTail, true);
  assert.equal(s.age, 9);
  assert.deepEqual(Object.keys(p.state).sort(), ['goal', 'segments', 'usage']);
});

test('secrets in segment text or the goal are redacted before they reach the Luna state', () => {
  const key = `sk-${'a'.repeat(24)}`;
  const segments = [seg('old', 'tool', 0, `log ${key}\n${log('o', 40)}`), seg('cur', 'user', 9, 'now')];
  const input = compress.normalize({ window: Math.ceil(tokensOf(segments) / 0.7), segments, goal: 'use password: hunter2hunter2' });
  const p = planOrFail(input);
  const wire = JSON.stringify(p.state);
  assert.ok(!wire.includes(key), 'the key is not in the state');
  assert.ok(!wire.includes('hunter2'), 'the password is not in the state');
  assert.ok(wire.includes('[redacted]'));
  assert.equal(p.state.goal, 'use [redacted]');
});

test('summarize names the outcome in one line with counts and tokens only', () => {
  const line = compress.summarize({ compact: true, actions: { a: DROP, b: SUMMARIZE, c: KEEP }, tokensBefore: 1000, tokensAfter: 400 });
  assert.equal(line, 'compact: drop 1, summarize 1, keep 1; 1000 → 400 tokens');
  assert.equal(compress.summarize({ compact: false, actions: {}, tokensBefore: 120 }), 'no compaction: 120 tokens');
  assert.ok(!line.includes('\n'));
});

test('end to end through askLuna: one call, then the verdict compacts the largest segment', async () => {
  const segments = [seg('old', 'tool', 0, log('old')), seg('mid', 'assistant', 2, log('mid', 20)), seg('cur', 'user', 9, 'now')];
  const input = inputAt(segments, 0.7);
  const p = planOrFail(input);
  const fake = fakeLuna({ predicates: { compact_now: 0.9 }, choices: { g0: 'drop', g1: 'keep' } });
  const r = await askLuna(lunaOptions(CFG), p.state, p.questions, fake.transport);
  assert.equal(fake.calls.length, 1);
  const v = compress.interpret(answersByName(r), p.ctx, CFG);
  const fin = compress.finalize(v, input, CFG);
  assert.equal(fin.result.compact, true);
  assert.equal(fin.result.actions.old, DROP);
  assert.equal(fin.result.actions.mid, KEEP);
  assert.deepEqual(fin.result.segments.map((s) => s.id), ['mid', 'cur']);
});

test('the kind is frozen and deep-frozen inputs pass through every path unchanged', () => {
  assert.ok(Object.isFrozen(compress));
  const frozen = deepFreeze({ window: Math.ceil(tokensOf(bandSegments()) / 0.7), segments: bandSegments(), goal: 'fix it' });
  const input = compress.normalize(frozen);
  const p = planOrFail(input);
  const v = compress.interpret(answersFor(p.questions, { choose: () => DROP }), p.ctx, CFG);
  const fin = compress.finalize(compress.gate(v, compress.heuristic(input, CFG), input, CFG), input, CFG);
  assert.equal(fin.result.compact, true);
  assert.equal(compress.finalize(compress.heuristic(input, CFG), input, CFG).result.compact, true);
  for (const s of fin.result.segments) assert.ok(!Object.isFrozen(s), 'results are fresh objects');
});

test('segment ids that name object keys stay own data and do not reach the prototype', () => {
  const segments = [
    seg('__proto__', 'tool', 0, log('p', 30)),
    seg('constructor', 'tool', 3, log('c', 30)),
    seg('toString', 'user', 4, 'small'),
    seg('cur', 'user', 10, 'now'),
  ];
  const v = compress.heuristic(inputAt(segments, 0.7), CFG);
  assert.equal(Object.getPrototypeOf(v.result.actions), Object.prototype);
  assert.equal(Object.hasOwn(v.result.actions, '__proto__'), true);
  assert.equal(v.result.actions.__proto__, DROP);
  assert.equal(v.result.actions.constructor, DROP);
  assert.equal(v.result.actions.toString, KEEP);
  assert.equal(({}).drop, undefined);
});

test('config rejects maxSegmentsAsked 0, so plan never has nothing to ask above the hard limit', () => {
  assert.throws(() => cfgWith({ compress: { maxSegmentsAsked: 0 } }), /maxSegmentsAsked/);
  // plan's own guard stays for a hand-built config that skipped validation.
  const raw = { ...cfgWith({}), compress: { ...cfgWith({}).compress, maxSegmentsAsked: 0 } };
  assert.throws(() => compress.plan(inputAt(bandSegments(), 0.9), raw), /nothing to ask Luna/);
  const band = compress.plan(inputAt(bandSegments(), 0.7), raw);
  assert.deepEqual(band.questions.map((q) => q.name), ['compact_now']);
});
