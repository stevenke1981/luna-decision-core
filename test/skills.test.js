import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skills, LEXICAL_RATIO, LEXICAL_MIN } from '../src/domains/skills.js';
import { loadConfig } from '../src/config.js';
import { askLuna } from '../src/luna/client.js';
import { answersByName } from '../src/luna/answers.js';
import { fakeLuna, predicate } from './helpers/fakeLuna.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-skills-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function cfgWith(overrides) {
  return loadConfig({ env: { LUNA_CORE_HOME: HOME }, cwd: HOME, overrides });
}
const cfg = cfgWith();
const norm = (input, c = cfg) => skills.normalize(input, c);
const names = (result) => result.selected.map((s) => s.name);
const forcedNamesOf = (out) => ('settled' in out ? names(out.settled.result) : out.ctx.forced.map((s) => s.name));

const CATALOG = [
  { name: 'testing', description: 'Write unit tests and test suites for a module.', path: '/skills/testing/SKILL.md' },
  { name: 'tdd-workflow', description: 'Test driven development: red, green, refactor.', path: '/skills/tdd-workflow/SKILL.md' },
  { name: 'deploy-helper', description: 'Deploy the service to production hosts.' },
  { name: 'docs-writer', description: 'Write documentation, guides and readme files.' },
];

// Four skills that all match the word "tests"; alpha is the one the task can force.
const WIDE = [
  { name: 'alpha-tests', description: 'tests for the parser', path: '/s/alpha/SKILL.md' },
  { name: 'beta-tests', description: 'tests for the lexer' },
  { name: 'gamma-tests', description: 'tests for the server' },
  { name: 'delta-tests', description: 'tests for the cli' },
];

// "sql joins query planner" hits sql-joins strongly and query-planner-guide within the ratio, but
// sql-schema and css-grid fall outside it.
const LEX = [
  { name: 'sql-joins', description: 'sql joins and query planner' },
  { name: 'query-planner-guide', description: 'joins query sql planner indexes guide' },
  { name: 'sql-schema', description: 'sql schema notes' },
  { name: 'css-grid', description: 'css layout grid' },
];

test('normalize rejects bad input with a TypeError that names the kind', () => {
  const bad = [
    [null, /input must be an object/],
    [{ task: '   ' }, /task must be a non-empty string/],
    [{ task: 'x', maxSkills: 0 }, /maxSkills must be a positive integer/],
    [{ task: 'x', catalog: 'nope' }, /catalog must be an array/],
    [{ task: 'x', catalog: [{ description: 'no name' }] }, /catalog\[0\]\.name/],
    [{ task: 'x', catalog: [{ name: 'a', description: 3 }] }, /description must be a string/],
    [{ task: 'x', catalog: [{ name: 'same' }, { name: 'same' }] }, /duplicate skill name "same"/],
    [{ task: 'x', dirs: 'skills' }, /dirs must be an array/],
  ];
  for (const [input, re] of bad) {
    assert.throws(() => norm(input), (err) => err instanceof TypeError && re.test(err.message) && err.message.startsWith('skills: '));
  }
});

test('normalize returns a new object with defaults applied and leaves its input alone', () => {
  const input = { task: '  write tests  ', catalog: structuredClone(CATALOG) };
  const before = structuredClone(input);
  const out = norm(input);
  assert.equal(out.task, 'write tests');
  assert.equal(out.maxSkills, cfg.skills.maxSkills);
  assert.equal(out.catalog[2].path, null);
  assert.notEqual(out.catalog, input.catalog);
  assert.equal(norm({ task: 'x', maxSkills: 5 }).maxSkills, 5);
  assert.deepEqual(input, before);
});

test('prepare loads the catalog only when the input carries none', async () => {
  const calls = [];
  const deps = { loadCatalog: (dirs) => { calls.push(dirs); return CATALOG; } };
  const withDirs = cfgWith({ skills: { dirs: ['/from/config'] } });
  const a = await skills.prepare(norm({ task: 'x' }, withDirs), withDirs, deps);
  assert.deepEqual(calls, [['/from/config']]);
  assert.equal(a.catalog.length, 4);
  const own = norm({ task: 'x', dirs: ['/own'] }, withDirs);
  await skills.prepare(own, withDirs, deps);
  assert.deepEqual(calls[1], ['/own']);
  const given = norm({ task: 'x', catalog: [] });
  const c = await skills.prepare(given, withDirs, deps);
  assert.equal(calls.length, 2, 'no loadCatalog call when a catalog is given');
  assert.deepEqual(c.catalog, []);
  assert.notEqual(c, given);
  await assert.rejects(skills.prepare(norm({ task: 'x' }), cfg, {}), /no catalog loader in deps/);
});

