// Configuration: DEFAULTS, then a JSON config file, then environment variables, validated and
// deep-frozen. The API key comes only from the environment (or env files), never from the
// JSON config, so a shared config file cannot leak it. On the loaded config it is readable as
// `config.apiKey` but not enumerable, so JSON.stringify and object spreads never carry it.
//
// A config file in the working folder is read by every run of the tool from that folder, so it
// is trusted less than an explicit file (--config, LUNA_CORE_CONFIG) or the home config: it may
// not set the keys in TRUSTED_ONLY_KEYS, which would send the key elsewhere or move where memory,
// the ledger and the indexed folders are.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, EFFORTS, MODES } from './defaults.js';
import { homeDir } from './envfile.js';

export const CONFIG_FILE = 'luna-core.config.json';
// Below this a summary is mostly its `[summarized N→M tokens]` marker.
const MIN_SUMMARY_CHARS = 64;
const TRUSTED_ONLY_KEYS = [['luna', 'url'], ['memory', 'path'], ['ledger', 'path'], ['skills', 'dirs'], ['retrieve', 'allowedRoots'], ['server', 'host']];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

const orDefault = (v, fallback) => (v === undefined ? fallback : v);

/** A new object: `over` merged into `base`; arrays and scalars in `over` replace. */
export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
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

/** "section.key" of the first trusted-only key the config sets, or null. */
function untrustedKey(json) {
  const hit = TRUSTED_ONLY_KEYS.find(([section, key]) => isPlainObject(json[section]) && json[section][key] !== undefined);
  return hit ? hit.join('.') : null;
}

/** The first prototype key (__proto__, constructor, prototype) found anywhere in `value`, or null. */
function unsafeKey(value) {
  if (value == null || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(k)) return k;
    const inner = unsafeKey(v);
    if (inner) return inner;
  }
  return null;
}

/** Parses and checks one config file's text; `trusted` is false for a working-folder file. */
function parseConfigFile(file, text, trusted) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`config ${file} is not valid JSON: ${err.message}`);
  }
  if (!isPlainObject(json)) throw new Error(`config ${file} must be a JSON object`);
  if ('apiKey' in json || (isPlainObject(json.luna) && 'apiKey' in json.luna)) {
    throw new Error(`config ${file}: put the API key in LUNA_API_KEY or OPENAI_API_KEY, not in the config file`);
  }
  const unsafe = unsafeKey(json);
  if (unsafe) throw new Error(`config ${file}: "${unsafe}" is not allowed as a config key`);
  const restricted = trusted ? null : untrustedKey(json);
  if (restricted) {
    throw new Error(`config ${file}: "${restricted}" can be set only in the home config or an explicit config file (--config or LUNA_CORE_CONFIG), not in a working-folder config`);
  }
  return json;
}

/** The first config file that exists, parsed. `explicit` files must exist; `cwdFile` is untrusted. */
function readConfigFile(candidates, { explicit, cwdFile }) {
  for (const f of candidates) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
    } catch (err) {
      if (err.code === 'ENOENT' && !explicit) continue;
      throw new Error(`cannot read config ${f}: ${err.message}`);
    }
    return { file: f, json: parseConfigFile(f, text, explicit || f !== cwdFile) };
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

/** A model entry with the optional fields filled in; non-objects pass through to validation. */
function withModelDefaults(m) {
  if (!isPlainObject(m)) return m;
  return {
    ...m,
    capabilities: orDefault(m.capabilities, []),
    local: orDefault(m.local, false),
    strengths: orDefault(m.strengths, ''),
  };
}

function check(cond, msg) {
  if (!cond) throw new Error(`config: ${msg}`);
}

/** An https URL without credentials, or http to 127.0.0.1 or localhost (tests, local proxies). */
function isAllowedLunaUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

const prob = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const posInt = (v) => Number.isInteger(v) && v > 0;

/** Checks every route.models entry: unique ids, positive numbers, known efforts, typed optional fields. */
function checkModels(models) {
  check(Array.isArray(models) && models.length > 0, 'route.models must list at least one model');
  const ids = new Set();
  for (const m of models) {
    check(isPlainObject(m), 'route.models entries must be objects');
    check(typeof m.id === 'string' && m.id && !ids.has(m.id), `route.models: missing or duplicate id "${m.id}"`);
    ids.add(m.id);
    check(posInt(m.tier), `route.models ${m.id}: tier must be a positive integer`);
    check(posInt(m.contextWindow), `route.models ${m.id}: contextWindow must be a positive integer`);
    check(Array.isArray(m.efforts) && m.efforts.length > 0 && m.efforts.every((e) => EFFORTS.includes(e)), `route.models ${m.id}: efforts must list known efforts`);
    check(Array.isArray(m.capabilities) && m.capabilities.every((x) => typeof x === 'string'), `route.models ${m.id}: capabilities must be an array of strings`);
    check(typeof m.local === 'boolean', `route.models ${m.id}: local must be true or false`);
    check(typeof m.strengths === 'string', `route.models ${m.id}: strengths must be a string`);
  }
}

