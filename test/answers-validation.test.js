import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  answersByName, choiceAnswer, levelProbabilities, predicateProbability,
  scoreConfidence, scoreLevel, validateAnswers,
} from '../src/luna/answers.js';
import { createEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

const LABELS = ['low', 'medium', 'high'];
const VALUES = ['small', 'large'];
const score = (extra = {}) => ({ name: 'effort', type: 'score', ...extra });
const choice = (extra = {}) => ({ name: 'model', type: 'choice', choice: 'large', ...extra });
const named = (answer) => answersByName({ answers: [answer] });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const distributionNear = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => near(v, expected[i]));
};

test('answer names are required, unique and cannot use inherited object properties', () => {
  for (const body of [null, {}, { answers: null }, { answers: {} }]) {
    assert.throws(() => answersByName(body), /no answers array/);
  }
  for (const answer of [null, [], {}, { name: '' }, { name: '__proto__' }]) {
    assert.throws(() => answersByName({ answers: [answer] }), /valid question name/);
  }
  assert.throws(() => answersByName({ answers: [score(), score()] }), /duplicate answers for "effort"/);
  const out = named({ name: 'constructor', type: 'predicate', probability: 0.8 });
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'keep the public plain-object result shape');
  assert.equal(predicateProbability(out, 'constructor'), 0.8);
  assert.throws(() => predicateProbability({}, 'constructor'), /no predicate answer/);
});

test('valid score distributions keep their order across supported array and object formats', () => {
  const forms = [
    [0.1, 0.7, 0.2],
    [{ probability: 0.1 }, { probability: 0.7 }, { probability: 0.2 }],
    [{ value: 2, probability: 0.2 }, { value: 0, probability: 0.1 }, { value: 1, probability: 0.7 }],
    [{ label: 'high', probability: 0.2 }, { label: 'low', probability: 0.1 }, { label: 'medium', probability: 0.7 }],
    [{ value: 1, label: 'medium', probability: 0.7 }, { value: 2, label: 'high', probability: 0.2 }, { value: 0, label: 'low', probability: 0.1 }],
    { high: 0.2, low: 0.1, medium: 0.7 },
    { 2: 0.2, 0: 0.1, 1: 0.7 },
    { low: { probability: 0.1 }, medium: { value: 1, label: 'medium', probability: 0.7 }, high: { probability: 0.2 } },
  ];
  for (const probabilities of forms) {
    const answers = named(score({ score: 1.1, probabilities, confidence: 0.63 }));
    const parsed = scoreLevel(answers, 'effort', LABELS);
    assert.equal(parsed.level, 1);
    distributionNear(parsed.probs, [0.1, 0.7, 0.2]);
    assert.equal(scoreConfidence(answers, 'effort', parsed.probs), 0.63, 'explicit confidence is separate from the largest probability');
  }
});

test('malformed score distributions cannot be normalized into confident decisions', () => {
  const forms = [
    [-1, 0, 1], ['corrupt', 0, 0.01], [NaN, 0, 1], [Infinity, 0, 1], [0, 0, 1.1],
    [0, 0, 0], [0, 0, 0.01], [0.4, 0.4, 0.4], [0.5, 0.5], [0, 0, 1, 0],
    [], {}, null, '0,0,1',
    [{ value: 0, probability: 0.1 }, { value: 0, probability: 0.7 }, { value: 2, probability: 0.2 }],
    [{ value: 0, probability: 0.1 }, { value: 1, probability: 0.7 }, { value: 3, probability: 0.2 }],
    [{ value: false, probability: 0.1 }, { value: 1, probability: 0.7 }, { value: 2, probability: 0.2 }],
    [{ label: 'low', probability: 0.1 }, { label: 'low', probability: 0.7 }, { label: 'high', probability: 0.2 }],
    [{ label: 'low', probability: 0.1 }, { label: 'unknown', probability: 0.7 }, { label: 'high', probability: 0.2 }],
    [{ value: 0, label: 'high', probability: 0.1 }, { value: 1, probability: 0.7 }, { value: 2, probability: 0.2 }],
    [{ value: 0, probability: 0.1 }, 0.7, { value: 2, probability: 0.2 }],
    { low: 0.1, medium: 0.7 },
    { low: 0.1, medium: 0.7, high: 0.2, unknown: 0 },
    { low: 0.1, 0: 0, medium: 0.7, high: 0.2 },
    { low: { value: 2, probability: 0.1 }, medium: 0.7, high: 0.2 },
    { low: '0.1', medium: 0.7, high: 0.2 },
  ];
  for (const probabilities of forms) {
    assert.throws(() => scoreLevel(named(score({ probabilities, score: 2, confidence: 1 })), 'effort', LABELS), /invalid probabilities/);
  }
});

