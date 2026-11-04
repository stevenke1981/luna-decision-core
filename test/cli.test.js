// The CLI through main(): strict parsing and usage errors, each decide command in heuristic mode
// on temp folders, config without the key, probe with and without a key, serve and mcp. Every
// test passes its own env and cwd, so no test reads the real environment, home or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main, EXIT } from '../src/cli.js';
import { VERSION } from '../src/version.js';
import { fakeLuna } from './helpers/fakeLuna.js';

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const SERVE_TIMEOUT_MS = 15_000;

/** A writable that keeps its text and can wait for a pattern to appear in it. */
function capture() {
  const state = { text: '' };
  const waiters = new Set();
  return {
    write(chunk) {
      state.text += chunk;
      for (const check of [...waiters]) check();
      return true;
    },
    get text() {
      return state.text;
    },
    waitFor(pattern) {
      return new Promise((resolve) => {
        const check = () => {
          const found = state.text.match(pattern);
          if (found) {
            waiters.delete(check);
            resolve(found);
          }
        };
        waiters.add(check);
        check();
      });
    },
  };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcore-cli-'));
  return {
    dir,
    write(rel, text) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs one command with a home folder of its own; the env holds no key unless `env` adds one. */
async function run(f, argv, { env = {}, ...rest } = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, { env: { LUNA_CORE_HOME: f.dir, ...env }, cwd: f.dir, stdout, stderr, ...rest });
  return { code, out: stdout.text, err: stderr.text, json: () => JSON.parse(stdout.text) };
}

const segments = () => Array.from({ length: 6 }, (_, i) => ({
  id: `seg${i}`, role: i === 0 ? 'system' : i % 2 ? 'tool' : 'assistant', turn: i, text: `line ${i}\n${'output '.repeat(300)}\nerror: failed ${i}`,
}));

test('--version prints the package version and exits 0', async () => {
  const f = fixture();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
    const r = await run(f, ['--version']);
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.out.trim(), VERSION);
    assert.equal(VERSION, pkg.version);
    assert.equal((await run(f, ['route', '--version'])).out.trim(), VERSION);
  } finally {
    f.cleanup();
  }
});

test('--help prints the usage on stdout; no command is a usage error on stderr', async () => {
  const f = fixture();
  try {
    for (const argv of [['--help'], ['-h'], ['help'], ['route', '--help']]) {
      const r = await run(f, argv);
      assert.equal(r.code, EXIT.OK, argv.join(' '));
      assert.match(r.out, /Usage: luna-core <command> \[options\]/);
      assert.equal(r.err, '');
    }
    const none = await run(f, []);
    assert.equal(none.code, EXIT.USAGE);
    assert.match(none.err, /no command given/);
    assert.match(none.err, /luna-core --help/);
    assert.equal(none.out, '');
  } finally {
    f.cleanup();
  }
});

test('an unknown command, or an option placed before the command, is a usage error', async () => {
  const f = fixture();
  try {
    const unknown = await run(f, ['frobnicate']);
    assert.equal(unknown.code, EXIT.USAGE);
    assert.match(unknown.err, /unknown command "frobnicate"/);
    const early = await run(f, ['--mode', 'heuristic', 'route', '--task', 'x']);
    assert.equal(early.code, EXIT.USAGE);
    assert.match(early.err, /put options after the command/);
  } finally {
    f.cleanup();
  }
});

test('unknown options, stray arguments and missing option values are usage errors', async () => {
  const f = fixture();
  try {
    const cases = [
      [['route', '--task', 'x', '--bogus'], /Unknown option '--bogus'/],
      [['route', 'extra', '--task', 'x'], /Unexpected argument 'extra'/],
      [['route', '--task'], /argument missing/],
      [['route', '--task', 'x', '--mode'], /argument missing/],
    ];
    for (const [argv, pattern] of cases) {
      const r = await run(f, argv);
      assert.equal(r.code, EXIT.USAGE, argv.join(' '));
      assert.match(r.err, pattern);
    }
  } finally {
    f.cleanup();
  }
});