test('plan forces a skill named as /name, or a distinctive hyphenated name as a whole word, ignoring case', () => {
  const input = norm({ task: 'Use docs-writer, then /TESTING the parser', catalog: CATALOG });
  const out = skills.heuristic(input, cfg);
  assert.deepEqual(names(out.result), ['testing', 'docs-writer']);
  assert.deepEqual(out.result.selected.map((s) => [s.reason, s.probability]), [['forced', null], ['forced', null]]);
  assert.equal(out.result.selected[0].path, '/skills/testing/SKILL.md');
  assert.equal(out.result.selected[1].path, null);

  const planned = skills.plan(norm({ task: 'use /docs-writer and write tests', catalog: CATALOG }), cfg);
  assert.deepEqual(planned.ctx.forced.map((s) => s.name), ['docs-writer']);
  assert.deepEqual(planned.ctx.shortlist.map((s) => s.name), ['testing']);
});

test('plan matches names with regex characters literally', () => {
  const catalog = [
    { name: 'next.js', description: 'next framework' },
    { name: 'ts+js', description: 'mixed' },
    { name: 'cv[draft]', description: 'draft cv' },
  ];
  const forced = (task) => forcedNamesOf(skills.plan(norm({ task, catalog }), cfg));
  assert.deepEqual(forced('build with /next.js and /ts+js'), ['next.js', 'ts+js']);
  assert.deepEqual(forced('/nextXjs and /tsXjs and /nextjs'), []);
  assert.deepEqual(forced('fill /cv[draft] now'), ['cv[draft]']);
  assert.deepEqual(forced('fill /cvXdraftX now'), []);
  assert.deepEqual(forced('build with next.js'), [], 'a plain name written bare is left to Luna');
});

test('plan does not force names shorter than 4 characters or names inside a longer word', () => {
  const catalog = [
    { name: 'ui', description: 'interface' },
    { name: 'testing', description: 'tests' },
    { name: 'deploy-helper', description: 'ship' },
  ];
  assert.deepEqual(forcedNamesOf(skills.plan(norm({ task: '/ui testing-utils deploy-helpers src/testing/x.js', catalog }), cfg)), []);
  assert.deepEqual(forcedNamesOf(skills.plan(norm({ task: 'ui testing.md', catalog }), cfg)), [], 'a plain word in prose is not forced');
  assert.deepEqual(forcedNamesOf(skills.plan(norm({ task: 'run /testing then deploy-helper', catalog }), cfg)), ['testing', 'deploy-helper']);
});

test('plan shortlists by BM25 without forced skills, caps the shortlist and asks one predicate per skill', () => {
  const out = skills.plan(norm({ task: 'use /docs-writer and write tests', catalog: CATALOG }), cfg);
  assert.ok(!('settled' in out));
  assert.deepEqual(out.state, {
    task: 'use /docs-writer and write tests',
    skills: [{ id: 's0', name: 'testing', description: 'Write unit tests and test suites for a module.' }],
  });
  assert.deepEqual(out.questions, [{ type: 'predicate', name: 's0', instructions: 'Should skill s0 ("testing") be loaded for this task?' }]);

  const capped = skills.plan(norm({ task: 'tests tests for the server', catalog: WIDE }), cfgWith({ skills: { shortlist: 2 } }));
  assert.deepEqual(capped.questions.map((q) => q.name), ['s0', 's1']);
  assert.equal(capped.state.skills.length, 2);

  const longDescription = [{ name: 'verbose', description: 'tests '.repeat(200) }];
  const long = skills.plan(norm({ task: 'tests', catalog: longDescription }), cfg);
  assert.equal(long.state.skills[0].description.length, 300);
  assert.ok(long.state.skills[0].description.endsWith('…'));
  const longTask = skills.plan(norm({ task: `tests ${'x '.repeat(1500)}`, catalog: WIDE }), cfg);
  assert.equal(longTask.state.task.length, 2000);
});

