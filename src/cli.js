// The command-line interface (docs/design.md §6). `main(argv, io)` parses one command strictly
// (node:util parseArgs), runs it and resolves to the exit code: 0 ok, 1 error, 2 usage. Decisions
// are JSON on stdout by default; doctor is a readable offline report. Errors go to stderr with
// every secret scrubbed. Nothing is read from the
// environment except through `io.env`, so tests pass their own. `bin/luna-core.js` loads the env
// files and calls this.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createEngine } from './engine.js';
import { loadConfig } from './config.js';
import { MODES } from './defaults.js';
import { KIND_MODULES } from './registry.js';
import { VERSION } from './version.js';
import { scrubSecrets, startHttp } from './server/http.js';
import { createMcpServer } from './server/mcp.js';
import { diagnose, formatDiagnostics } from './diagnostics.js';

/** Exit codes: 0 success, 1 a failed command (Luna, IO, config), 2 a usage or input error. */
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2 });
/** JSON input files and stdin are bounded to the same 1 MiB as HTTP request bodies. */
export const INPUT_LIMIT_BYTES = 1024 * 1024;
const PROBE_MODE = 'luna';
const PROBE_TASK = 'Probe: rename one local variable inside a small helper function.';
const MAX_PORT = 65535;
const KEY_VARIABLES = Object.freeze(['LUNA_API_KEY', 'OPENAI_API_KEY']);
const isLoopback = (host) => host === 'localhost' || host === '::1' || host.startsWith('127.');
const HELP_HINT = 'Run "luna-core --help" for the commands and options.';

const USAGE = `Usage: luna-core <command> [options]

Commands:
  doctor [--json]              offline configuration checks; no network calls or file writes
  probe                        one live Luna call (route, strict mode); needs an API key
  route --task T               model and effort   [--context-tokens N] [--requires a,b] [--local-only]
  skills --task T              skills to load     [--dir D ...] (repeat --dir for more folders)
  retrieve --query Q           context chunks     [--root R] [--budget N] [--force]
  recall --query Q             stored memories that apply
  remember --text T            save, update or skip a memory   [--source user|agent|tool] [--dry-run]
  compress --file FILE         compact a transcript; FILE holds the input object as JSON
  serve [--port N]             HTTP sidecar on 127.0.0.1 (default port 8792)
  mcp                          MCP server on stdin and stdout
  config                       effective configuration; the API key shows as set or unset

Decision command options (route, skills, retrieve, recall, remember, compress):
  --input FILE|-               full input object as JSON (file or stdin; up to 1 MiB)
                              use instead of the command's individual input options
  --format json|text           JSON by default; text adds a readable summary and reasons
                              also available for probe

Options for every command:
  --mode auto|luna|heuristic   auto: Luna, then the rules; luna: strict; heuristic: rules only
  --config FILE                JSON config file
  -h, --help                   this text
  --version                    the version

Decisions are JSON on stdout by default; doctor is text unless --json is given.
Errors go to stderr. Exit codes: 0 ok, 1 error, 2 usage.
Keys: LUNA_API_KEY or OPENAI_API_KEY, from the environment or an env file.
`;

/** A bad command line or a bad option value. Exits 2, like any TypeError (bad input). */
export class UsageError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const str = { type: 'string' };
const multi = { type: 'string', multiple: true };
const flag = { type: 'boolean' };
const COMMON_OPTIONS = { mode: str, config: str, help: { type: 'boolean', short: 'h' }, version: flag };
const DECISION_OPTIONS = { input: str, format: str };
const INPUT_FIELDS = Object.freeze({
  route: ['task', 'steps', 'contextTokens', 'requires', 'localOnly', 'candidates'],
  skills: ['task', 'catalog', 'dirs', 'maxSkills'],
  retrieve: ['query', 'root', 'candidates', 'budgetTokens', 'force'],
  memory_recall: ['query', 'limit'],
  memory_write: ['observation', 'source', 'type', 'dryRun'],
  compress: ['window', 'segments', 'goal', 'force'],
});

