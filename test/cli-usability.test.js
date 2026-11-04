import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { main, EXIT, INPUT_LIMIT_BYTES } from '../src/cli.js';
import { fakeLuna } from './helpers/fakeLuna.js';

const KEY = 'sk-test-only-abcdefghijklmnopqrstuvwxyz123456';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-usability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    home: path.join(dir, 'state'),
    write(name, value) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
      return file;
    },
  };
}

async function run(f, args, { input = '', env = {}, transport, stdin } = {}) {
  let out = '';
  let err = '';
  let calls = 0;
  const code = await main(args, {
    cwd: f.dir,
    env: { LUNA_CORE_HOME: f.home, LUNA_CORE_MODE: 'heuristic', ...env },
    stdin: stdin ?? Readable.from([input]),
    stdout: { write(text) { out += text; } },
    stderr: { write(text) { err += text; } },
    transport: async (...args) => {
      calls += 1;
      if (transport) return transport(...args);
      throw new Error('A test unexpectedly attempted a Luna call');
    },
  });
  return { code, out, err, calls, json: () => JSON.parse(out) };
}

test('route JSON input supports candidates and failure history, including a BOM file', async (t) => {
  const f = fixture(t);
  f.write('route.json', `\uFEFF${JSON.stringify({
    task: '修正測試失敗', candidates: ['claude-sonnet-5-5'],
    steps: [
      { kind: 'verify', command: 'node --test', failed: true },
      { kind: 'verify', command: 'node --test', failed: true },
    ],
  })}`);
  const result = await run(f, ['route', '--input', 'route.json']);
  assert.equal(result.code, EXIT.OK, result.err);
  assert.equal(result.json().result.model, 'claude-sonnet-5-5');
  assert.equal(result.json().result.effort, 'max');
  assert.equal(result.calls, 0);
});

test('stdin preserves UTF-8 characters split across stream chunks and the full input contract', async (t) => {
  const f = fixture(t);
  const task = '修正「多行」輸入\nKeep "quotes" and \\slashes.';
  const bytes = Buffer.from(`\uFEFF${JSON.stringify({ task, candidates: ['claude-sonnet-5-5'] })}`);
  const fake = fakeLuna({ scores: { effort: [0, 0, 1, 0, 0] } });
  const result = await run(f, ['route', '--mode', 'luna', '--input', '-'], {
    stdin: Readable.from(Array.from(bytes, (byte) => Buffer.from([byte]))), transport: fake.transport,
  });
  assert.equal(result.code, EXIT.OK, result.err);
  assert.equal(result.json().source, 'luna');
  assert.equal(fake.calls[0].state.task, task);
  assert.equal(result.json().result.model, 'claude-sonnet-5-5');
});

test('all six decision commands accept the library input object from stdin', async (t) => {
  const f = fixture(t);
  const cases = [
    ['route', { task: 'rename a variable', candidates: ['claude-haiku-5-5'] }, (d) => d.result.model === 'claude-haiku-5-5'],
    ['skills', { task: 'Use /git-workflow', catalog: [{ name: 'git-workflow', description: 'Git branches' }], maxSkills: 1 }, (d) => d.result.selected[0].name === 'git-workflow'],
    ['retrieve', { query: 'cache eviction', candidates: [{ id: 'one', source: 'cache.js', text: 'cache eviction', score: 1 }], force: true, budgetTokens: 100 }, (d) => d.result.chunks[0].id === 'one'],
    ['recall', { query: 'preferred language', limit: 1 }, (d) => d.result.memories.length === 0],
    ['remember', { observation: 'Always use Traditional Chinese', source: 'user', type: 'user', dryRun: true }, (d) => d.result.action === 'save_new' && !d.result.applied],
    ['compress', { window: 1000, segments: [{ id: 's', role: 'system', turn: 0, text: 'Keep requirements' }] }, (d) => d.result.compact === false],
  ];
  for (const [command, input, expected] of cases) {
    const result = await run(f, [command, '--input', '-'], { input: JSON.stringify(input) });
    assert.equal(result.code, EXIT.OK, `${command}: ${result.err}`);
    assert.ok(expected(result.json()), command);
    assert.equal(result.calls, 0, command);
  }
  assert.equal(fs.existsSync(path.join(f.home, 'memory.jsonl')), false, 'dry-run did not create the memory store');
});