/** Throws a clear error for the first invalid field. */
export function validateConfig(c) {
  check(MODES.includes(c.mode), `mode must be ${MODES.join('|')}; got "${c.mode}"`);
  check(['explicit', 'implicit', 'off'].includes(c.luna.cacheMode), 'luna.cacheMode must be explicit|implicit|off');
  check(isAllowedLunaUrl(c.luna.url), 'luna.url must be an https URL without credentials (http only for 127.0.0.1 or localhost)');
  check(posInt(c.luna.timeoutMs), 'luna.timeoutMs must be a positive integer');
  check(posInt(c.luna.maxQuestionsPerCall), 'luna.maxQuestionsPerCall must be a positive integer');
  check(prob(c.minConfidence), 'minConfidence must be 0..1');
  check(Array.isArray(c.ladder) && c.ladder.length >= 2 && c.ladder.length <= 10, 'ladder needs 2 to 10 efforts');
  for (let i = 0; i < c.ladder.length; i++) {
    check(EFFORTS.includes(c.ladder[i]), `ladder: unknown effort "${c.ladder[i]}"`);
    if (i > 0) check(EFFORTS.indexOf(c.ladder[i]) > EFFORTS.indexOf(c.ladder[i - 1]), 'ladder must run from least to most effort without repeats');
  }
  check(prob(c.route.effortQuantile) && prob(c.route.modelQuantile), 'route quantiles must be 0..1');
  checkModels(c.route.models);
  if (c.route.start !== null) {
    const start = c.route.start;
    check(isPlainObject(start) && c.route.models.some((m) => m.id === start.model) && EFFORTS.includes(start.effort),
      'route.start must name a configured model and a known effort');
  }
  check(posInt(c.skills.shortlist) && posInt(c.skills.maxSkills) && prob(c.skills.threshold), 'skills: shortlist/maxSkills positive, threshold 0..1');
  check(posInt(c.retrieve.shortlist) && posInt(c.retrieve.budgetTokens) && prob(c.retrieve.threshold), 'retrieve: shortlist/budgetTokens positive, threshold 0..1');
  check(Array.isArray(c.retrieve.allowedRoots) && c.retrieve.allowedRoots.every((r) => typeof r === 'string' && path.isAbsolute(r)), 'retrieve.allowedRoots must list absolute paths');
  check(posInt(c.retrieve.maxWalkMs), 'retrieve.maxWalkMs must be a positive integer');
  check(Number.isInteger(c.cacheTtlMs) && c.cacheTtlMs >= 0, 'cacheTtlMs must be a non-negative integer');
  check(posInt(c.retrieve.chunkLines) && c.retrieve.chunkOverlap >= 0 && c.retrieve.chunkOverlap < c.retrieve.chunkLines, 'retrieve: chunkOverlap must be below chunkLines');
  check(prob(c.memory.recallThreshold) && prob(c.memory.durableThreshold) && prob(c.memory.duplicateSimilarity), 'memory thresholds must be 0..1');
  const k = c.compress;
  check(prob(k.softRatio) && prob(k.hardRatio) && prob(k.targetRatio) && k.targetRatio <= k.softRatio && k.softRatio <= k.hardRatio, 'compress: need targetRatio <= softRatio <= hardRatio, all 0..1');
  check(Number.isInteger(k.keepRecentTurns) && k.keepRecentTurns >= 0, 'compress.keepRecentTurns must be >= 0');
  check(posInt(k.maxSegmentsAsked) && posInt(k.excerptChars) && posInt(k.summaryChars), 'compress: maxSegmentsAsked, excerptChars and summaryChars must be positive integers');
  check(k.summaryChars >= MIN_SUMMARY_CHARS, `compress.summaryChars must be at least ${MIN_SUMMARY_CHARS}, room for the summary marker and some text`);
  check(Number.isInteger(c.server.port) && c.server.port >= 0 && c.server.port < 65536, 'server.port must be 0..65535');
}

/** The merged config completed with the values that depend on the home folder and the file read. */
function completeConfig(merged, { home, used, env, cwd }) {
  const models = Array.isArray(merged.route.models) ? merged.route.models.map(withModelDefaults) : merged.route.models;
  return deepMerge(merged, {
    home,
    // The working folder the config was loaded for; the default scope of retrieve roots.
    cwd: path.resolve(cwd),
    configFile: used,
    organization: env.OPENAI_ORG_ID || env.OPENAI_ORGANIZATION || '',
    project: env.OPENAI_PROJECT_ID || env.OPENAI_PROJECT || '',
    memory: { path: merged.memory.path || path.join(home, 'memory.jsonl') },
    ledger: { path: merged.ledger.path || path.join(home, 'decisions.jsonl') },
    route: { models },
  });
}

/**
 * The effective configuration (deep-frozen) plus where it came from.
 * @param {{env?:object, cwd?:string, file?:string, overrides?:object}} [o]
 * @returns {object} config with `home` and `configFile` filled in; `apiKey` readable but not enumerable
 */
export function loadConfig({ env = process.env, cwd = process.cwd(), file, overrides } = {}) {
  const explicit = Boolean(file || env.LUNA_CORE_CONFIG);
  const { file: used, json } = readConfigFile(configFileCandidates({ env, cwd, file }), { explicit, cwdFile: path.join(cwd, CONFIG_FILE) });
  const home = homeDir(env);
  const merged = deepMerge(deepMerge(deepMerge(DEFAULTS, json), envOverrides(env)), overrides ?? {});
  const c = completeConfig(merged, { home, used, env, cwd });
  Object.defineProperty(c, 'apiKey', { value: env.LUNA_API_KEY || env.OPENAI_API_KEY || '', enumerable: false });
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