const COMMANDS = Object.freeze({
  doctor: { options: { json: flag }, run: runDoctor },
  probe: { options: { format: str }, run: runProbe },
  route: { options: { ...DECISION_OPTIONS, task: str, 'context-tokens': str, requires: str, 'local-only': flag }, run: runRoute },
  skills: { options: { ...DECISION_OPTIONS, task: str, dir: multi }, run: runSkills },
  retrieve: { options: { ...DECISION_OPTIONS, query: str, root: str, budget: str, force: flag }, run: runRetrieve },
  recall: { options: { ...DECISION_OPTIONS, query: str }, run: runRecall },
  remember: { options: { ...DECISION_OPTIONS, text: str, source: str, 'dry-run': flag }, run: runRemember },
  compress: { options: { ...DECISION_OPTIONS, file: str }, run: runCompress },
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
  if (values.format !== undefined && !['json', 'text'].includes(values.format)) throw new UsageError('--format must be json or text');
  if (values.input !== undefined) {
    if (!values.input.trim()) throw new UsageError('--input needs a file path or "-" for stdin');
    const conflict = Object.keys(values).find((key) => !Object.hasOwn(COMMON_OPTIONS, key) && !Object.hasOwn(DECISION_OPTIONS, key));
    if (conflict) throw new UsageError(`--input cannot be combined with --${conflict}; put all input fields in the JSON object`);
  }
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
  io.stderr.write(`luna-core: ${scrubSecrets(err?.message ?? err, secrets)}\n`);
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
    throw new UsageError(err.message);
  }
}

function printDecision(io, decision, format) {
  if (format !== 'text') return writeJson(io.stdout, decision);
  const lines = [
    KIND_MODULES[decision.kind].summarize(decision.result),
    `Source: ${decision.source}`,
    `Luna responses received: ${decision.calls}; duration: ${decision.latencyMs} ms`,
  ];
  if (decision.confidence != null) lines.push(`Confidence: ${decision.confidence}`);
  for (const reason of decision.reasons) lines.push(`Reason: ${reason}`);
  if (decision.error) lines.push(`Fallback reason: ${decision.error}`);
  if (decision.kind === 'route') lines.push('The host must apply this model and effort recommendation.');
  if (decision.cost != null) lines.push(`Estimated decision cost (USD): ${decision.cost}`);
  if (decision.tokens != null) lines.push(`Input tokens: ${decision.tokens.input}; cached: ${decision.tokens.cached}`);
  // The result stays complete in text mode, as it does in JSON mode. Scrub diagnostic lines.
  const secrets = KEY_VARIABLES.map((key) => io.env[key]);
  io.stdout.write(`${lines.map((line) => scrubSecrets(line, secrets)).join('\n')}\n\nResult:\n${JSON.stringify(decision.result, null, 2)}\n`);
}

async function decideAndPrint(io, config, kind, input, format) {
  checkInput(kind, input, config);
  const engine = createEngine({ config, transport: io.transport });
  printDecision(io, await engine.decide(kind, input), format);
  return EXIT.OK;
}

async function runProbe({ values, io }) {
  if (values.mode !== undefined && values.mode !== PROBE_MODE) {
    throw new UsageError(`probe always runs in ${PROBE_MODE} (strict) mode; drop --mode ${values.mode}`);
  }
  const config = configFor(io, values, { mode: PROBE_MODE });
  if (!config.apiKey) {
    throw new Error('probe: no OpenAI API key; set LUNA_API_KEY or OPENAI_API_KEY in the environment or an env file');
  }
  const engine = createEngine({ config, transport: io.transport });
  printDecision(io, await engine.route({ task: PROBE_TASK }), values.format);
  return EXIT.OK;
}

async function runRoute({ values, io }) {
  if (values.input !== undefined) return runJsonInput('route', values, io);
  const input = { task: requireOption(values, 'task') };
  const contextTokens = intOption(values, 'context-tokens', { min: 0 });
  if (contextTokens !== undefined) input.contextTokens = contextTokens;
  if (values.requires !== undefined) input.requires = values.requires.split(',').map((s) => s.trim()).filter(Boolean);
  if (values['local-only']) input.localOnly = true;
  return decideAndPrint(io, configFor(io, values), 'route', input, values.format);
}

async function runSkills({ values, io }) {
  if (values.input !== undefined) return runJsonInput('skills', values, io);
  const input = { task: requireOption(values, 'task') };
  if (values.dir !== undefined) input.dirs = values.dir.map((dir) => resolveIn(io.cwd, dir));
  return decideAndPrint(io, configFor(io, values), 'skills', input, values.format);
}

