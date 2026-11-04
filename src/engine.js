// The decision engine (docs/design.md §2, §5). A decision runs: normalize → prepare → plan
// (settled, or questions for Luna) → Luna → interpret → abstain below minConfidence → gate against
// the rules → finalize → ledger. Modes: `auto` falls back to the rules on any Luna error; `luna`
// fails the decision after it is logged; `heuristic` is rules only and never calls the transport.
// The registry and the default deps are imported lazily, only when they are not injected.
import { redactDeep } from './contract.js';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { askLuna, callCost, postDecision } from './luna/client.js';
import { answersByName } from './luna/answers.js';
import { lunaOptions } from './config.js';
import { createLedger } from './ledger.js';

const MODE_HEURISTIC = 'heuristic';
const MODE_STRICT = 'luna';
const SOURCE_LUNA = 'luna';
const SOURCE_RULES = 'rules';
const SOURCE_SETTLED = 'settled';
// Decision source → the stats bucket it counts in.
const BUCKET_OF_SOURCE = Object.freeze({ settled: 'settled', rules: 'rules', luna: 'luna', 'luna+rules': 'luna' });
const DEP_KEYS = Object.freeze(['store', 'loadCatalog', 'repoIndex']);
const NO_SPEND = Object.freeze({ calls: 0, cost: null, tokens: null });
const EMPTY_KIND_STATS = Object.freeze({ decisions: 0, luna: 0, rules: 0, settled: 0, fallbacks: 0 });
const lunaFailures = new WeakSet();

/** Recognizes strict Luna failures without changing the error rethrown to library callers. */
export function isLunaFailure(error) {
  return lunaFailures.has(error);
}

