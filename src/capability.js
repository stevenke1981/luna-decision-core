// A pure, opt-in control policy for the existing route decision. It plans work; it does
// not execute commands, discover live models, grant permissions, or attest to evidence.
import { EFFORTS } from './defaults.js';
import { redactDeep } from './contract.js';

export const FAILURE_KINDS = Object.freeze([
  'reasoning', 'implementation', 'context', 'auth', 'permission', 'network',
  'rate_limit', 'tool', 'schema', 'model_unavailable', 'unknown',
]);
export const cognitiveFailure = (kind) => ['reasoning', 'implementation'].includes(kind);
const external = (source) => ['test', 'tool', 'human'].includes(source);
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const id = { type: 'string', minLength: 1, maxLength: 256 };
const flag = { type: 'boolean' };
const integer = (minimum, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
const choice = (values) => ({ type: 'string', enum: values });
const list = (items, maxItems = 128) => ({ type: 'array', items, maxItems });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** Shared with MCP so the advertised contract and the domain boundary stay aligned. */
export const CONTROL_SCHEMA = object({
  taskId: id, revision: id, goal: text,
  acceptance: { ...list(id, 32), minItems: 1 },
  constraints: list(text, 32),
  current: object({ model: id, effort: choice(EFFORTS) }, ['model', 'effort']),
  attempts: list(object({
    id, taskId: id, model: id, effort: choice(EFFORTS),
    outcome: choice(['pass', 'fail', 'blocked']), failureKind: choice(FAILURE_KINDS),
    source: choice(['test', 'tool', 'human', 'model']), evidenceRef: text,
    fingerprint: id, hypothesis: text,
  }, ['id', 'taskId', 'model', 'effort', 'outcome'])),
  evidence: list(object({
    criterion: id, revision: id, status: choice(['pass', 'fail', 'not_run']),
    source: choice(['test', 'tool', 'human', 'model']), reference: text,
  }, ['criterion', 'revision', 'status', 'source'])),
  context: list(object({
    id, source: text, tokens: integer(1),
    relevance: { type: 'number', minimum: 0, maximum: 1 },
    required: flag, stale: flag, trust: choice(['trusted', 'untrusted']),
  }, ['id', 'source', 'tokens'])),
  contextBudgetTokens: integer(1),
  requiredTools: list(id, 64), availableTools: list(id, 64),
  tasks: list(object({
    id, dependsOn: list(id, 32), writes: list(text, 64),
    status: choice(['pending', 'running', 'done']),
  }, ['id']), 32),
  maxParallel: integer(1, 16), maxAttempts: integer(1, 128),
}, ['taskId', 'revision', 'goal', 'acceptance']);

// Validate once at the public boundary. Only this schema's JSON Schema subset is used.
function validate(schema, value, at) {
  const ok = schema.type === 'array' ? Array.isArray(value)
    : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'integer' ? Number.isSafeInteger(value)
        : schema.type === 'number' ? Number.isFinite(value) : typeof value === schema.type;
  if (!ok) throw new TypeError(`${at} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError(`${at} has an unsupported value`);
  if (typeof value === 'string' && (!value.trim() || value.length > schema.maxLength)) throw new TypeError(`${at} must be nonempty and within its length limit`);
  if (typeof value === 'number' && (value < schema.minimum || value > schema.maximum)) throw new TypeError(`${at} is out of range`);
  if (schema.type === 'array') {
    if (value.length > schema.maxItems || value.length < (schema.minItems ?? 0)) throw new TypeError(`${at} has an invalid item count`);
    value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`));
  }
  if (schema.type === 'object') {
    for (const key of schema.required) if (!Object.hasOwn(value, key)) throw new TypeError(`${at}.${key} is required`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new TypeError(`${at}.${key} is unknown`);
      validate(schema.properties[key], value[key], `${at}.${key}`);
    }
  }
}

function unique(values, at) {
  if (new Set(values).size !== values.length) throw new TypeError(`${at} must be unique`);
}

