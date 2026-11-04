import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { route, eligibleModels, clampEffort } from '../src/domains/route.js';
import { loadConfig, lunaOptions } from '../src/config.js';
import { askLuna } from '../src/luna/client.js';
import { answersByName } from '../src/luna/answers.js';
import { fakeLuna, choice, score } from './helpers/fakeLuna.js';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const HARD = 'refactor the loader';
const PLAIN = 'add a --json option to the stats command';

// A config loaded from a throw-away folder; the folder is removed before returning.
function makeCfg(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-test-'));
  try {
    return loadConfig({ env: { LUNA_CORE_HOME: dir }, cwd: dir, overrides });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function model(id, tier, extra = {}) {
  return {
    id, tier, contextWindow: 200000, capabilities: ['tools'], local: false,
    efforts: ALL_EFFORTS, strengths: `${id} strengths`, ...extra,
  };
}

const cfgWith = (models, extra = {}) => makeCfg({ route: { models, ...extra } });
const cfg = makeCfg();

// Answers keyed by name. `model` maps value -> probability; `effort` is a distribution over the
// default ladder (low, medium, high, xhigh, max).
function answersFor({ model: modelProbs, effort, confidences = {} } = {}) {
  return answersByName({
    answers: [
      ...(modelProbs ? [choice('model', modelProbs, confidences.model)] : []),
      score('effort', effort, confidences.effort),
    ],
  });
}

const HAIKU_FIRST = { [HAIKU]: 0.8, [SONNET]: 0.1, [OPUS]: 0.1 };
const OPUS_HEAVY = { [HAIKU]: 0.05, [SONNET]: 0.05, [OPUS]: 0.9 };
const LOW_EFFORT = [0.6, 0.3, 0.1, 0, 0];
const MAX_EFFORT = [0, 0, 0, 0, 1];
const failed = (command) => ({ kind: 'verify', command, failed: true });
// The (effort, model) pair of a result, for compact assertions.
const pick = (result) => [result.effort, result.model];

test('normalize rejects a non-object, an empty task and malformed steps with TypeError', () => {
  assert.throws(() => route.normalize(null, cfg), { name: 'TypeError', message: /route: input must be an object/ });
  assert.throws(() => route.normalize({ task: '   ' }, cfg), { name: 'TypeError', message: /route: task must be a non-empty string/ });
  assert.throws(() => route.normalize({ task: 'x', steps: [{ kind: 'jump', command: 'ls', failed: null }] }, cfg), { name: 'TypeError', message: /steps\[0\]\.kind/ });
  assert.throws(() => route.normalize({ task: 'x', steps: [{ kind: 'exec', command: 'ls', failed: 'yes' }] }, cfg), { name: 'TypeError', message: /steps\[0\]\.failed/ });
  assert.throws(() => route.normalize({ task: 'x', steps: [{ kind: 'exec', failed: false }] }, cfg), { name: 'TypeError', message: /command must be a string/ });
  assert.throws(() => route.normalize({ task: 'x', contextTokens: -1 }, cfg), { name: 'TypeError', message: /contextTokens/ });
  assert.throws(() => route.normalize({ task: 'x', requires: 'tools' }, cfg), { name: 'TypeError', message: /requires must be an array/ });
  assert.throws(() => route.normalize({ task: 'x', localOnly: 'yes' }, cfg), { name: 'TypeError', message: /localOnly must be a boolean/ });
});

test('normalize rejects an unknown candidate with TypeError', () => {
  assert.throws(() => route.normalize({ task: 'x', candidates: [HAIKU, 'gpt-9'] }, cfg), { name: 'TypeError', message: /unknown candidate "gpt-9"/ });
});

test('normalize throws when no model is eligible, by context, capability, locality or candidates', () => {
  const noModel = (extra) => assert.throws(
    () => route.normalize({ task: 'x', ...extra }, cfg),
    { name: 'Error', message: /^route: no eligible model \(/ },
  );
  noModel({ contextTokens: 166667 });   // 166667 x 1.2 is above the 200000 window
  noModel({ requires: ['audio'] });     // no default model has audio
  noModel({ localOnly: true });         // the default models are all cloud models
  noModel({ candidates: [] });
});

test('eligibleModels applies the context headroom boundary and returns models in tier order', () => {
  const ids = (input, c = cfg) => eligibleModels(input, c).map((m) => m.id);
  assert.deepEqual(ids({ task: 'x' }), [HAIKU, SONNET, OPUS]);
  assert.deepEqual(ids({ task: 'x', contextTokens: 166666 }), [HAIKU, SONNET, OPUS]); // 199999.2 rounds up to 200000
  assert.deepEqual(ids({ task: 'x', contextTokens: 166667 }), []);
  assert.deepEqual(ids({ task: 'x', candidates: [OPUS, HAIKU] }), [HAIKU, OPUS]);
});

test('eligibleModels filters by capability and locality, sorted by tier then id', () => {
  const c = cfgWith([
    model('zeta', 2),
    model('alpha', 2, { capabilities: ['tools', 'vision'] }),
    model('local-small', 1, { local: true }),
  ]);
  const ids = (input) => eligibleModels(input, c).map((m) => m.id);
  assert.deepEqual(ids({ task: 'x' }), ['local-small', 'alpha', 'zeta']);
  assert.deepEqual(ids({ task: 'x', requires: ['vision'] }), ['alpha']);
  assert.deepEqual(ids({ task: 'x', localOnly: true }), ['local-small']);
  assert.deepEqual(ids({ task: 'x', localOnly: true, requires: ['vision'] }), []);
});

test('normalize returns a new object and never changes the input', () => {
  const steps = Object.freeze([Object.freeze({ kind: 'edit', command: 'a.js', failed: false })]);
  const input = Object.freeze({ task: '  refactor the loader  ', steps, requires: Object.freeze(['tools']) });
  const before = structuredClone(input);
  const out = route.normalize(input, cfg);
  assert.notEqual(out, input);
  assert.equal(out.task, 'refactor the loader');
  assert.notEqual(out.steps, steps);
  assert.deepEqual(out.steps, [{ kind: 'edit', command: 'a.js', failed: false }]);
  assert.deepEqual(input, before);
});

test('plan with one eligible model asks only the effort score, with the ladder as levels', () => {
  const input = route.normalize({ task: 'rename a variable', candidates: [SONNET] }, cfg);
  const p = route.plan(input, cfg);
  assert.deepEqual(p.questions.map((q) => q.name), ['effort']);
  assert.equal(p.questions[0].type, 'score');
  assert.deepEqual(p.questions[0].levels.map((l) => l.label), cfg.ladder);
  assert.match(p.questions[0].levels[0].description, /^routine:/);
  assert.deepEqual(p.ctx.eligible.map((m) => m.id), [SONNET]);
  assert.equal(p.state.failures_in_a_row, 0);
  assert.deepEqual(p.state.recent_steps, []);
});

test('plan with several eligible models asks a model choice in tier order with descriptions', () => {
  const p = route.plan(route.normalize({ task: HARD }, cfg), cfg);
  assert.deepEqual(p.questions.map((q) => q.name), ['model', 'effort']);
  const [choiceQuestion] = p.questions;
  assert.equal(choiceQuestion.type, 'choice');
  assert.deepEqual(choiceQuestion.choices.map((c) => c.value), [HAIKU, SONNET, OPUS]);
  assert.equal(choiceQuestion.choices[0].description, 'tier 1: fast and cheap: lookups, routine edits, worker tasks');
  assert.deepEqual(p.state.models.map((m) => m.id), [HAIKU, SONNET, OPUS]);
});

test('plan state keeps the last 8 steps with excerpts and statuses, and redacts secrets', () => {
  const long = 'x'.repeat(300);
  const steps = Array.from({ length: 10 }, (_, i) => ({ kind: 'exec', command: `run ${i} ${long}`, failed: [true, false, null][i % 3] }));
  steps.push({ kind: 'verify', command: 'curl -d token=abcdefgh123', failed: true });
  const task = `refactor the loader, password: hunter2hunter2 ${'y'.repeat(2500)}`;
  const { state } = route.plan(route.normalize({ task, steps }, cfg), cfg);
  assert.equal(state.recent_steps.length, 8);
  assert.equal(state.recent_steps[0].command.length, 160);
  assert.ok(state.recent_steps[0].command.endsWith('…'));
  assert.deepEqual(state.recent_steps.at(-1), { kind: 'verify', command: 'curl -d [redacted]', status: 'failed' });
  assert.deepEqual(state.recent_steps.slice(0, 3).map((s) => s.status), ['failed', 'ok', 'pending']);
  assert.equal(state.failures_in_a_row, 2);
  assert.equal(state.task.length, 2000);
  assert.ok(state.task.includes('[redacted]') && !state.task.includes('hunter2'));
});

test('interpret picks the model at the modelQuantile of the tier-ordered distribution, not its argmax', () => {
  const p = route.plan(route.normalize({ task: HARD }, cfg), cfg);
  const answers = answersFor({ model: { [HAIKU]: 0.2, [SONNET]: 0.3, [OPUS]: 0.5 }, effort: [0, 0, 1, 0, 0] });
  const median = route.interpret(answers, p.ctx, cfg);
  assert.equal(median.result.model, SONNET);
  assert.deepEqual(median.result.fallbackChain, [OPUS]);
  assert.ok(Math.abs(median.result.modelProbabilities[OPUS] - 0.5) < 1e-9);
  assert.equal(route.interpret(answers, p.ctx, makeCfg({ route: { modelQuantile: 0.9 } })).result.model, OPUS);
  assert.equal(route.interpret(answers, p.ctx, makeCfg({ route: { modelQuantile: 0.1 } })).result.model, HAIKU);
});

test('interpret takes the effort at the effortQuantile of the ladder distribution', () => {
  const p = route.plan(route.normalize({ task: HARD, candidates: [SONNET] }, cfg), cfg);
  const answers = answersFor({ effort: [0, 0.2, 0.5, 0.2, 0.1] });
  const median = route.interpret(answers, p.ctx, cfg);
  assert.equal(median.result.effort, 'high');
  assert.equal(median.result.modelProbabilities, null);
  assert.ok(Math.abs(median.result.effortProbabilities.high - 0.5) < 1e-9);
  assert.equal(route.interpret(answers, p.ctx, makeCfg({ route: { effortQuantile: 0.95 } })).result.effort, 'max');
  // A level with no weight is never picked, even at quantile 0.
  assert.equal(route.interpret(answers, p.ctx, makeCfg({ route: { effortQuantile: 0 } })).result.effort, 'medium');
});

test('interpret clamps the effort to the model efforts, and clampEffort breaks ties upward', () => {
  const small = cfgWith([model('small', 1, { efforts: ['low', 'medium', 'high'] })]);
  const p = route.plan(route.normalize({ task: HARD, candidates: ['small'] }, small), small);
  const v = route.interpret(answersFor({ effort: MAX_EFFORT }), p.ctx, small);
  assert.equal(v.result.effort, 'high');
  assert.ok(v.reasons.some((r) => r.includes('clamped to high')));
  assert.equal(clampEffort('max', ['low', 'medium', 'high']), 'high');
  assert.equal(clampEffort('medium', ['low', 'high']), 'high');   // equal distance: upward
  assert.equal(clampEffort('high', ['medium', 'xhigh']), 'xhigh'); // equal distance: upward
  assert.equal(clampEffort('low', ['high', 'max']), 'high');
  assert.equal(clampEffort('xhigh', []), 'xhigh');                 // no declared efforts: not clamped
  assert.throws(() => clampEffort('ultra', ['low']), { name: 'TypeError', message: /unknown effort/ });
});

test('interpret confidence is the lower of model and effort confidence; effort alone with one model', () => {
  const p = route.plan(route.normalize({ task: HARD }, cfg), cfg);
  const answers = answersFor({
    model: HAIKU_FIRST,
    effort: LOW_EFFORT,
    confidences: { model: 0.55, effort: 0.9 },
  });
  assert.equal(route.interpret(answers, p.ctx, cfg).confidence, 0.55);
  const single = route.plan(route.normalize({ task: HARD, candidates: [SONNET] }, cfg), cfg);
  const alone = answersFor({ effort: LOW_EFFORT, confidences: { effort: 0.7 } });
  assert.equal(route.interpret(alone, single.ctx, cfg).confidence, 0.7);
});

test('interpret throws on a refused effort, a missing model answer and an unknown choice', () => {
  const p = route.plan(route.normalize({ task: HARD }, cfg), cfg);
  const refused = answersByName({ answers: [{ type: 'refusal', name: 'effort' }, choice('model', HAIKU_FIRST)] });
  assert.throws(() => route.interpret(refused, p.ctx, cfg), /refused "effort"/);
  assert.throws(() => route.interpret(answersFor({ effort: LOW_EFFORT }), p.ctx, cfg), /no choice answer for "model"/);
  const unknown = answersByName({ answers: [choice('model', { 'gpt-9': 1 }), score('effort', LOW_EFFORT)] });
  assert.throws(() => route.interpret(unknown, p.ctx, cfg), /unknown choice for "model"/);
  const noEffort = answersByName({ answers: [choice('model', HAIKU_FIRST)] });
  assert.throws(() => route.interpret(noEffort, p.ctx, cfg), /no score answer for "effort"/);
});

test('plan, askLuna through a fake transport and interpret give a verdict in one batch', async () => {
  const input = route.normalize({ task: HARD }, cfg);
  const p = route.plan(input, cfg);
  const fake = fakeLuna({
    choices: { model: { [HAIKU]: 0.1, [SONNET]: 0.2, [OPUS]: 0.7 } },
    scores: { effort: [0, 0, 0.1, 0.6, 0.3] },
    confidences: { model: 0.8, effort: 0.9 },
  });
  const r = await askLuna(lunaOptions(cfg), { kind: 'route', ...p.state }, p.questions, fake.transport);
  const v = route.interpret(answersByName(r), p.ctx, cfg);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].questions.length, 2);
  assert.deepEqual([v.result.model, v.result.effort], [OPUS, 'xhigh']);
  assert.deepEqual(v.result.fallbackChain, []);
  assert.equal(v.confidence, 0.8);
});

test('heuristic: a greeting gets the lowest level and the first eligible model', () => {
  const v = route.heuristic(route.normalize({ task: 'thanks' }, cfg), cfg);
  assert.equal(v.result.effort, 'low');
  assert.equal(v.result.model, HAIKU);
  assert.equal(v.confidence, null);
  assert.equal(v.reasons[0], 'greeting');
  assert.equal(v.result.modelProbabilities, null);
  assert.equal(v.result.effortProbabilities, null);
});

test('heuristic: a plain, a hard and a long task get medium, high and high on the right models', () => {
  const run = (task) => route.heuristic(route.normalize({ task }, cfg), cfg).result;
  assert.deepEqual(pick(run(PLAIN)), ['medium', HAIKU]);
  assert.deepEqual(pick(run(HARD)), ['high', SONNET]);
  assert.deepEqual(pick(run(`please look at this ${'word '.repeat(130)}`)), ['high', SONNET]); // over 600 characters
  assert.deepEqual(pick(run('explain how the cache works')), ['high', SONNET]); // a deep question
});

test('heuristic: failure streaks of 1, 2 and 3 raise the level; three in a row takes the top model', () => {
  const run = (steps) => route.heuristic(route.normalize({ task: PLAIN, steps }, cfg), cfg).result;
  assert.deepEqual(pick(run([failed('npm run lint')])), ['medium', HAIKU]);
  assert.deepEqual(pick(run([failed('npm run lint'), failed('npm test')])), ['high', SONNET]);
  assert.deepEqual(pick(run([failed('a'), failed('b'), failed('c')])), ['max', OPUS]);
  const first = route.heuristic(route.normalize({ task: PLAIN, steps: [failed('npm run lint')] }, cfg), cfg);
  assert.equal(first.reasons[0], 'first failure; routine task');
});

test('heuristic: the same failing command twice in the last six steps counts as stuck', () => {
  const steps = [failed('npm  test'), { kind: 'edit', command: 'src/a.js', failed: false }, failed('npm test')];
  const v = route.heuristic(route.normalize({ task: PLAIN, steps }, cfg), cfg);
  assert.deepEqual(pick(v.result), ['max', OPUS]);
  assert.ok(v.reasons.includes('the same failing command repeated'));
  // Seven steps back, outside the window of six, the earlier failure does not count.
  const reads = (n) => Array.from({ length: n }, () => ({ kind: 'read', command: 'ls', failed: false }));
  const old = [...reads(1), failed('npm test'), ...reads(5), failed('npm test')];
  assert.deepEqual(pick(route.heuristic(route.normalize({ task: PLAIN, steps: old }, cfg), cfg).result), ['medium', HAIKU]);
  // Exactly at the edge of the window (the sixth-last step) it still counts.
  const edge = [{ kind: 'read', command: 'ls', failed: false }, { kind: 'read', command: 'ls', failed: false }, failed('npm test'),
    ...Array.from({ length: 4 }, () => ({ kind: 'read', command: 'ls', failed: false })), failed('npm test')];
  assert.deepEqual(pick(route.heuristic(route.normalize({ task: PLAIN, steps: edge }, cfg), cfg).result), ['max', OPUS]);
});

test('gate raises a Luna answer to the rules model and effort after a failure (luna+rules)', () => {
  const input = route.normalize({ task: HARD, steps: [failed('npm test')] }, cfg);
  const p = route.plan(input, cfg);
  const luna = route.interpret(answersFor({ model: HAIKU_FIRST, effort: LOW_EFFORT, confidences: { model: 0.8, effort: 0.9 } }), p.ctx, cfg);
  assert.deepEqual(pick(luna.result), ['low', HAIKU]);
  const rules = route.heuristic(input, cfg);
  const g = route.gate(luna, rules, input, cfg);
  assert.equal(g.source, 'luna+rules');
  assert.deepEqual(pick(g.result), ['high', SONNET]);
  assert.deepEqual(g.result.fallbackChain, [OPUS]);
  assert.equal(g.confidence, luna.confidence);
  assert.ok(g.reasons.at(-1).startsWith('failure streak 1'));
});

test('gate takes the higher tier and the higher effort independently', () => {
  const input = route.normalize({ task: HARD, steps: [failed('npm test')] }, cfg);
  const p = route.plan(input, cfg);
  const luna = route.interpret(answersFor({ model: OPUS_HEAVY, effort: LOW_EFFORT }), p.ctx, cfg);
  assert.deepEqual(pick(luna.result), ['low', OPUS]);
  const g = route.gate(luna, route.heuristic(input, cfg), input, cfg);
  assert.equal(g.source, 'luna+rules');
  assert.deepEqual(pick(g.result), ['high', OPUS]);
});

test('gate keeps Luna without a failure streak, and returns Luna unchanged when it is already as high', () => {
  const input = route.normalize({ task: HARD }, cfg);
  const p = route.plan(input, cfg);
  const luna = route.interpret(answersFor({ model: HAIKU_FIRST, effort: LOW_EFFORT }), p.ctx, cfg);
  assert.equal(route.gate(luna, route.heuristic(input, cfg), input, cfg), luna);

  const failing = route.normalize({ task: HARD, steps: [failed('npm test')] }, cfg);
  const strong = route.interpret(answersFor({ model: OPUS_HEAVY, effort: MAX_EFFORT }), route.plan(failing, cfg).ctx, cfg);
  const kept = route.gate(strong, route.heuristic(failing, cfg), failing, cfg);
  assert.equal(kept, strong);
  assert.notEqual(kept.source, 'luna+rules');
});

test('summarize is one line without the task text, and the module object is frozen', () => {
  assert.equal(route.summarize({ model: SONNET, effort: 'high' }), 'claude-sonnet-5-5 effort=high');
  assert.ok(Object.isFrozen(route));
  assert.equal(route.name, 'route');
  for (const fn of ['normalize', 'plan', 'interpret', 'heuristic', 'gate', 'summarize']) {
    assert.equal(typeof route[fn], 'function', fn);
  }
});

test('plan, interpret, heuristic and gate never mutate their inputs or verdicts', () => {
  const input = route.normalize({
    task: HARD, steps: [failed('npm test')], requires: ['tools'], candidates: [HAIKU, SONNET, OPUS],
  }, cfg);
  const snapshot = structuredClone(input);
  const p = route.plan(input, cfg);
  const luna = route.interpret(answersFor({ model: HAIKU_FIRST, effort: LOW_EFFORT }), p.ctx, cfg);
  const rules = route.heuristic(input, cfg);
  const frozenCopies = structuredClone([luna, rules]);
  route.gate(luna, rules, input, cfg);
  assert.deepEqual(input, snapshot);
  assert.deepEqual([luna, rules], frozenCopies);
});
