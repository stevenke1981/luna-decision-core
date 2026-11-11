// The MCP stdio server (docs/design.md §6): newline-delimited JSON-RPC 2.0, protocol 2025-06-18.
// One tool per decision kind. Each tool's closed input schema is also enforced on every call, so
// an unknown or mistyped field is a tool error and never silently dropped. Stdout carries only
// JSON-RPC lines; diagnostics go to `log` (stderr by default). Requests are handled concurrently
// and each reply carries its request id.
import readline from 'node:readline';
import { decisionErrorCode } from '../engine.js';
import { ATTEMPT_OUTCOMES } from '../domains/route.js';
import { EFFORTS, MEMORY_TYPES } from '../defaults.js';
import { VERSION } from '../version.js';
import { scrubSecrets } from './http.js';

/** The MCP protocol revision this server speaks. */
export const PROTOCOL_VERSION = '2025-06-18';
/** The name reported in `initialize` serverInfo. */
export const SERVER_NAME = 'luna-decision-core';
const CODE = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 });
const STEP_KINDS = ['read', 'edit', 'verify', 'exec', 'tool'];
const SOURCES = ['user', 'agent', 'tool'];
const writeStderr = (line) => process.stderr.write(line);

const str = (description) => ({ type: 'string', description });
const int = (description, minimum) => ({ type: 'integer', minimum, description });
const num = (description, minimum) => ({ type: 'number', minimum, description });
const flag = (description) => ({ type: 'boolean', description });
const list = (description, items) => ({ type: 'array', description, items });
const closed = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const STEP = closed({
  kind: { type: 'string', enum: STEP_KINDS, description: 'What the step did.' },
  command: str('The command or action, as text.'),
  failed: { type: ['boolean', 'null'], description: 'true if it failed, false if it passed, null if still running.' },
}, ['kind', 'command']);
const EFFORT = { type: 'string', enum: EFFORTS };
const ATTEMPT = closed({
  attemptId: str('Unique generation attempt id.'),
  model: str('The model actually used.'),
  effort: EFFORT,
  outcome: { type: 'string', enum: ATTEMPT_OUTCOMES },
}, ['attemptId', 'model', 'effort', 'outcome']);
const AVAILABLE_MODEL = closed({
  id: str('Model id reported by the executor.'),
  efforts: list('Reasoning efforts supported by the executor.', EFFORT),
}, ['id', 'efforts']);
const SKILL = closed({
  name: str('Skill name.'),
  description: str('What the skill is for.'),
  path: str('Where its SKILL.md lives.'),
}, ['name']);
const CHUNK = closed({
  id: str('Unique chunk id.'),
  source: str('Where the text came from, e.g. a file path.'),
  text: str('The chunk text.'),
  startLine: int('First line, 1-based.', 1),
  endLine: int('Last line, 1-based, at least startLine.', 1),
  score: num('Lexical score if known; higher ranks first.', 0),
}, ['id', 'source', 'text']);
const SEGMENT = closed({
  id: str('Unique segment id.'),
  role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'], description: 'Who wrote the segment.' },
  text: str('The segment text.'),
  turn: int('Turn number, 0 for the oldest.', 0),
  tokens: int('Token count; estimated from the text when omitted.', 0),
  pinned: flag('Never compress this segment.'),
}, ['id', 'role', 'text', 'turn']);

