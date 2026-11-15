// The command-line interface (docs/design.md §6). `main(argv, io)` parses one command strictly
// (node:util parseArgs), runs it and resolves to the exit code: 0 ok, 1 error, 2 usage. Decisions
// are JSON on stdout; messages go to stderr with every secret scrubbed. Nothing is read from the
// environment except through `io.env`, so tests pass their own. `bin/luna-core.js` loads the env
// files and calls this.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createEngine, decisionErrorCode } from './engine.js';
import { DecisionError } from './errors.js';
import { loadConfig } from './config.js';
import { MODES } from './defaults.js';
import { requireText } from './contract.js';
import { KIND_MODULES } from './registry.js';
import { VERSION } from './version.js';
import { BODY_LIMIT_BYTES, scrubSecrets, startHttp } from './server/http.js';
import { createMcpServer } from './server/mcp.js';

/** Exit codes: 0 success, 1 a failed command (Luna, IO, config), 2 a usage or input error. */
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2 });
const PROBE_MODE = 'luna';
const PROBE_TASK = 'Probe: rename one local variable inside a small helper function.';
const MAX_PORT = 65535;
const KEY_VARIABLES = Object.freeze(['LUNA_API_KEY', 'OPENAI_API_KEY']);
const isLoopback = (host) => host === 'localhost' || host === '::1' || host.startsWith('127.');
const HELP_HINT = 'Run "luna-core --help" for the commands and options.';

const USAGE = `Usage: luna-core <command> [options]

Commands:
  probe                        one live Luna call (route, strict mode); needs an API key
  hook [--dir D ...]            Codex UserPromptSubmit JSON on stdin; strict decisions or block
  hook-config [--dir D ...]    print Codex hooks.json for this installation (no API call)
  route --task T               model and effort   [--context-tokens N] [--requires a,b] [--local-only]
  route --input-json FILE      route with the same JSON input as HTTP and MCP
  skills --task T              skills to load     [--dir D ...] (repeat --dir for more folders)
  retrieve --query Q           context chunks     [--root R] [--budget N] [--force]
  recall --query Q             stored memories that apply
  remember --text T            save, update or skip a memory   [--source user|agent|tool] [--dry-run]
  compress --file FILE         compact a transcript; FILE holds the input object as JSON
  serve [--port N]             HTTP sidecar on 127.0.0.1 (default port 8792)
  mcp                          MCP server on stdin and stdout
  config                       effective configuration; the API key shows as set or unset

Options for every command:
  --mode auto|luna|heuristic   auto: Luna, then the rules; luna: strict; heuristic: rules only
  --config FILE                JSON config file
  -h, --help                   this text
  --version                    the version

Output is JSON on stdout and errors go to stderr. Exit codes: 0 ok, 1 error, 2 usage.
The hook command returns exit 0 with a JSON blocking decision on failure.
Keys: LUNA_API_KEY or OPENAI_API_KEY, from the environment or an env file.
`;

/** A bad command line or a bad option value. Exits 2, like any TypeError (bad input). */
export class UsageError extends TypeError {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.code = code;
    this.name = 'UsageError';
  }
}

const str = { type: 'string' };
const multi = { type: 'string', multiple: true };
const flag = { type: 'boolean' };
const COMMON_OPTIONS = { mode: str, config: str, help: { type: 'boolean', short: 'h' }, version: flag };

const COMMANDS = Object.freeze({
  probe: { options: {}, run: runProbe },
  hook: { options: { dir: multi }, run: runHook },
  'hook-config': { options: { dir: multi }, run: runHookConfig },
  route: { options: { 'input-json': str, task: str, 'context-tokens': str, requires: str, 'local-only': flag }, run: runRoute },
  skills: { options: { task: str, dir: multi }, run: runSkills },
  retrieve: { options: { query: str, root: str, budget: str, force: flag }, run: runRetrieve },
  recall: { options: { query: str }, run: runRecall },
  remember: { options: { text: str, source: str, 'dry-run': flag }, run: runRemember },
  compress: { options: { file: str }, run: runCompress },
  serve: { options: { port: str }, run: runServe },
  mcp: { options: {}, run: runMcp },
  config: { options: {}, run: runConfig },
});