/** Memoizes an async loader; a failed load is forgotten, so the next call retries it. */
function once(load) {
  let pending = null;
  return () => {
    pending ??= load().catch((err) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

const loadRegistry = once(async () => (await import('./registry.js')).KIND_MODULES);

/**
 * A cache of built values by key. An entry older than `ttlMs` is built again, so a long-running
 * serve or mcp sees edited files; `ttlMs` 0 keeps nothing and every call builds afresh.
 * @returns {(key: string, make: () => *) => *}
 */
function ttlCache(ttlMs, now) {
  const entries = new Map();
  return (key, make) => {
    const hit = entries.get(key);
    if (ttlMs > 0 && hit && now() - hit.at <= ttlMs) return hit.value;
    const at = now();
    const value = make();
    if (ttlMs > 0) entries.set(key, { value, at });
    return value;
  };
}

function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

function elapsedSince(t0) {
  return Math.round(performance.now() - t0);
}

/**
 * The default deps, built from factories (the real ones, or stubs in tests). Injected entries win.
 * The store is created on first use; the catalog is cached by its dirs, the index by resolved root,
 * and each cached entry is rebuilt once older than config.cacheTtlMs (0: never cached).
 * @param {object} config
 * @param {{createMemoryStore: Function, loadCatalog: Function, createRepoIndex: Function}} factories
 * @param {{store?: object, loadCatalog?: Function, repoIndex?: Function}} injected
 * @param {() => number} [now] clock in milliseconds (default Date.now), injected by tests
 */
export function buildDeps(config, factories, injected = {}, now = Date.now) {
  const catalogs = ttlCache(config.cacheTtlMs, now);
  const indexes = ttlCache(config.cacheTtlMs, now);
  let store = null;
  return Object.freeze({
    get store() {
      return injected.store ?? (store ??= factories.createMemoryStore(config.memory.path));
    },
    loadCatalog: injected.loadCatalog
      ?? ((dirs) => catalogs(dirs.join('|'), () => factories.loadCatalog(dirs))),
    repoIndex: injected.repoIndex
      ?? ((root) => indexes(path.resolve(root), () => factories.createRepoIndex(root, config.retrieve))),
  });
}

/** The deps for prepare and finalize: the injected object as given when complete, else defaults. */
async function resolveDeps(config, injected, now) {
  if (DEP_KEYS.every((k) => injected[k] !== undefined)) return injected;
  const [store, catalog, index] = await Promise.all([
    import('./memory/store.js'), import('./skills/catalog.js'), import('./index/repo.js'),
  ]);
  return buildDeps(config, {
    createMemoryStore: store.createMemoryStore,
    loadCatalog: catalog.loadCatalog,
    createRepoIndex: index.createRepoIndex,
  }, injected, now);
}

/** Counts the Luna calls that answered and what they cost, whether or not the decision succeeds. */
function createMeter() {
  let spend = NO_SPEND;
  return {
    wrap: (send) => async (opts, state, questions) => {
      const body = await send(opts, state, questions);
      spend = addCall(spend, callCost(body?.usage));
      return body;
    },
    snapshot: () => spend,
  };
}

function addCall(spend, { cost, tokens }) {
  return {
    calls: spend.calls + 1,
    cost: cost == null ? spend.cost : (spend.cost ?? 0) + cost,
    tokens: tokens == null ? spend.tokens : {
      input: (spend.tokens?.input ?? 0) + tokens.input,
      cached: (spend.tokens?.cached ?? 0) + tokens.cached,
    },
  };
}

/** Asks Luna, interprets the answers, abstains below minConfidence, then gates against the rules. */
async function lunaVerdict(ctx, kind, mod, input, p, meter) {
  // `kind` is set after the state, so a kind module cannot change which kind the ledger and Luna see.
  const batch = await askLuna(ctx.opts, redactDeep({ ...p.state, kind }), p.questions, meter.wrap(ctx.send));
  const luna = mod.interpret(answersByName(batch), p.ctx, ctx.config);
  if (luna.confidence != null && luna.confidence < ctx.config.minConfidence) {
    throw new Error(`${kind}: Luna abstained (confidence ${luna.confidence} < minConfidence ${ctx.config.minConfidence})`);
  }
  const rules = mod.heuristic(input, ctx.config);
  return mod.gate ? mod.gate(luna, rules, input, ctx.config) : luna;
}

/**
 * One pass at the verdict, without prepare or finalize. Never throws a Luna failure: it returns
 * `{error, spend}` in strict mode and the rules' verdict with `error` in auto mode.
 * @returns {Promise<{verdict?: object, source: string, spend: object, error?: Error}>}
 */
async function attempt(ctx, kind, mod, input) {
  if (ctx.config.mode === MODE_HEURISTIC) {
    return { verdict: mod.heuristic(input, ctx.config), source: SOURCE_RULES, spend: NO_SPEND };
  }
  const p = mod.plan(input, ctx.config);
  if (p.settled) return { verdict: p.settled, source: SOURCE_SETTLED, spend: NO_SPEND };
  const meter = createMeter();
  try {
    const verdict = await lunaVerdict(ctx, kind, mod, input, p, meter);
    return { verdict, source: verdict.source ?? SOURCE_LUNA, spend: meter.snapshot() };
  } catch (err) {
    const error = toError(err);
    const spend = meter.snapshot();
    if (ctx.config.mode === MODE_STRICT) return { error, spend, source: null };
    return { verdict: mod.heuristic(input, ctx.config), source: SOURCE_RULES, spend, error };
  }
}

function buildDecision(kind, step, verdict, latencyMs) {
  return Object.freeze({
    kind,
    source: step.source,
    result: verdict.result,
    confidence: verdict.confidence ?? null,
    reasons: Object.freeze([...(verdict.reasons ?? [])]),
    cost: step.spend.cost,
    tokens: step.spend.tokens,
    calls: step.spend.calls,
    latencyMs,
    ...(step.error ? { error: step.error.message } : {}),
  });
}

/** The ledger entry for a strict-mode failure: no decision, so no result and no summary. */
function failureDecision(kind, step, latencyMs) {
  return {
    kind,
    source: null,
    result: null,
    confidence: null,
    reasons: [],
    cost: step.spend.cost,
    tokens: step.spend.tokens,
    calls: step.spend.calls,
    latencyMs,
    error: step.error.message,
    summary: null,
  };
}

function initialStats() {
  return { decisions: 0, lunaCalls: 0, cost: 0, fallbacks: 0, errors: 0, byKind: {} };
}

function countSpend(s, spend) {
  return { ...s, lunaCalls: s.lunaCalls + spend.calls, cost: s.cost + (spend.cost ?? 0) };
}

function countError(s) {
  return { ...s, errors: s.errors + 1 };
}

function countDecision(s, kind, decision) {
  const prev = Object.hasOwn(s.byKind, kind) ? s.byKind[kind] : EMPTY_KIND_STATS;
  const bucket = BUCKET_OF_SOURCE[decision.source];
  const fellBack = decision.error != null ? 1 : 0;
  return {
    ...s,
    decisions: s.decisions + 1,
    fallbacks: s.fallbacks + fellBack,
    byKind: {
      ...s.byKind,
      [kind]: {
        ...prev,
        decisions: prev.decisions + 1,
        [bucket]: prev[bucket] + 1,
        fallbacks: prev.fallbacks + fellBack,
      },
    },
  };
}

/**
 * The engine: `decide(kind, input)` and one shortcut per kind. Every returned decision is logged.
 * @param {{config: object, transport?: Function, kinds?: Record<string, object>,
 *   deps?: {store?: object, loadCatalog?: Function, repoIndex?: Function}, ledger?: {append: Function},
 *   now?: () => number}} options
 *   `config` from loadConfig; `kinds` defaults to the registry; `deps` defaults to the real store,
 *   catalog and index, loaded on first use; `ledger` defaults to the config's ledger; `now` is the
 *   clock in milliseconds for the cache TTL (default Date.now), injected by tests.
 * @returns {Readonly<{decide: Function, route: Function, skills: Function, retrieve: Function,
 *   recall: Function, remember: Function, compress: Function, stats: () => object}>}
 */
export function createEngine({ config, transport = postDecision, kinds, deps, ledger, now = Date.now } = {}) {
  if (!config) throw new TypeError('createEngine: config is required');
  if (typeof now !== 'function') throw new TypeError('createEngine: now must be a function');
  const ctx = Object.freeze({ config, opts: lunaOptions(config), send: transport });
  const log = ledger ?? createLedger({ path: config.ledger.path, enabled: config.ledger.enabled });
  const getKinds = kinds ? async () => kinds : loadRegistry;
  const getDeps = once(() => resolveDeps(config, deps ?? {}, now));
  let stats = initialStats();

  async function moduleFor(kind) {
    const modules = await getKinds();
    if (!Object.hasOwn(modules, kind)) throw new TypeError(`unknown kind "${String(kind)}"`);
    return modules[kind];
  }

  async function decide(kind, input) {
    const mod = await moduleFor(kind);
    const t0 = performance.now();
    const normalized = mod.normalize(input, config);
    const d = (mod.prepare || mod.finalize) ? await getDeps() : undefined;
    const prepared = (await mod.prepare?.(normalized, config, d)) ?? normalized;
    const step = await attempt(ctx, kind, mod, prepared);
    stats = countSpend(stats, step.spend);
    if (step.error) stats = countError(stats);
    if (step.error && config.mode === MODE_STRICT) {
      log.append(failureDecision(kind, step, elapsedSince(t0)));
      lunaFailures.add(step.error);
      throw step.error;
    }
    if (!Object.hasOwn(BUCKET_OF_SOURCE, step.source)) throw new Error(`${kind}: invalid source "${step.source}"`);
    const finished = (await mod.finalize?.(step.verdict, prepared, config, d)) ?? step.verdict;
    const decision = buildDecision(kind, step, finished, elapsedSince(t0));
    const summary = mod.summarize(decision.result);
    stats = countDecision(stats, kind, decision);
    log.append({ ...decision, summary });
    return decision;
  }

  return Object.freeze({
    decide,
    route: (input) => decide('route', input),
    skills: (input) => decide('skills', input),
    retrieve: (input) => decide('retrieve', input),
    recall: (input) => decide('memory_recall', input),
    remember: (input) => decide('memory_write', input),
    compress: (input) => decide('compress', input),
    stats: () => structuredClone(stats),
  });
}