/** Normalize an outcome contract without mutating the caller. Histories are oldest first. */
export function normalizeControl(raw) {
  validate(CONTROL_SCHEMA, raw, 'route: control');
  const c = structuredClone({
    constraints: [], attempts: [], evidence: [], context: [], contextBudgetTokens: 4000,
    requiredTools: [], availableTools: [], tasks: [], maxParallel: 1, maxAttempts: 8,
    ...raw,
  });
  unique(c.acceptance, 'control.acceptance');
  for (const field of ['attempts', 'context', 'tasks']) unique(c[field].map((x) => x.id), `control.${field} ids`);
  for (const e of c.evidence) if (!c.acceptance.includes(e.criterion)) throw new TypeError('control.evidence has an unknown criterion');
  c.context = c.context.map((x) => ({ relevance: 0, required: false, stale: false, trust: 'untrusted', ...x }));
  c.tasks = c.tasks.map((x) => ({ dependsOn: [], writes: [], status: 'pending', ...x }));
  for (const task of c.tasks) for (const write of task.writes) {
    const parts = write.replace(/\\/g, '/').split('/');
    if (write !== '*' && (parts.includes('..') || /^[\\/]|^[a-z]:/i.test(write) || /[*?\[\]]/.test(write))) {
      throw new TypeError('control.tasks writes must be workspace-relative literal paths or *');
    }
  }
  const byId = new Map(c.tasks.map((x) => [x.id, x]));
  const active = new Set();
  const visited = new Set();
  function visit(task) {
    if (active.has(task.id)) throw new TypeError('control.tasks contains a dependency cycle');
    if (visited.has(task.id)) return;
    active.add(task.id);
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) throw new TypeError(`control.tasks has unknown dependency ${dep}`);
      visit(byId.get(dep));
    }
    active.delete(task.id);
    visited.add(task.id);
  }
  c.tasks.forEach(visit);
  return c;
}

function selectContext(c) {
  const selected = [];
  const omitted = [];
  const missing = [];
  let tokens = 0;
  const ranked = [...c.context].sort((a, b) => Number(b.required) - Number(a.required) || b.relevance - a.relevance);
  for (const item of ranked) {
    if (item.stale || tokens + item.tokens > c.contextBudgetTokens) {
      omitted.push(item.id);
      if (item.required) missing.push(item.id);
    } else {
      selected.push({ id: item.id, source: item.source, trust: item.trust });
      tokens += item.tokens;
    }
  }
  return { selected, omitted, missing, tokens, budgetTokens: c.contextBudgetTokens };
}

// Writes are workspace-relative file/directory resources, not commands or glob expressions.
// Case-folding is intentionally conservative for Windows; a parent directory conflicts too.
const resource = (p) => p.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/').toLowerCase() || '.';
const overlap = (a, b) => a === b || a === '*' || b === '*' || a === '.' || b === '.' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
function schedule(c) {
  const running = c.tasks.filter((x) => x.status === 'running');
  const ready = [];
  const writes = running.flatMap((x) => x.writes.map(resource));
  const done = new Set(c.tasks.filter((x) => x.status === 'done').map((x) => x.id));
  for (const task of c.tasks) {
    if (task.status !== 'pending' || !task.dependsOn.every((dep) => done.has(dep))) continue;
    if (ready.length + running.length >= c.maxParallel) break;
    const next = task.writes.map(resource);
    if (next.some((a) => writes.some((b) => overlap(a, b)))) continue;
    ready.push(task.id);
    writes.push(...next);
  }
  return { ready, running: running.map((x) => x.id), maxParallel: c.maxParallel };
}

const REMEDY = Object.freeze({
  auth: 'repair_auth', permission: 'request_authorization', network: 'repair_transport',
  rate_limit: 'wait_rate_limit', tool: 'repair_tools', schema: 'repair_config',
  context: 'gather_context', model_unavailable: 'discover_capabilities', unknown: 'diagnose',
});

/**
 * Compute the next action from normalized control input and the eligible configured catalog.
 * Evidence references are host attestations, not proof checked by this pure function.
 */
