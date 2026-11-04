// Configuration: DEFAULTS, then a JSON config file, then environment variables, validated and
// deep-frozen. The API key comes only from the environment (or env files), never from the
// JSON config, so a shared config file cannot leak it.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, EFFORTS, MODES } from './defaults.js';
import { homeDir } from './envfile.js';

export const CONFIG_FILE = 'luna-core.config.json';

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** A new object: `over` merged into `base`; arrays and scalars in `over` replace. */
export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  return out;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** The config file used: explicit, LUNA_CORE_CONFIG, ./luna-core.config.json, <home>/config.json. */
export function configFileCandidates({ env = process.env, cwd = process.cwd(), file } = {}) {
  if (file) return [path.resolve(cwd, file)];
  if (env.LUNA_CORE_CONFIG) return [path.resolve(cwd, env.LUNA_CORE_CONFIG)];
  return [path.join(cwd, CONFIG_FILE), path.join(homeDir(env), 'config.json')];
}

function readConfigFile(candidates, explicit) {
  for (const f of candidates) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
    } catch (err) {
      if (err.code === 'ENOENT' && !explicit) continue;
      throw new Error(`cannot read config ${f}: ${err.message}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`config ${f} is not valid JSON: ${err.message}`);
    }
    if (!isPlainObject(json)) throw new Error(`config ${f} must be a JSON object`);
    if ('apiKey' in json || 'apiKey' in (json.luna ?? {})) throw new Error(`config ${f}: put the API key in LUNA_API_KEY or OPENAI_API_KEY, not in the config file`);
    return { file: f, json };
  }
  return { file: null, json: {} };
}

function envOverrides(env) {
  const o = { luna: {} };
  if (env.LUNA_CORE_MODE) o.mode = env.LUNA_CORE_MODE.trim().toLowerCase();
  if (env.LUNA_DECISION_URL) o.luna.url = env.LUNA_DECISION_URL;
  if (env.LUNA_DECISION_MODEL) o.luna.model = env.LUNA_DECISION_MODEL;
  if (env.LUNA_DECISION_TIMEOUT_MS) o.luna.timeoutMs = Number(env.LUNA_DECISION_TIMEOUT_MS);
  if (env.LUNA_CACHE) o.luna.cacheMode = env.LUNA_CACHE.trim().toLowerCase();
  if (env.LUNA_MIN_CONFIDENCE) o.minConfidence = Number(env.LUNA_MIN_CONFIDENCE);
  return o;
}

function check(cond, msg) {
  if (!cond) throw new Error(`config: ${msg}`);
}

const prob = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const posInt = (v) => Number.isInteger(v) && v > 0;

/** Throws a clear error for the first invalid field. */
export function validateConfig(c) {
  check(MODES.includes(c.mode), `mode must be ${MODES.join('|')}; got "${c.mode}"`);
  check(['explicit', 'implicit', 'off'].includes(c.luna.cacheMode), 'luna.cacheMode must be explicit|implicit|off');
  check(posInt(c.luna.timeoutMs), 'luna.timeoutMs must be a positive integer');
  check(posInt(c.luna.maxQuestionsPerCall), 'luna.maxQuestionsPerCall must be a positive integer');
  check(prob(c.minConfidence), 'minConfidence must be 0..1');
  check(Array.isArray(c.ladder) && c.ladder.length >= 2 && c.ladder.length <= 10, 'ladder needs 2 to 10 efforts');
  for (let i = 0; i < c.ladder.length; i++) {
    check(EFFORTS.includes(c.ladder[i]), `ladder: unknown effort "${c.ladder[i]}"`);
    if (i > 0) check(EFFORTS.indexOf(c.ladder[i]) > EFFORTS.indexOf(c.ladder[i - 1]), 'ladder must run from least to most effort without repeats');
  }
  check(prob(c.route.effortQuantile) && prob(c.route.modelQuantile), 'route quantiles must be 0..1');
  check(Array.isArray(c.route.models) && c.route.models.length > 0, 'route.models must list at least one model');
  const ids = new Set();
  for (const m of c.route.models) {
    check(typeof m.id === 'string' && m.id && !ids.has(m.id), `route.models: missing or duplicate id "${m.id}"`);
    ids.add(m.id);
    check(posInt(m.tier), `route.models ${m.id}: tier must be a positive integer`);
    check(posInt(m.contextWindow), `route.models ${m.id}: contextWindow must be a positive integer`);
    check(Array.isArray(m.efforts) && m.efforts.every((e) => EFFORTS.includes(e)), `route.models ${m.id}: efforts must list known efforts`);
  }
  check(posInt(c.skills.shortlist) && posInt(c.skills.maxSkills) && prob(c.skills.threshold), 'skills: shortlist/maxSkills positive, threshold 0..1');
  check(posInt(c.retrieve.shortlist) && posInt(c.retrieve.budgetTokens) && prob(c.retrieve.threshold), 'retrieve: shortlist/budgetTokens positive, threshold 0..1');
  check(posInt(c.retrieve.chunkLines) && c.retrieve.chunkOverlap >= 0 && c.retrieve.chunkOverlap < c.retrieve.chunkLines, 'retrieve: chunkOverlap must be below chunkLines');
  check(prob(c.memory.recallThreshold) && prob(c.memory.durableThreshold) && prob(c.memory.duplicateSimilarity), 'memory thresholds must be 0..1');
  const k = c.compress;
  check(prob(k.softRatio) && prob(k.hardRatio) && prob(k.targetRatio) && k.targetRatio <= k.softRatio && k.softRatio <= k.hardRatio, 'compress: need targetRatio <= softRatio <= hardRatio, all 0..1');
  check(Number.isInteger(k.keepRecentTurns) && k.keepRecentTurns >= 0, 'compress.keepRecentTurns must be >= 0');
  check(Number.isInteger(c.server.port) && c.server.port >= 0 && c.server.port < 65536, 'server.port must be 0..65535');
}

/**
 * The effective configuration (deep-frozen) plus where it came from.
 * @param {{env?:object, cwd?:string, file?:string, overrides?:object}} [o]
 * @returns {object} config with `apiKey`, `home` and `configFile` filled in
 */
export function loadConfig({ env = process.env, cwd = process.cwd(), file, overrides } = {}) {
  const { file: used, json } = readConfigFile(configFileCandidates({ env, cwd, file }), Boolean(file || env.LUNA_CORE_CONFIG));
  const home = homeDir(env);
  let c = deepMerge(deepMerge(deepMerge(DEFAULTS, json), envOverrides(env)), overrides ?? {});
  c = deepMerge(c, {
    home,
    configFile: used,
    apiKey: env.LUNA_API_KEY || env.OPENAI_API_KEY || '',
    organization: env.OPENAI_ORG_ID || env.OPENAI_ORGANIZATION || '',
    project: env.OPENAI_PROJECT_ID || env.OPENAI_PROJECT || '',
    memory: { path: c.memory.path || path.join(home, 'memory.jsonl') },
    ledger: { path: c.ledger.path || path.join(home, 'decisions.jsonl') },
  });
  validateConfig(c);
  return deepFreeze(c);
}

/** The LunaOptions for the client, from a loaded config. */
export function lunaOptions(c) {
  return {
    url: c.luna.url, apiKey: c.apiKey, model: c.luna.model, timeoutMs: c.luna.timeoutMs,
    cacheMode: c.luna.cacheMode, maxQuestionsPerCall: c.luna.maxQuestionsPerCall,
    organization: c.organization, project: c.project,
  };
}