test('a required option is checked before any work, and bad option values are usage errors', async () => {
  const f = fixture();
  try {
    const missing = await run(f, ['route', '--mode', 'heuristic']);
    assert.equal(missing.code, EXIT.USAGE);
    assert.match(missing.err, /missing required --task/);
    const cases = [
      [['route', '--task', 'x', '--mode', 'fast'], /--mode must be auto, luna, heuristic/],
      [['route', '--task', 'x', '--context-tokens=-5'], /--context-tokens must be an integer at least 0/],
      [['retrieve', '--query', 'x', '--budget', '0'], /--budget must be an integer at least 1/],
      [['serve', '--port', '70000'], /--port must be an integer from 0 to 65535/],
      [['serve', '--port', 'abc'], /--port must be an integer/],
      [['route', '--task', '', '--mode', 'heuristic'], /route: task must be a non-empty string/],
      [['remember', '--text', 'x', '--source', 'bot', '--mode', 'heuristic'], /source must be user\|agent\|tool/],
    ];
    for (const [argv, pattern] of cases) {
      const r = await run(f, argv);
      assert.equal(r.code, EXIT.USAGE, argv.join(' '));
      assert.match(r.err, pattern);
    }
  } finally {
    f.cleanup();
  }
});

test('route decides in heuristic mode and prints the decision as JSON', async () => {
  const f = fixture();
  try {
    const r = await run(f, ['route', '--task', 'rename a variable', '--mode', 'heuristic']);
    assert.equal(r.code, EXIT.OK, r.err);
    const d = r.json();
    assert.equal(d.kind, 'route');
    assert.equal(d.source, 'rules');
    assert.equal(d.result.model, 'claude-haiku-5-5');
    assert.equal(d.result.effort, 'medium');
    assert.equal(d.calls, 0);
  } finally {
    f.cleanup();
  }
});

test('route passes --context-tokens, --requires and --local-only through to the kind', async () => {
  const f = fixture();
  try {
    const big = await run(f, ['route', '--task', 'add a flag', '--context-tokens', '150000', '--mode', 'heuristic']);
    assert.equal(big.code, EXIT.OK, big.err);
    const needs = await run(f, ['route', '--task', 'add a flag', '--requires', 'tools, vision', '--mode', 'heuristic']);
    assert.equal(needs.code, EXIT.OK, needs.err);
    const local = await run(f, ['route', '--task', 'add a flag', '--local-only', '--mode', 'heuristic']);
    assert.equal(local.code, EXIT.USAGE);
    assert.match(local.err, /no eligible model/);
  } finally {
    f.cleanup();
  }
});

test('auto mode with no key falls back to the rules and records why, without any network call', async () => {
  const f = fixture();
  try {
    const r = await run(f, ['route', '--task', 'debug a race in the scheduler']);
    assert.equal(r.code, EXIT.OK, r.err);
    const d = r.json();
    assert.equal(d.source, 'rules');
    assert.match(d.error, /no OpenAI API key/);
  } finally {
    f.cleanup();
  }
});

test('skills collects every --dir and loads the skill that lives in the second folder', async () => {
  const f = fixture();
  try {
    f.write('A/other-skill/SKILL.md', '---\nname: other-skill\ndescription: Unrelated formatting helper\n---\n');
    f.write('B/rust-testing/SKILL.md', '---\nname: rust-testing\ndescription: Write Rust unit tests\n---\n');
    const r = await run(f, ['skills', '--task', 'use rust-testing for the parser', '--dir', 'A', '--dir', 'B', '--mode', 'heuristic']);
    assert.equal(r.code, EXIT.OK, r.err);
    const [picked] = r.json().result.selected;
    assert.equal(picked.name, 'rust-testing');
    assert.equal(picked.reason, 'forced');
    assert.ok(picked.path.includes(path.join(f.dir, 'B')), picked.path);
  } finally {
    f.cleanup();
  }
});

test('retrieve resolves --root against the working folder, bounds the budget and honours --force', async () => {
  const f = fixture();
  try {
    f.write('repo/src/cache.js', 'export function evictCache(lru) {\n  // evict the least recently used cache entry\n  return lru.pop();\n}\n');
    f.write('repo/src/other.js', 'export const unrelated = 1;\n');
    const r = await run(f, ['retrieve', '--query', 'evictCache least recently used', '--root', 'repo', '--budget', '500', '--mode', 'heuristic']);
    assert.equal(r.code, EXIT.OK, r.err);
    const d = r.json();
    assert.equal(d.result.needed, true);
    assert.ok(d.result.chunks.some((c) => c.source.includes('cache.js')));
    assert.ok(!d.result.chunks.some((c) => c.source.includes('other.js')));
    assert.ok(d.result.tokens <= 500);
    const forced = await run(f, ['retrieve', '--query', 'cache', '--root', 'repo', '--force', '--mode', 'heuristic']);
    assert.equal(forced.code, EXIT.OK, forced.err);
    assert.equal(forced.json().result.needed, true);
  } finally {
    f.cleanup();
  }
});