const TOOLS = Object.freeze([
  {
    name: 'luna_route',
    kind: 'route',
    description: 'Choose the model and reasoning effort for the next generation of a coding task.',
    inputSchema: closed({
      task: str('The user task.'),
      steps: list('Recent agent steps, oldest first. Used for legacy escalation when attempts is omitted.', STEP),
      attempts: list('Generation outcomes, oldest first.', ATTEMPT),
      availableModels: list('Current executor model and effort capabilities.', AVAILABLE_MODEL),
      contextTokens: num('Tokens of context the request carries; the model window must fit it.', 0),
      requires: list('Capabilities the model must have, e.g. tools, vision.', { type: 'string' }),
      localOnly: flag('Only local models are eligible.'),
      candidates: list('Restrict the choice to these model ids.', { type: 'string' }),
    }, ['task']),
  },
  {
    name: 'luna_skills',
    kind: 'skills',
    description: 'Choose which skills (SKILL.md packages) to load for a task.',
    inputSchema: closed({
      task: str('The user task.'),
      catalog: list('Skills to choose from; when omitted the configured folders are scanned.', SKILL),
      dirs: list('Folders to scan for <dir>/<skill>/SKILL.md.', { type: 'string' }),
      maxSkills: int('At most this many skills.', 1),
    }, ['task']),
  },
  {
    name: 'luna_retrieve',
    kind: 'retrieve',
    description: 'Decide whether a query needs repository or memory context, and which chunks are relevant.',
    inputSchema: closed({
      query: str('What the agent is trying to answer or do.'),
      root: str('Repository folder to index when no candidates are given.'),
      candidates: list('Candidate chunks to rank.', CHUNK),
      budgetTokens: int('Token budget for the chunks returned.', 1),
      force: flag('Retrieve even when the rules would not.'),
    }, ['query']),
  },
  {
    name: 'luna_recall',
    kind: 'memory_recall',
    description: 'Pick the stored memories that apply to a query.',
    inputSchema: closed({
      query: str('The query to match memories against.'),
      limit: int('At most this many memories.', 1),
    }, ['query']),
  },
  {
    name: 'luna_remember',
    kind: 'memory_write',
    description: 'Decide whether an observation is saved as a new memory, used to update a similar one, or skipped.',
    inputSchema: closed({
      observation: str('The text to consider remembering.'),
      source: { type: 'string', enum: SOURCES, description: 'Where the observation came from.' },
      type: { type: 'string', enum: MEMORY_TYPES, description: 'Memory type; guessed when omitted.' },
      dryRun: flag('Decide without writing the store.'),
    }, ['observation']),
  },
  {
    name: 'luna_compress',
    kind: 'compress',
    description: 'Decide whether to compact a context window now, and keep, summarize or drop each old segment.',
    inputSchema: closed({
      window: int('The model context window in tokens.', 1),
      segments: list('The transcript segments, oldest first.', SEGMENT),
      goal: str('What the agent is working toward; helps keep the right parts.'),
      force: flag('Compact even below the soft limit.'),
    }, ['window', 'segments']),
  },
]);

const TYPE_TESTS = {
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  integer: (v) => Number.isInteger(v),
  number: (v) => Number.isFinite(v),
  array: (v) => Array.isArray(v),
  object: (v) => isObject(v),
  null: (v) => v === null,
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const firstOf = (messages) => messages.find(Boolean) ?? null;

function objectViolation(schema, value, where) {
  const { properties, required = [], additionalProperties } = schema;
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) return `${where}.${missing} is required`;
  const extra = additionalProperties === false ? Object.keys(value).find((key) => !Object.hasOwn(properties, key)) : undefined;
  if (extra !== undefined) return `${where} has an unknown field "${extra}"`;
  return firstOf(Object.entries(properties)
    .filter(([key]) => Object.hasOwn(value, key))
    .map(([key, sub]) => violation(sub, value[key], `${where}.${key}`)));
}

/**
 * The first way `value` breaks `schema` (the subset of JSON Schema the tools use), or null.
 * Checks type, enum, minimum, items, required and additionalProperties, recursively.
 * @returns {string|null}
 */
function violation(schema, value, where) {
  const types = [schema.type].flat();
  if (schema.type !== undefined && !types.some((t) => TYPE_TESTS[t](value))) return `${where} must be ${types.join(' or ')}`;
  if (schema.enum && !schema.enum.includes(value)) return `${where} must be one of ${schema.enum.join(', ')}`;
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) return `${where} must be at least ${schema.minimum}`;
  if (Array.isArray(value) && schema.items) return firstOf(value.map((item, i) => violation(schema.items, item, `${where}[${i}]`)));
  if (isObject(value) && schema.properties) return objectViolation(schema, value, where);
  return null;
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// A request id is a string, a number or null; anything else is replied to as null.
function idOf(msg) {
  const id = msg?.id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
}
const errorReply = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolResult = (payload, isError) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError });
const isResponse = (msg) => 'result' in msg || 'error' in msg;