test('JSON input resolves skill and retrieval paths against cwd, not the JSON file folder', async (t) => {
  const f = fixture(t);
  f.write('skills/git-workflow/SKILL.md', '---\nname: git-workflow\ndescription: Git branches\n---\n');
  f.write('repo/cache.js', 'export const cacheEviction = true;\n');
  f.write('inputs/skills.json', { task: 'Use /git-workflow', dirs: ['./skills'] });
  f.write('inputs/retrieve.json', { query: 'cache eviction', root: './repo', force: true });
  const skills = await run(f, ['skills', '--input', 'inputs/skills.json']);
  assert.equal(skills.code, EXIT.OK, skills.err);
  assert.equal(skills.json().result.selected[0].path, path.join(f.dir, 'skills', 'git-workflow', 'SKILL.md'));
  const retrieve = await run(f, ['retrieve', '--input', 'inputs/retrieve.json']);
  assert.equal(retrieve.code, EXIT.OK, retrieve.err);
  assert.ok(retrieve.json().result.chunks.some((chunk) => chunk.source.endsWith('cache.js')));
});

test('mixing --input with individual flags fails before reading stdin or calling Luna', async (t) => {
  const f = fixture(t);
  const stdin = { [Symbol.asyncIterator]() { throw new Error('must not read stdin'); } };
  for (const args of [
    ['route', '--input', '-', '--task', 'ignored'],
    ['remember', '--input', '-', '--dry-run'],
    ['compress', '--input', '-', '--file', 'ignored.json'],
  ]) {
    const result = await run(f, args, { stdin });
    assert.equal(result.code, EXIT.USAGE);
    assert.match(result.err, /--input cannot be combined/);
    assert.equal(result.calls, 0);
  }
});

test('malformed, non-object, unknown and mistyped JSON inputs are usage errors before a call', async (t) => {
  const f = fixture(t);
  for (const input of ['{', '[]', 'null', '42', '{"task":"test","contextToken":123}', '{"task":"test","":"unknown"}', '{"task":"test","steps":"oops"}']) {
    const result = await run(f, ['route', '--mode', 'luna', '--input', '-'], { input });
    assert.equal(result.code, EXIT.USAGE, input);
    assert.equal(result.calls, 0, input);
    assert.equal(result.out, '', input);
  }
  const empty = await run(f, ['route', '--input', '']);
  assert.equal(empty.code, EXIT.USAGE);
  assert.match(empty.err, /file path/);
  const missing = await run(f, ['route', '--input', 'missing.json']);
  assert.equal(missing.code, EXIT.ERROR);
  assert.match(missing.err, /cannot read/);
});

test('a misspelled dryRun field is refused before any memory or ledger write', async (t) => {
  const f = fixture(t);
  const result = await run(f, ['remember', '--mode', 'luna', '--input', '-'], {
    input: JSON.stringify({ observation: 'Always use Traditional Chinese', dryrun: true }),
  });
  assert.equal(result.code, EXIT.USAGE);
  assert.match(result.err, /unknown input field "dryrun"/);
  assert.equal(result.calls, 0);
  assert.equal(fs.existsSync(f.home), false);
});

test('stdin and files enforce a byte limit, accept the limit, and reject excess before a call', async (t) => {
  const f = fixture(t);
  const json = '{"task":"x"}';
  const exact = json + ' '.repeat(INPUT_LIMIT_BYTES - Buffer.byteLength(json));
  f.write('large.json', `${exact} `);
  const file = await run(f, ['route', '--input', 'large.json']);
  const stdin = await run(f, ['route', '--input', '-'], { input: `${exact} ` });
  const multibyte = await run(f, ['route', '--input', '-'], { input: '中'.repeat(Math.floor(INPUT_LIMIT_BYTES / 3) + 1) });
  for (const result of [file, stdin, multibyte]) {
    assert.equal(result.code, EXIT.USAGE);
    assert.match(result.err, /over 1048576 bytes/);
    assert.equal(result.calls, 0);
  }
  const accepted = await run(f, ['route', '--input', '-'], { input: exact });
  assert.equal(accepted.code, EXIT.OK, accepted.err);
});