function resolveIo(options) {
  return Object.freeze({
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    transport: options.transport,
    signal: options.signal,
  });
}

function parseOptions(args, spec) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { ...COMMON_OPTIONS, ...spec.options }, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.mode !== undefined && !MODES.includes(values.mode)) throw new UsageError(`--mode must be ${MODES.join(', ')}`);
  return values;
}

function printUsage(io) {
  io.stdout.write(USAGE);
  return EXIT.OK;
}

function printVersion(io) {
  io.stdout.write(`${VERSION}\n`);
  return EXIT.OK;
}

async function dispatch(argv, io) {
  const [name, ...rest] = argv;
  if (name === undefined) throw new UsageError('no command given');
  if (name === '--version' || name === '-v') return printVersion(io);
  if (name === '--help' || name === '-h' || name === 'help') return printUsage(io);
  if (!Object.hasOwn(COMMANDS, name)) {
    throw new UsageError(name.startsWith('-') ? `"${name}" is an option; put options after the command` : `unknown command "${name}"`);
  }
  const spec = COMMANDS[name];
  const values = parseOptions(rest, spec);
  if (values.help) return printUsage(io);
  if (values.version) return printVersion(io);
  return spec.run({ values, io });
}

/** Prints the error (secrets scrubbed) and returns its exit code. */
function report(io, err) {
  const usage = err instanceof UsageError;
  const secrets = KEY_VARIABLES.map((key) => io.env[key]);
  const code = usage ? err.code : decisionErrorCode(err);
  io.stderr.write(`luna-core: ${scrubSecrets(err?.message ?? err, secrets)} [${code}]\n`);
  if (usage) io.stderr.write(`${HELP_HINT}\n`);
  return usage ? EXIT.USAGE : EXIT.ERROR;
}

/**
 * Runs one command.
 * @param {string[]} argv the arguments after `luna-core`
 * @param {{env?: object, cwd?: string, stdin?: object, stdout?: object, stderr?: object,
 *   transport?: Function, signal?: AbortSignal}} [options] `transport` replaces the Luna transport
 *   (tests inject fakeLuna); `signal` stops `serve` when aborted
 * @returns {Promise<number>} the exit code
 */