async function callTool(params, ctx) {
  if (!isObject(params)) throw new RpcError(CODE.INVALID_PARAMS, 'tools/call params must be an object');
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw new RpcError(CODE.INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
  const args = params.arguments ?? {};
  const problem = violation(tool.inputSchema, args, 'arguments');
  if (problem) return toolResult({ error: problem, errorCode: 'INVALID_INPUT' }, true);
  try {
    return toolResult(await ctx.engine.decide(tool.kind, args), false);
  } catch (err) {
    return toolResult({
      error: scrubSecrets(err?.message ?? err, ctx.secrets),
      errorCode: decisionErrorCode(err, err instanceof TypeError ? 'INVALID_INPUT' : 'INTERNAL_ERROR'),
    }, true);
  }
}

async function dispatch(method, params, ctx) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: ctx.version } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call':
      return callTool(params, ctx);
    default:
      throw new RpcError(CODE.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function errorFor(id, err, ctx) {
  if (err instanceof RpcError) return errorReply(id, err.code, err.message);
  ctx.log(`luna-core: mcp: ${scrubSecrets(err?.message ?? err, ctx.secrets)}\n`);
  return errorReply(id, CODE.INTERNAL, 'Internal error');
}

function invalidRequest(msg) {
  const message = Array.isArray(msg) ? 'Batch requests are not supported' : 'Invalid Request';
  return errorReply(idOf(msg), CODE.INVALID_REQUEST, message);
}

/** The reply to one line of input, or null when there is none (a notification, or a client reply). */
async function reply(line, ctx) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return errorReply(null, CODE.PARSE, 'Parse error');
  }
  if (!isObject(msg)) return invalidRequest(msg);
  if (typeof msg.method !== 'string') return isResponse(msg) ? null : invalidRequest(msg);
  if (msg.jsonrpc !== '2.0') return invalidRequest(msg);
  if (msg.method.startsWith('notifications/')) return null;
  const isNotification = !Object.hasOwn(msg, 'id');
  const id = idOf(msg);
  try {
    const result = await dispatch(msg.method, msg.params, ctx);
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (err) {
    return isNotification ? null : errorFor(id, err, ctx);
  }
}

/** Reads lines until `input` ends, handing each to `onLine`; resolves once every reply is written. */
function readLines(input, onLine, log) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const pending = new Set();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const job = onLine(line).catch((err) => log(`luna-core: mcp: ${err?.message ?? err}\n`));
      pending.add(job);
      job.finally(() => pending.delete(job));
    });
    rl.on('close', () => {
      Promise.all([...pending]).then(() => resolve(), reject);
    });
    input.on('error', reject);
  });
}

/**
 * The MCP server. `run()` serves until `input` ends and resolves once every reply is written.
 * @param {{engine: object, input?: object, output?: object, version?: string, config?: object,
 *   log?: (line: string) => void}} options `config` (optional) supplies the API key to scrub from errors
 * @returns {Readonly<{run: () => Promise<void>}>}
 */
export function createMcpServer({ engine, input = process.stdin, output = process.stdout, version = VERSION, config, log = writeStderr } = {}) {
  if (!engine) throw new TypeError('createMcpServer: engine is required');
  const ctx = Object.freeze({ engine, version, log, secrets: Object.freeze([config?.apiKey].filter(Boolean)) });
  const onLine = async (line) => {
    const out = await reply(line, ctx);
    if (out) output.write(`${JSON.stringify(out)}\n`);
  };
  return Object.freeze({ run: () => readLines(input, onLine, log) });
}
