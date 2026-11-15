import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { main, EXIT } from '../src/cli.js';
import { fakeLuna } from './helpers/fakeLuna.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const skills = path.join(dir, 'skills', 'rust-testing');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: rust-testing\ndescription: Write Rust unit tests with cargo test\n---\nRun cargo test.\n');
  const fake = fakeLuna({ choices: { model: 'claude-sonnet-5-5' }, scores: { effort: [0, 1, 0, 0, 0] }, predicates: { s0: 0.9 } });
  const event = { hook_event_name: 'UserPromptSubmit', prompt: 'Add cargo tests for the Rust parser', cwd: dir };
  const env = { LUNA_CORE_HOME: dir, OPENAI_API_KEY: 'test-credential-not-real', LUNA_CORE_MODE: 'heuristic' };
  const run = async (argv = [], overrides = {}) => {
    let out = '';
    let err = '';
    const code = await main(['hook', ...argv], {
      cwd: dir, env, transport: fake.transport, stdin: Readable.from([JSON.stringify(event)]),
      stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, ...overrides,
    });
    return { code, out, err, json: () => JSON.parse(out) };
  };
  return { dir, skills: path.dirname(skills), fake, event, env, run };
}

test('hook forces Luna despite heuristic env/config, then injects routing and skill decisions', async (t) => {
  const f = fixture(t);
  const config = path.join(f.dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ mode: 'heuristic', skills: { dirs: [f.skills] } }));
  const r = await f.run(['--config', config]);
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.err, '');
  assert.equal(r.json().hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const context = r.json().hookSpecificOutput.additionalContext;
  assert.match(context, /claude-sonnet-5-5/);
  assert.match(context, /rust-testing/);
  assert.match(context, /SKILL.md/);
  assert.doesNotMatch(r.out, /test-credential-not-real/);
  assert.deepEqual(f.fake.calls.map((c) => c.state.kind), ['route', 'skills']);
});

test('hook permits an empty skill catalog while still requiring a live routing decision', async (t) => {
  const f = fixture(t);
  const r = await f.run();
  assert.equal(r.code, EXIT.OK);
  assert.ok(r.json().hookSpecificOutput);
  assert.deepEqual(f.fake.calls.map((c) => c.state.kind), ['route']);
});

test('missing credentials return an explicit blocking decision, not a nonblocking CLI error', async (t) => {
  const f = fixture(t);
  const r = await f.run([], { env: { LUNA_CORE_HOME: f.dir }, transport: undefined });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.json().decision, 'block');
  assert.match(r.json().reason, /API key/i);
  assert.equal(r.json().hookSpecificOutput, undefined);
});

test('transport failure and abstention block instead of falling back, with credentials scrubbed', async (t) => {
  const f = fixture(t);
  for (const fake of [fakeLuna({ fail: new Error('upstream echoed test-credential-not-real') }), fakeLuna({ refuse: ['model'] })]) {
    const r = await f.run([], { transport: fake.transport });
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.json().decision, 'block');
    assert.equal(r.json().hookSpecificOutput, undefined);
    assert.doesNotMatch(r.out + r.err, /test-credential-not-real/);
  }
});

test('skill decision failure blocks even after routing succeeds', async (t) => {
  const f = fixture(t);
  const transport = (opts, state, questions) => {
    if (state.kind === 'skills') throw new Error('skills unavailable');
    return f.fake.transport(opts, state, questions);
  };
  const r = await f.run(['--dir', f.skills], { transport });
  assert.equal(r.json().decision, 'block');
  assert.match(r.json().reason, /skills unavailable/);
  assert.equal(r.json().hookSpecificOutput, undefined);
});

test('bad JSON, event types, empty prompts and oversized input block before any API call', async (t) => {
  const f = fixture(t);
  for (const text of ['{', 'null', '[]', JSON.stringify({ ...f.event, hook_event_name: 'Stop' }), JSON.stringify({ ...f.event, prompt: ' ' }), JSON.stringify({ ...f.event, prompt: 3 }), 'x'.repeat(1024 * 1024 + 1)]) {
    const r = await f.run([], { stdin: Readable.from([text]) });
    assert.equal(r.json().decision, 'block');
  }
  assert.equal(f.fake.calls.length, 0);
});

test('hook does not accept auto/heuristic modes or unknown flags', async (t) => {
  const f = fixture(t);
  for (const argv of [['--mode', 'heuristic'], ['--mode', 'auto'], ['--bogus']]) {
    const r = await f.run(argv);
    assert.equal(r.json().decision, 'block');
  }
  assert.equal(f.fake.calls.length, 0);
});

test('hook accepts UTF-8 split across buffers and a PowerShell BOM', async (t) => {
  const f = fixture(t);
  const bytes = Buffer.from('\ufeff' + JSON.stringify({ ...f.event, prompt: '修正解析器' }));
  const r = await f.run([], { stdin: Readable.from(Array.from(bytes, (b) => Buffer.from([b]))) });
  assert.ok(r.json().hookSpecificOutput);
  assert.equal(f.fake.calls[0].state.task, '修正解析器');
});

test('hook-config prints synchronous portable commands with absolute paths and preserved options', async (t) => {
  const f = fixture(t);
  let out = '';
  const config = "my config's.json";
  const code = await main(['hook-config', '--config', config, '--dir', f.skills], {
    cwd: f.dir, env: {}, stdout: { write: (s) => { out += s; } },
  });
  assert.equal(code, EXIT.OK);
  const handler = JSON.parse(out).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(handler.type, 'command');
  assert.notEqual(handler.async, true);
  assert.match(handler.command, /bin[\\/]luna-core.js/);
  assert.match(handler.command, /hook.*--config.*my config/);
  assert.match(handler.commandWindows, /^powershell.exe -NoProfile -NonInteractive -EncodedCommand /);
  const script = Buffer.from(handler.commandWindows.split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("my config''s.json"));
  assert.ok(script.includes(process.execPath));
});

test('generated Windows command works from a subdirectory with paths containing spaces and apostrophes', { skip: process.platform !== 'win32' }, async (t) => {
  const f = fixture(t);
  const config = path.join(f.dir, "config with ' quote.json");
  fs.writeFileSync(config, '{}');
  let out = '';
  await main(['hook-config', '--config', config], { cwd: f.dir, env: {}, stdout: { write: (s) => { out += s; } } });
  const command = JSON.parse(out).hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const encoded = command.split(' ').at(-1);
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd: f.skills, env: { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, LUNA_CORE_HOME: f.dir },
    input: JSON.stringify(f.event), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.trim(), JSON.stringify({ stdout: child.stdout, stderr: child.stderr, status: child.status }));
  assert.equal(JSON.parse(child.stdout).decision, 'block');
  assert.match(JSON.parse(child.stdout).reason, /API key/i);
});

test('real hook CLI emits a blocking JSON result when no key is configured', async (t) => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/luna-core.js'), 'hook'], {
    cwd: f.dir, env: { LUNA_CORE_HOME: f.dir }, input: JSON.stringify(f.event), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.trim(), JSON.stringify({ stdout: child.stdout, stderr: child.stderr, status: child.status }));
  assert.equal(JSON.parse(child.stdout).decision, 'block');
});