export async function main(argv = [], options = {}) {
  const io = resolveIo(options);
  try {
    return await dispatch(argv, io);
  } catch (err) {
    if (argv[0] === 'hook') {
      const secrets = KEY_VARIABLES.map((key) => io.env[key]);
      writeJson(io.stdout, { decision: 'block', reason: `Luna Decision hook failed: ${scrubSecrets(err?.message ?? err, secrets)}` });
      return EXIT.OK;
    }
    return report(io, err);
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function configFor(io, values, extra = {}) {
  const overrides = { ...(values.mode !== undefined ? { mode: values.mode } : {}), ...extra };
  return loadConfig({ env: io.env, cwd: io.cwd, file: values.config, overrides });
}

/** The value of a required option; an absent one is a usage error. */
function requireOption(values, flagName) {
  if (values[flagName] === undefined) throw new UsageError(`missing required --${flagName}`);
  return values[flagName];
}

/** The value of an integer option, or undefined when it was not given. */
function intOption(values, flagName, { min, max = Number.MAX_SAFE_INTEGER }) {
  const raw = values[flagName];
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `at least ${min}` : `from ${min} to ${max}`;
    throw new UsageError(`--${flagName} must be an integer ${range}`);
  }
  return n;
}

const resolveIn = (cwd, p) => (p ? path.resolve(cwd, p) : p);

/** The kind's own validation (normalize), run before any Luna call: its failures are usage errors. */
function checkInput(kind, input, config) {
  try {
    KIND_MODULES[kind].normalize(input, config);
  } catch (err) {
    throw new UsageError(err.message, err instanceof DecisionError ? err.code : 'INVALID_INPUT');
  }
}

async function decideAndPrint(io, config, kind, input) {
  checkInput(kind, input, config);
  const engine = createEngine({ config, transport: io.transport });
  writeJson(io.stdout, await engine.decide(kind, input));
  return EXIT.OK;
}

/** A synchronous Codex prompt hook. Failures are converted to blocking JSON by main(). */
async function runHook({ values, io }) {
  if (values.mode !== undefined && values.mode !== 'luna') {
    throw new UsageError('hook always runs in luna (strict) mode');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of io.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT_BYTES) throw new UsageError('hook input exceeds 1 MB');
    chunks.push(bytes);
  }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
  if (event?.hook_event_name !== 'UserPromptSubmit') {
    throw new UsageError('hook requires a UserPromptSubmit event');
  }
  const task = requireText(event.prompt, 'hook: prompt');
  // Prompt hooks must ask Luna even when ordinary routing has a fixed starting model.
  const config = configFor(io, values, { mode: 'luna', route: { start: null } });
  const engine = createEngine({ config, transport: io.transport });
  const route = await engine.route({ task });
  const skills = await engine.skills({
    task,
    ...(values.dir !== undefined ? { dirs: values.dir.map((dir) => resolveIn(io.cwd, dir)) } : {}),
  });
  writeJson(io.stdout, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Luna Decision completed before this prompt. Read the selected SKILL.md files before applying their skills. Routing is a recommendation within the host capabilities and existing authorization; this hook does not change the active model.\n'
        + JSON.stringify({
          route: { source: route.source, result: route.result, calls: route.calls },
          skills: { source: skills.source, result: skills.result, calls: skills.calls },
        }),
    },
  });
  return EXIT.OK;
}