async function runRetrieve({ values, io }) {
  if (values.input !== undefined) return runJsonInput('retrieve', values, io);
  const input = { query: requireOption(values, 'query') };
  if (values.root !== undefined) input.root = resolveIn(io.cwd, values.root);
  const budgetTokens = intOption(values, 'budget', { min: 1 });
  if (budgetTokens !== undefined) input.budgetTokens = budgetTokens;
  if (values.force) input.force = true;
  return decideAndPrint(io, configFor(io, values), 'retrieve', input, values.format);
}

async function runRecall({ values, io }) {
  if (values.input !== undefined) return runJsonInput('memory_recall', values, io);
  const input = { query: requireOption(values, 'query') };
  return decideAndPrint(io, configFor(io, values), 'memory_recall', input, values.format);
}

async function runRemember({ values, io }) {
  if (values.input !== undefined) return runJsonInput('memory_write', values, io);
  const input = { observation: requireOption(values, 'text') };
  if (values.source !== undefined) input.source = values.source;
  if (values['dry-run']) input.dryRun = true;
  return decideAndPrint(io, configFor(io, values), 'memory_write', input, values.format);
}

function parseInput(text, label) {
  let input;
  try {
    input = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new UsageError(`${label} is not valid JSON`);
  }
  return input;
}

function tooLarge(label) {
  return new UsageError(`${label} is over ${INPUT_LIMIT_BYTES} bytes (1 MiB)`);
}

/** Read only a bounded number of bytes, including when a file grows while it is read. */
function readInputFile(file) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > INPUT_LIMIT_BYTES) throw tooLarge(file);
    fd = fs.openSync(file, 'r');
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a regular file');
    const buffer = Buffer.alloc(INPUT_LIMIT_BYTES + 1);
    let size = 0;
    let read;
    do {
      read = fs.readSync(fd, buffer, size, buffer.length - size, null);
      size += read;
      if (size > INPUT_LIMIT_BYTES) throw tooLarge(file);
    } while (read > 0);
    return parseInput(buffer.subarray(0, size).toString('utf8'), file);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new Error(`cannot read ${file}: ${err.code ?? err.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function readStdin(input) {
  if (input.isTTY) throw new UsageError('--input - needs piped JSON on stdin; use --input FILE to read a file');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > INPUT_LIMIT_BYTES) throw tooLarge('stdin input');
      chunks.push(bytes);
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new Error(`cannot read stdin: ${err.code ?? err.message}`);
  }
  return parseInput(Buffer.concat(chunks, size).toString('utf8'), 'stdin input');
}

/** JSON paths follow the command's working folder, just like --root and --dir. */
function inputPaths(kind, input, io) {
  if (kind === 'retrieve' && typeof input.root === 'string' && input.root.trim()) {
    return { ...input, root: resolveIn(io.cwd, input.root) };
  }
  if (kind === 'skills' && Array.isArray(input.dirs)) {
    return { ...input, dirs: input.dirs.map((dir) => typeof dir === 'string' && dir.trim() ? resolveIn(io.cwd, dir) : dir) };
  }
  return input;
}

async function runJsonInput(kind, values, io) {
  const input = values.input === '-' ? await readStdin(io.stdin) : readInputFile(resolveIn(io.cwd, values.input));
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new UsageError(`${kind}: input must be an object (JSON)`);
  }
  const extra = Object.keys(input).find((key) => !INPUT_FIELDS[kind].includes(key));
  if (extra !== undefined) throw new UsageError(`${kind}: unknown input field "${extra}"`);
  return decideAndPrint(io, configFor(io, values), kind, inputPaths(kind, input, io), values.format);
}

async function runCompress({ values, io }) {
  if (values.input !== undefined) return runJsonInput('compress', values, io);
  const input = readInputFile(resolveIn(io.cwd, requireOption(values, 'file')));
  return decideAndPrint(io, configFor(io, values), 'compress', input, values.format);
}

async function runDoctor({ values, io }) {
  const report = diagnose(configFor(io, values));
  if (values.json) writeJson(io.stdout, report);
  else io.stdout.write(formatDiagnostics(report));
  return report.ok ? EXIT.OK : EXIT.ERROR;
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