test('interactive stdin is rejected with an actionable input message', async (t) => {
  const f = fixture(t);
  const result = await run(f, ['route', '--input', '-'], { stdin: { isTTY: true } });
  assert.equal(result.code, EXIT.USAGE);
  assert.match(result.err, /piped JSON/);
  assert.equal(result.calls, 0);
});

test('legacy compress --file accepts a UTF-8 BOM without changing its output contract', async (t) => {
  const f = fixture(t);
  f.write('transcript.json', '\uFEFF{"window":1000,"segments":[]}');
  const result = await run(f, ['compress', '--file', 'transcript.json']);
  assert.equal(result.code, EXIT.OK, result.err);
  assert.equal(result.json().kind, 'compress');
});

test('text decisions explain fallback without leaking credentials, while JSON remains the default', async (t) => {
  const f = fixture(t);
  const result = await run(f, ['route', '--mode', 'auto', '--task', 'rename a variable', '--format', 'text'], {
    env: { OPENAI_API_KEY: KEY }, transport: async () => { throw new Error(`upstream failed for ${KEY}`); },
  });
  assert.equal(result.code, EXIT.OK, result.err);
  assert.match(result.out, /Source: rules/);
  assert.match(result.out, /Fallback reason: upstream failed/);
  assert.match(result.out, /host must apply/);
  assert.match(result.out, /Luna responses received: 0/);
  assert.ok(!result.out.includes(KEY));
  const json = await run(f, ['route', '--task', 'rename a variable']);
  assert.equal(json.json().kind, 'route');
  const invalid = await run(f, ['route', '--task', 'rename', '--format', 'yaml']);
  assert.equal(invalid.code, EXIT.USAGE);
  assert.match(invalid.err, /--format must be json or text/);
});

test('doctor is offline, writes no files, distinguishes configured keys from validated access', async (t) => {
  const f = fixture(t);
  const before = fs.readdirSync(f.dir);
  const json = await run(f, ['doctor', '--mode', 'auto', '--json'], { env: { OPENAI_API_KEY: KEY } });
  assert.equal(json.code, EXIT.OK, json.err);
  assert.equal(json.json().offline, true);
  assert.equal(json.json().decisionModel.apiKey, 'set');
  assert.equal(json.json().decisionModel.liveCheck, 'not_run');
  assert.ok(json.json().generationModels.every((model) => model.availability === 'not_checked'));
  assert.ok(!json.out.includes(KEY));
  assert.equal(json.calls, 0);
  assert.deepEqual(fs.readdirSync(f.dir), before);
  const text = await run(f, ['doctor']);
  assert.equal(text.code, EXIT.OK, text.err);
  assert.match(text.out, /doctor .*\(offline\)/);
  assert.match(text.out, /No network requests were made and no files were written/);
});

test('doctor explains a missing Luna key and exits nonzero, while offline mode needs no key', async (t) => {
  const f = fixture(t);
  for (const mode of ['auto', 'luna']) {
    const result = await run(f, ['doctor', '--mode', mode, '--json']);
    assert.equal(result.code, EXIT.ERROR);
    const report = result.json();
    assert.equal(report.ok, false);
    assert.equal(report.decisionModel.apiKey, 'unset');
    assert.match(report.checks.find((check) => check.id === 'api-key').action, /LUNA_API_KEY/);
    assert.equal(result.calls, 0);
  }
  assert.equal((await run(f, ['doctor', '--mode', 'heuristic'])).code, EXIT.OK);
});

test('real CLI accepts piped JSON without shell quoting and keeps stdout machine-readable', (t) => {
  const f = fixture(t);
  const bin = path.resolve(import.meta.dirname, '../bin/luna-core.js');
  const result = spawnSync(process.execPath, [bin, 'route', '--mode', 'heuristic', '--input', '-'], {
    cwd: f.dir,
    env: { LUNA_CORE_HOME: f.home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    input: JSON.stringify({ task: '修正「引號」和\n多行', candidates: ['claude-sonnet-5-5'] }),
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, EXIT.OK, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.model, 'claude-sonnet-5-5');
  assert.equal(result.stderr, '');
});