/** Prints a host-local configuration without overwriting or trusting any hook file. */
function runHookConfig({ values, io }) {
  if (values.mode !== undefined && values.mode !== 'luna') {
    throw new UsageError('hook always runs in luna (strict) mode');
  }
  const args = [
    process.execPath, path.resolve(import.meta.dirname, '../bin/luna-core.js'), 'hook',
    ...(values.config !== undefined ? ['--config', resolveIn(io.cwd, values.config)] : []),
    ...(values.dir ?? []).flatMap((dir) => ['--dir', resolveIn(io.cwd, dir)]),
  ];
  const command = args.map((arg) => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
  // EncodedCommand avoids nested cmd.exe/PowerShell quoting and preserves Unicode paths.
  // It encodes only this invocation, never credentials or the user prompt.
  const windowsScript = '& ' + args.map((arg) => "'" + arg.replaceAll("'", "''") + "'").join(' ');
  writeJson(io.stdout, {
    description: 'Luna Decision: synchronous strict routing and skill selection before each prompt. Generated absolute paths are specific to this installation.',
    hooks: {
      UserPromptSubmit: [{ hooks: [{
        type: 'command',
        command,
        commandWindows: 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(windowsScript, 'utf16le').toString('base64'),
        timeout: 30,
        statusMessage: 'Running Luna Decision',
      }] }],
    },
  });
  return EXIT.OK;
}

async function runProbe({ values, io }) {
  if (values.mode !== undefined && values.mode !== PROBE_MODE) {
    throw new UsageError(`probe always runs in ${PROBE_MODE} (strict) mode; drop --mode ${values.mode}`);
  }
  const config = configFor(io, values, { mode: PROBE_MODE });
  if (!config.apiKey) {
    throw new DecisionError('LUNA_AUTH', 'probe: no OpenAI API key; set LUNA_API_KEY or OPENAI_API_KEY in the environment or an env file');
  }
  const engine = createEngine({ config, transport: io.transport });
  writeJson(io.stdout, await engine.route({ task: PROBE_TASK }));
  return EXIT.OK;
}

async function runRoute({ values, io }) {
  if (values['input-json'] !== undefined) {
    if (['task', 'context-tokens', 'requires', 'local-only'].some((key) => values[key] !== undefined)) {
      throw new UsageError('--input-json cannot be combined with route input flags');
    }
    const input = readInputFile(resolveIn(io.cwd, values['input-json']));
    return decideAndPrint(io, configFor(io, values), 'route', input);
  }
  const input = { task: requireOption(values, 'task') };
  const contextTokens = intOption(values, 'context-tokens', { min: 0 });
  if (contextTokens !== undefined) input.contextTokens = contextTokens;
  if (values.requires !== undefined) input.requires = values.requires.split(',').map((s) => s.trim()).filter(Boolean);
  if (values['local-only']) input.localOnly = true;
  return decideAndPrint(io, configFor(io, values), 'route', input);
}

async function runSkills({ values, io }) {
  const input = { task: requireOption(values, 'task') };
  if (values.dir !== undefined) input.dirs = values.dir.map((dir) => resolveIn(io.cwd, dir));
  return decideAndPrint(io, configFor(io, values), 'skills', input);
}

async function runRetrieve({ values, io }) {
  const input = { query: requireOption(values, 'query') };
  if (values.root !== undefined) input.root = resolveIn(io.cwd, values.root);
  const budgetTokens = intOption(values, 'budget', { min: 1 });
  if (budgetTokens !== undefined) input.budgetTokens = budgetTokens;
  if (values.force) input.force = true;
  return decideAndPrint(io, configFor(io, values), 'retrieve', input);
}

async function runRecall({ values, io }) {
  const input = { query: requireOption(values, 'query') };
  return decideAndPrint(io, configFor(io, values), 'memory_recall', input);
}

async function runRemember({ values, io }) {
  const input = { observation: requireOption(values, 'text') };
  if (values.source !== undefined) input.source = values.source;
  if (values['dry-run']) input.dryRun = true;
  return decideAndPrint(io, configFor(io, values), 'memory_write', input);
}

/** The JSON object in a file. A file that cannot be read is an error; one that is not JSON is usage. */
function readInputFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${file} is not valid JSON`);
  }
}

async function runCompress({ values, io }) {
  const input = readInputFile(resolveIn(io.cwd, requireOption(values, 'file')));
  return decideAndPrint(io, configFor(io, values), 'compress', input);
}

/** Resolves when the server closes, after `signal` aborts (which closes it). */
function untilStopped(server, signal) {
  return new Promise((resolve) => {
    const stop = () => {
      server.close();
      server.closeIdleConnections();
    };
    server.once('close', resolve);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

function announce(io, config, server) {
  const { address, port } = server.address();
  const host = address.includes(':') ? `[${address}]` : address;
  if (!isLoopback(config.server.host)) {
    io.stderr.write(`luna-core: warning: ${config.server.host} is not loopback; anyone who can reach it can use this server and its Luna key\n`);
  }
  io.stderr.write(`luna-core: serving http://${host}:${port} (mode ${config.mode}); stop with Ctrl+C\n`);
}

async function runServe({ values, io }) {
  const port = intOption(values, 'port', { min: 0, max: MAX_PORT });
  const config = configFor(io, values, port === undefined ? {} : { server: { port } });
  const engine = createEngine({ config, transport: io.transport });
  const server = await startHttp({ engine, config, log: (line) => io.stderr.write(line) });
  announce(io, config, server);
  await untilStopped(server, io.signal);
  return EXIT.OK;
}

async function runMcp({ values, io }) {
  const config = configFor(io, values);
  const engine = createEngine({ config, transport: io.transport });
  const server = createMcpServer({
    engine, input: io.stdin, output: io.stdout, version: VERSION, config, log: (line) => io.stderr.write(line),
  });
  await server.run();
  return EXIT.OK;
}

async function runConfig({ values, io }) {
  const config = configFor(io, values);
  writeJson(io.stdout, { ...config, apiKey: config.apiKey ? 'set' : 'unset' });
  return EXIT.OK;
}