test('plan settles without a Luna call when no skill is shortlisted, keeping the forced ones', () => {
  const empty = skills.plan(norm({ task: 'write tests', catalog: [] }), cfg);
  assert.deepEqual(empty.settled.result, { selected: [], considered: 0 });
  assert.equal(empty.settled.confidence, null);
  assert.deepEqual(empty.settled.reasons, ['catalog is empty']);

  const none = skills.plan(norm({ task: 'quantum gardening', catalog: CATALOG }), cfg);
  assert.deepEqual(none.settled.result, { selected: [], considered: 0 });
  assert.deepEqual(none.settled.reasons, ['no skill shares a term with the task']);

  const forcedOnly = skills.plan(norm({ task: 'only /testing here', catalog: CATALOG }), cfg);
  assert.deepEqual(names(forcedOnly.settled.result), ['testing']);
  assert.equal(forcedOnly.settled.result.selected[0].reason, 'forced');
});

test('interpret takes forced skills first, then p >= threshold by p desc, capped at maxSkills', () => {
  const { ctx } = skills.plan(norm({ task: 'use /alpha-tests and write tests for the server', catalog: WIDE }), cfg);
  assert.equal(ctx.shortlist.length, 3);
  const answers = answersByName({ answers: [predicate('s0', 0.9), predicate('s1', 0.2), predicate('s2', 0.5)] });

  const v = skills.interpret(answers, ctx, cfg);
  assert.deepEqual(v.result.selected.map((s) => [s.name, s.reason, s.probability]), [
    ['alpha-tests', 'forced', null],
    [ctx.shortlist[0].name, 'luna', 0.9],
    [ctx.shortlist[2].name, 'luna', 0.5],
  ]);
  assert.equal(v.result.considered, 3);
  assert.deepEqual(v.reasons, ['forced: alpha-tests', `luna: ${ctx.shortlist[0].name}`, `luna: ${ctx.shortlist[2].name}`]);

  const capped = skills.plan(norm({ task: 'use /alpha-tests and write tests for the server', catalog: WIDE, maxSkills: 2 }), cfg);
  assert.deepEqual(names(skills.interpret(answers, capped.ctx, cfg).result), ['alpha-tests', ctx.shortlist[0].name]);

  // The cap counts forced skills too, so a limit of one keeps only the forced one.
  const one = skills.plan(norm({ task: 'use /alpha-tests and write tests for the server', catalog: WIDE, maxSkills: 1 }), cfg);
  assert.deepEqual(names(skills.interpret(answers, one.ctx, cfg).result), ['alpha-tests']);

  const strict = skills.interpret(answers, ctx, cfgWith({ skills: { threshold: 0.95 } }));
  assert.deepEqual(names(strict.result), ['alpha-tests']);
});

test('interpret confidence is the mean certainty of the shortlist predicates', () => {
  const { ctx } = skills.plan(norm({ task: 'write tests for the server', catalog: WIDE }), cfg);
  assert.equal(ctx.shortlist.length, 4);
  const answers = answersByName({
    answers: [predicate('s0', 0.4), predicate('s1', 0.9), predicate('s2', 0.6), predicate('s3', 0.7)],
  });
  const v = skills.interpret(answers, ctx, cfg);
  assert.ok(Math.abs(v.confidence - (0.6 + 0.9 + 0.6 + 0.7) / 4) < 1e-12);
  assert.deepEqual(names(v.result), [ctx.shortlist[1].name, ctx.shortlist[3].name, ctx.shortlist[2].name]);
});

test('interpret throws on a missing, refused, mistyped or out-of-range answer', () => {
  const { ctx } = skills.plan(norm({ task: 'write tests for the server', catalog: WIDE }), cfg);
  const ok = [0, 1, 2, 3].map((i) => predicate(`s${i}`, 0.5));
  const cases = [
    [ok.slice(1), /no predicate answer for "s0"/],
    [[...ok.slice(0, 3), { type: 'refusal', name: 's3' }], /refused "s3"/],
    [[...ok.slice(0, 3), { type: 'choice', name: 's3', choice: 'x', probabilities: [] }], /no predicate answer for "s3"/],
    [[...ok.slice(0, 3), predicate('s3', 1.5)], /no probability for "s3"/],
  ];
  for (const [list, re] of cases) {
    assert.throws(() => skills.interpret(answersByName({ answers: list }), ctx, cfg), re);
  }
});