test('remember --dry-run stores nothing; a stored memory is then found by recall', async () => {
  const f = fixture();
  try {
    const dry = await run(f, ['remember', '--text', 'Remember: I prefer pnpm over npm', '--dry-run', '--mode', 'heuristic']);
    assert.equal(dry.code, EXIT.OK, dry.err);
    assert.equal(dry.json().result.applied, false);
    assert.equal(fs.existsSync(path.join(f.dir, 'memory.jsonl')), false);

    const saved = await run(f, ['remember', '--text', 'Remember: I prefer pnpm over npm', '--mode', 'heuristic']);
    assert.equal(saved.code, EXIT.OK, saved.err);
    assert.equal(saved.json().result.applied, true);
    const recalled = await run(f, ['recall', '--query', 'pnpm or npm', '--mode', 'heuristic']);
    assert.equal(recalled.code, EXIT.OK, recalled.err);
    assert.equal(recalled.json().result.memories.length, 1);
  } finally {
    f.cleanup();
  }
});

test('remember refuses a secret: it is skipped and the key is never echoed', async () => {
  const f = fixture();
  try {
    const r = await run(f, ['remember', '--text', `use this key ${KEY} for the deploy`, '--mode', 'heuristic']);
    assert.equal(r.code, EXIT.OK, r.err);
    assert.equal(r.json().result.action, 'skip');
    assert.equal(r.json().result.applied, false);
    assert.ok(!r.out.includes(KEY));
    assert.equal(fs.existsSync(path.join(f.dir, 'memory.jsonl')), false);
  } finally {
    f.cleanup();
  }
});

test('compress reads the transcript file; a missing file is an error and invalid JSON is usage', async () => {
  const f = fixture();
  try {
    f.write('t.json', JSON.stringify({ window: 3000, segments: segments(), goal: 'fix the failure' }));
    const r = await run(f, ['compress', '--file', 't.json', '--mode', 'heuristic']);
    assert.equal(r.code, EXIT.OK, r.err);
    const d = r.json();
    assert.equal(d.result.compact, true);
    assert.ok(d.result.tokensAfter < d.result.tokensBefore);

    const missing = await run(f, ['compress', '--file', 'absent.json', '--mode', 'heuristic']);
    assert.equal(missing.code, EXIT.ERROR);
    assert.match(missing.err, /cannot read .*absent\.json: ENOENT/);

    f.write('bad.json', '{ not json');
    const broken = await run(f, ['compress', '--file', 'bad.json', '--mode', 'heuristic']);
    assert.equal(broken.code, EXIT.USAGE);
    assert.match(broken.err, /not valid JSON/);

    f.write('list.json', '[]');
    const notObject = await run(f, ['compress', '--file', 'list.json', '--mode', 'heuristic']);
    assert.equal(notObject.code, EXIT.USAGE);
    assert.match(notObject.err, /compress: input must be an object/);
  } finally {
    f.cleanup();
  }
});

test('a decision that fails inside the kind (unreadable memory file) exits 1 with the message', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.dir, 'memory.jsonl'));
    const r = await run(f, ['recall', '--query', 'anything', '--mode', 'heuristic']);
    assert.equal(r.code, EXIT.ERROR);
    assert.match(r.err, /memory: cannot read/);
    assert.equal(r.out, '');
  } finally {
    f.cleanup();
  }
});

test('config prints the effective configuration with the API key shown only as set or unset', async () => {
  const f = fixture();
  try {
    const withKey = await run(f, ['config'], { env: { OPENAI_API_KEY: KEY } });
    assert.equal(withKey.code, EXIT.OK, withKey.err);
    assert.equal(withKey.json().apiKey, 'set');
    assert.ok(!withKey.out.includes(KEY));
    const noKey = await run(f, ['config']);
    assert.equal(noKey.json().apiKey, 'unset');
    assert.equal(noKey.json().mode, 'auto');
  } finally {
    f.cleanup();
  }
});

test('config applies --mode over the file and --config to read the file; a key in the file is refused', async () => {
  const f = fixture();
  try {
    f.write('cfg.json', JSON.stringify({ mode: 'auto', server: { port: 9123 } }));
    const r = await run(f, ['config', '--config', 'cfg.json', '--mode', 'heuristic']);
    assert.equal(r.code, EXIT.OK, r.err);
    assert.equal(r.json().mode, 'heuristic');
    assert.equal(r.json().server.port, 9123);
    assert.equal(r.json().configFile, path.join(f.dir, 'cfg.json'));

    const absent = await run(f, ['config', '--config', 'nope.json']);
    assert.equal(absent.code, EXIT.ERROR);
    assert.match(absent.err, /cannot read config/);

    f.write('secret.json', JSON.stringify({ apiKey: KEY }));
    const leaked = await run(f, ['config', '--config', 'secret.json']);
    assert.equal(leaked.code, EXIT.ERROR);
    assert.match(leaked.err, /not in the config file/);
    assert.ok(!leaked.err.includes(KEY));
  } finally {
    f.cleanup();
  }
});