export function capabilityDecision(c, proposed, models) {
  const context = selectContext(c);
  const parallel = schedule(c);
  const receipts = new Map();
  for (const e of c.evidence) if (e.revision === c.revision && external(e.source)) receipts.set(e.criterion, e);
  const pending = c.acceptance.filter((key) => receipts.get(key)?.status !== 'pass' || !receipts.get(key)?.reference);
  const attempts = c.attempts.filter((a) => a.taskId === c.taskId);
  const current = c.current ?? { model: proposed.model, effort: proposed.effort };
  let model = models.find((m) => m.id === current.model);
  if (!model) throw new TypeError('route: control.current.model is not eligible');
  let effort = current.effort;
  let failures = 0;
  const finish = (nextAction, reason) => redactDeep({
    model: model.id, effort, nextAction, reason, taskId: c.taskId, revision: c.revision,
    verifiedFailures: failures, attemptsUsed: attempts.length,
    acceptance: { status: pending.length ? 'pending' : 'pass', pending },
    context, parallel, capabilityBasis: 'configured; host must verify against its backend',
    canExecute: ['execute', 'retry', 'raise_effort', 'escalate_model'].includes(nextAction),
  });
  // Completion is tied to all criteria on this exact revision, never model confidence.
  if (!pending.length) return finish('complete', 'all required criteria have external evidence for this revision');
  if (attempts.length >= c.maxAttempts) return finish('budget_exhausted', 'attempt budget reached; preserve evidence and hand off');
  const latest = attempts.at(-1);
  // A switch starts a new stage; old-stage outcomes must not block its first execution.
  const last = !c.current || (latest?.model === current.model && latest?.effort === current.effort)
    ? latest : undefined;
  if (last && last.outcome !== 'pass' && !cognitiveFailure(last.failureKind)) {
    return finish(REMEDY[last.failureKind] ?? 'diagnose', 'repair the reported non-cognitive failure before generating again');
  }
  if (context.missing.length) return finish('gather_context', 'required context is stale or exceeds its budget; refresh or compact it');
  if (c.requiredTools.some((tool) => !c.availableTools.includes(tool))) return finish('repair_tools', 'a required tool is not available in the executing host');
  if (!model.efforts.length) return finish('discover_capabilities', 'the configured model has no declared native effort levels');
  if (!model.efforts.includes(effort)) return finish('discover_capabilities', 'the current effort is not declared for this model');
  if (c.tasks.length && !parallel.ready.length) {
    return finish(c.tasks.every((x) => x.status === 'done') ? 'verify' : 'await_dependencies', 'no independent pending task can start now');
  }
  if (c.current) {
    const seen = new Set();
    for (let i = attempts.length - 1; i >= 0; i--) {
      const a = attempts[i];
      if (a.model !== current.model || a.effort !== current.effort || a.outcome !== 'fail'
        || !cognitiveFailure(a.failureKind) || !external(a.source) || !a.evidenceRef) break;
      if (seen.has(a.evidenceRef)) break; // rereading one failure does not create two failures
      seen.add(a.evidenceRef);
      failures++;
    }
    const prev = attempts.at(-2);
    if (failures >= 2 && last.fingerprint && last.hypothesis
      && last.fingerprint === prev.fingerprint && last.hypothesis === prev.hypothesis) {
      return finish('change_strategy', 'the same evidenced error and unchanged hypothesis repeated; collect new evidence');
    }
    if (failures >= 2) {
      const native = EFFORTS.filter((e) => model.efforts.includes(e));
      const next = native[native.indexOf(effort) + 1];
      if (next) {
        effort = next;
        return finish('raise_effort', 'two verified failures at this model/effort; start a fresh failure count at the next native level');
      }
      const stronger = models.find((m) => m.tier > model.tier && m.efforts.length);
      if (!stronger) return finish('report_blocker', 'native maximum exhausted and no stronger eligible configured model is available');
      model = stronger;
      effort = EFFORTS.filter((e) => model.efforts.includes(e))[0];
      return finish('escalate_model', 'two verified failures at native maximum; select the next eligible tier at its lowest native effort');
    }
  }
  if (last?.outcome === 'pass') return finish('verify', 'worker success is not acceptance; collect the remaining criterion evidence');
  if (last?.outcome === 'fail' && failures === 0) return finish('diagnose', 'the failure lacks current-stage external evidence');
  return finish(failures ? 'retry' : 'execute', failures ? 'one verified failure; repair with evidence before retrying' : 'ready for authorized work; preserve freedom in the solution');
}