test('tiny probability rounding is tolerated without treating arbitrary weights as probabilities', () => {
  const probs = levelProbabilities(score({ probabilities: [0.1, 0.7, 0.20000001] }), LABELS);
  near(probs.reduce((sum, p) => sum + p, 0), 1);
  assert.ok(probs.every((p) => p >= 0 && p <= 1));
  assert.throws(() => levelProbabilities(score({ probabilities: [0.1, 0.7, 0.1] }), LABELS), /sum to 1/);
});

test('valid choice distributions support arrays and unambiguous legacy map forms', () => {
  const forms = [
    [{ value: 'large', probability: 0.8 }, { value: 'small', probability: 0.2 }],
    { small: 0.2, large: 0.8 },
    { small: { probability: 0.2 }, large: { value: 'large', probability: 0.8 } },
  ];
  for (const probabilities of forms) {
    const result = choiceAnswer(named(choice({ probabilities, confidence: 0.63 })), 'model', VALUES);
    assert.equal(result.choice, 'large');
    assert.equal(result.confidence, 0.63);
    distributionNear(result.probs, [0.2, 0.8]);
  }
});

test('choice values preserve boolean and string types', () => {
  const answers = named(choice({ choice: false, probabilities: [{ value: 'false', probability: 0.4 }, { value: false, probability: 0.6 }] }));
  const result = choiceAnswer(answers, 'model', [false, 'false']);
  assert.equal(result.choice, false);
  distributionNear(result.probs, [0.6, 0.4]);
  assert.throws(() => choiceAnswer(named(choice({ choice: false, probabilities: { false: 1 } })), 'model', [false, 'false']), /ambiguous choice key/);
});

test('malformed choice distributions never become an implicit confidence of one', () => {
  const forms = [
    [], {}, null, 'large', [0.2, 0.8],
    [{ value: 'large', probability: 0.01 }],
    [{ value: 'small', probability: '0.2' }, { value: 'large', probability: 0.8 }],
    [{ value: 'small', probability: -0.1 }, { value: 'large', probability: 1 }],
    [{ value: 'small', probability: 0.2 }, { value: 'small', probability: 0.8 }],
    [{ value: 'small', probability: 0.2 }, { value: 'unknown', probability: 0.8 }],
    { small: 0, large: 0.01 }, { small: 0, large: 0 }, { small: 0.2, large: 1.1 },
    { small: NaN, large: 0.8 }, { small: 0.2, large: 0.8, extra: 0 },
    { small: { value: 'large', probability: 0.2 }, large: 0.8 },
  ];
  for (const probabilities of forms) {
    assert.throws(() => choiceAnswer(named(choice({ probabilities, confidence: 1 })), 'model', VALUES), /invalid probabilities/);
  }
});