test('probe without an API key fails cleanly and calls nothing', async () => {
  const f = fixture();
  try {
    const fake = fakeLuna({});
    const r = await run(f, ['probe'], { transport: fake.transport });
    assert.equal(r.code, EXIT.ERROR);
    assert.match(r.err, /no OpenAI API key/);
    assert.equal(r.out, '');
    assert.equal(fake.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('probe prints a strict Luna route decision from an injected transport', async () => {
  const f = fixture();
  try {
    const fake = fakeLuna({
      choices: { model: { 'claude-haiku-5-5': 0.8, 'claude-sonnet-5-5': 0.1, 'claude-opus-5-5': 0.1 } },
      confidences: { model: 0.9, effort: 0.9 },
      scores: { effort: [0, 0.1, 0.8, 0.1, 0] },
    });
    const r = await run(f, ['probe'], { env: { OPENAI_API_KEY: KEY }, transport: fake.transport });
    assert.equal(r.code, EXIT.OK, r.err);
    const d = r.json();
    assert.equal(d.kind, 'route');
    assert.equal(d.source, 'luna');
    assert.equal(d.calls, 1);
    assert.equal(d.result.model, 'claude-haiku-5-5');
    assert.equal(d.result.effort, 'high');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].state.kind, 'route');
    assert.ok(!JSON.stringify(fake.calls[0].state).includes(KEY));
    assert.ok(!JSON.stringify(fake.calls[0].questions).includes(KEY));
  } finally {
    f.cleanup();
  }
});

test('probe refuses --mode other than luna, since it is always a strict call', async () => {
  const f = fixture();
  try {
    const r = await run(f, ['probe', '--mode', 'heuristic'], { env: { OPENAI_API_KEY: KEY } });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.err, /probe always runs in luna \(strict\) mode/);
    const same = await run(f, ['probe', '--mode', 'luna']);
    assert.equal(same.code, EXIT.ERROR);
    assert.match(same.err, /no OpenAI API key/);
  } finally {
    f.cleanup();
  }
});

test('probe reports a strict Luna failure with the key scrubbed from the message', async () => {
  const f = fixture();
  try {
    const fake = fakeLuna({ fail: new Error(`Luna HTTP 401: Incorrect API key provided: ${KEY}`) });
    const r = await run(f, ['probe'], { env: { OPENAI_API_KEY: KEY }, transport: fake.transport });
    assert.equal(r.code, EXIT.ERROR);
    assert.match(r.err, /Luna HTTP 401/);
    assert.match(r.err, /\[redacted\]/);
    assert.ok(!r.err.includes(KEY));
    assert.equal(r.out, '');
  } finally {
    f.cleanup();
  }
});

test('serve answers /health on an ephemeral port and stops when aborted', { timeout: SERVE_TIMEOUT_MS }, async () => {
  const f = fixture();
  const stop = new AbortController();
  const stdout = capture();
  const stderr = capture();
  const running = main(['serve', '--port', '0', '--mode', 'heuristic'], {
    env: { LUNA_CORE_HOME: f.dir }, cwd: f.dir, stdout, stderr, signal: stop.signal,
  });
  try {
    const [, port] = await stderr.waitFor(/http:\/\/127\.0\.0\.1:(\d+)/);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).mode, 'heuristic');
    stop.abort();
    assert.equal(await running, EXIT.OK);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(stdout.text, '');
  } finally {
    stop.abort();
    await running.catch(() => {});
    f.cleanup();
  }
});

test('mcp answers JSON-RPC over stdin and writes nothing but JSON-RPC lines to stdout', async () => {
  const f = fixture();
  try {
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const running = main(['mcp', '--mode', 'heuristic'], {
      env: { LUNA_CORE_HOME: f.dir }, cwd: f.dir, stdin, stdout, stderr,
    });
    stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ].join('\n') + '\n');
    assert.equal(await running, EXIT.OK);
    const lines = stdout.text.trim().split('\n');
    assert.equal(lines.length, 1);
    const reply = JSON.parse(lines[0]);
    assert.equal(reply.id, 1);
    assert.equal(reply.result.serverInfo.name, 'luna-decision-core');
    assert.equal(stderr.text, '');
  } finally {
    f.cleanup();
  }
});