test('heuristic keeps the lexical leaders: best hit at LEXICAL_MIN, hits within LEXICAL_RATIO of it', () => {
  assert.equal(LEXICAL_RATIO, 0.6);
  assert.equal(LEXICAL_MIN, 2.0);
  const leaders = skills.heuristic(norm({ task: 'sql joins query planner', catalog: LEX }), cfg);
  assert.deepEqual(names(leaders.result), ['sql-joins', 'query-planner-guide']);
  assert.deepEqual(leaders.result.selected.map((s) => s.reason), ['lexical', 'lexical']);
  assert.equal(leaders.confidence, null);

  // css alone scores about 1.1, under LEXICAL_MIN, so nothing is picked by the rules.
  const weak = skills.heuristic(norm({ task: 'css', catalog: LEX }), cfg);
  assert.deepEqual(weak.result.selected, []);
  assert.equal(weak.result.considered, 1);

  const capped = skills.heuristic(norm({ task: 'sql joins query planner', catalog: LEX, maxSkills: 1 }), cfg);
  assert.deepEqual(names(capped.result), ['sql-joins']);
});

test('heuristic and interpret return the same result shape', () => {
  const task = 'use /alpha-tests and write tests for the server';
  const { ctx } = skills.plan(norm({ task, catalog: WIDE }), cfg);
  const answers = answersByName({ answers: [predicate('s0', 0.9), predicate('s1', 0.9), predicate('s2', 0.9)] });
  const h = skills.heuristic(norm({ task, catalog: WIDE }), cfg).result;
  const i = skills.interpret(answers, ctx, cfg).result;
  assert.deepEqual(Object.keys(h), Object.keys(i));
  assert.deepEqual(Object.keys(h.selected[0]), ['name', 'path', 'probability', 'reason']);
  assert.deepEqual(Object.keys(i.selected[0]), Object.keys(h.selected[0]));
});

test('summarize names the selected skills and the number considered', () => {
  assert.equal(
    skills.summarize({ selected: [{ name: 'a' }, { name: 'b' }], considered: 5 }),
    'skills: 2 selected (a, b), 5 considered',
  );
  assert.equal(skills.summarize({ selected: [], considered: 0 }), 'skills: 0 selected, 0 considered');
});

test('the module is frozen, and plan, heuristic and interpret leave their inputs unchanged', () => {
  assert.ok(Object.isFrozen(skills));
  assert.equal(skills.name, 'skills');
  assert.throws(() => { skills.name = 'other'; }, TypeError);
  assert.ok(Object.isFrozen(cfg.skills));

  const input = norm({ task: 'write tests for the server', catalog: structuredClone(WIDE) });
  const snapshot = structuredClone(input);
  const planned = skills.plan(input, cfg);
  skills.heuristic(input, cfg);
  assert.deepEqual(input, snapshot);

  const answers = answersByName({ answers: [0, 1, 2, 3].map((i) => predicate(`s${i}`, 0.7)) });
  const before = structuredClone(answers);
  skills.interpret(answers, planned.ctx, cfg);
  assert.deepEqual(answers, before);
});

test('the whole decision runs through askLuna and fakeLuna, and the state carries no paths', async () => {
  const input = norm({ task: 'write tests for the server and the parser', catalog: WIDE });
  const prepared = await skills.prepare(input, cfg, { loadCatalog: () => { throw new Error('not used'); } });
  const planned = skills.plan(prepared, cfg);
  const fake = fakeLuna({ predicates: (name) => ({ s0: 0.9, s1: 0.1, s2: 0.6, s3: 0.3 })[name] });
  const body = await askLuna(
    { url: 'http://test.invalid/v1/decisions', apiKey: 'test-key', model: 'test-model', timeoutMs: 1000 },
    { kind: 'skills', ...planned.state },
    planned.questions,
    fake.transport,
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].state.kind, 'skills');
  assert.equal(fake.calls[0].state.skills.length, 4);
  assert.ok(!JSON.stringify(fake.calls[0].state).includes('/s/alpha'), 'paths stay out of the state');

  const v = skills.interpret(answersByName(body), planned.ctx, cfg);
  assert.deepEqual(names(v.result), [planned.ctx.shortlist[0].name, planned.ctx.shortlist[2].name]);
  assert.equal(v.result.considered, 4);
});