test('confidence must be a finite probability for choice and score, with or without distributions', () => {
  for (const confidence of [-0.1, 1.1, Infinity, NaN, '0.8', null, undefined]) {
    for (const extra of [{}, { probabilities: [0.1, 0.7, 0.2] }]) {
      const answers = named(score({ score: 1, ...extra, confidence }));
      assert.throws(() => scoreLevel(answers, 'effort', LABELS), /invalid confidence/);
      assert.throws(() => scoreConfidence(answers, 'effort', null), /invalid confidence/);
    }
    for (const extra of [{}, { probabilities: { small: 0.2, large: 0.8 } }]) {
      assert.throws(() => choiceAnswer(named(choice({ ...extra, confidence })), 'model', VALUES), /invalid confidence/);
    }
  }
  for (const confidence of [0, 1]) {
    assert.equal(choiceAnswer(named(choice({ confidence })), 'model', VALUES).confidence, confidence);
    assert.equal(scoreConfidence(named(score({ score: 1, confidence })), 'effort', null), confidence);
  }
});

test('score values must be in the level range instead of silently clamping invalid output', () => {
  for (const value of [-1, 3, 999, NaN, Infinity, '1', null, undefined]) {
    for (const extra of [{}, { probabilities: [0.1, 0.7, 0.2] }]) {
      assert.throws(() => scoreLevel(named(score({ score: value, ...extra })), 'effort', LABELS), /invalid score/);
    }
  }
  assert.deepEqual(scoreLevel(named(score({ score: 1.4 })), 'effort', LABELS), { level: 1, probs: null });
  assert.deepEqual(scoreLevel(named(score({ score: 2 })), 'effort', LABELS), { level: 2, probs: null });
  assert.throws(() => scoreLevel(named(score()), 'effort', LABELS), /without a value/);
});

test('omitted distributions retain the existing scalar and chosen-value fallback formats', () => {
  assert.equal(levelProbabilities(score({ score: 1 }), LABELS), null);
  const a = choiceAnswer(named(choice({ confidence: 0.8 })), 'model', VALUES);
  distributionNear(a.probs, [0.2, 0.8]);
  assert.equal(a.confidence, 0.8);
  assert.deepEqual(choiceAnswer(named(choice()), 'model', VALUES), { choice: 'large', probs: [0, 1], confidence: 1 });
});

test('batch validation checks all expected answers regardless of response order', () => {
  const questions = [
    { type: 'predicate', name: 'relevant', instructions: 'Is it relevant?' },
    { type: 'choice', name: 'model', instructions: 'Which model?', choices: VALUES.map((value) => ({ value })) },
  ];
  const good = [choice({ confidence: 0.8 }), { type: 'predicate', name: 'relevant', probability: 0.6 }];
  validateAnswers({ answers: good }, questions);
  assert.throws(() => validateAnswers({ answers: good.slice(0, 1) }, questions), /no predicate answer for "relevant"/);
  assert.throws(() => validateAnswers({ answers: [...good, { type: 'predicate', name: 'extra', probability: 1 }] }, questions), /unexpected answer/);
  assert.throws(() => validateAnswers({ answers: [...good, good[0]] }, questions), /duplicate answers/);
  assert.throws(() => validateAnswers({ answers: [good[0], { type: 'refusal', name: 'relevant' }] }, questions), /refused "relevant"/);
});

test('malformed high-confidence replies fall back in auto and fail in strict mode while retaining metered usage', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-invalid-answers-'));
  try {
    const makeConfig = (mode) => loadConfig({ env: { LUNA_CORE_HOME: home }, cwd: home, overrides: { mode, minConfidence: 0.9, ledger: { enabled: false } } });
    const transport = async (opts, state) => ({
      answers: [
        { name: 'model', type: 'choice', choice: state.models[0].id, confidence: 2 },
        { name: 'effort', type: 'score', score: 999, confidence: 2 },
      ],
      usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 0 } },
    });
    const auto = await createEngine({ config: makeConfig('auto'), transport }).route({ task: 'rename one local variable' });
    assert.equal(auto.source, 'rules');
    assert.match(auto.error, /invalid confidence/);
    assert.equal(auto.confidence, null);
    assert.equal(auto.calls, 1);
    near(auto.cost, 500 * 0.1 / 1e6);
    const strict = createEngine({ config: makeConfig('luna'), transport });
    await assert.rejects(strict.route({ task: 'rename one local variable' }), /invalid confidence/);
    assert.equal(strict.stats().lunaCalls, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
