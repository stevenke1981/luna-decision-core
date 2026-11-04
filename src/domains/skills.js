// The `skills` decision: which skills (SKILL.md packages) a task needs. A skill the task names
// as a `/name` command, or by a distinctive hyphenated name, is forced. The others are shortlisted by BM25 over name and
// description. In `auto` mode Luna answers one predicate per shortlisted skill; the rules
// (`heuristic`) keep the lexical leaders instead. See docs/design.md §4.2.
import { createBm25, excerpt } from '../text.js';
import { verdict, certainty, mean, indexId } from '../contract.js';
import { predicateProbability } from '../luna/answers.js';

/** A lexical hit must score at least this share of the best hit's score ... */
export const LEXICAL_RATIO = 0.6;
/** ... and the best hit must reach this score; below it the task shares too little with any skill. */
export const LEXICAL_MIN = 2.0;

const TASK_CHARS = 2000;
const DESCRIPTION_CHARS = 300;
// Shorter names (ui, go) are too common in prose to force a skill.
const MIN_FORCED_NAME = 4;
// A name is whole in the task only when none of these characters touches it.
const WORD_CHARS = 'A-Za-z0-9_-';
// Only distinctive names (with a `-` or `:`, such as rust-testing) are forced when written
// bare; a plain word such as "testing" or "plan" is ordinary prose and is left to Luna.
const DISTINCTIVE = /[-:]/;

const fail = (msg) => new TypeError(`skills: ${msg}`);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches `name` in the task as a whole word, ignoring case. */
function namePattern(name) {
  return new RegExp(`(?<![/${WORD_CHARS}])${escapeRegExp(name)}(?![${WORD_CHARS}])`, 'i');
}

/** Matches `/name` as a slash command: at the start or after whitespace or an opening quote. */
function slashPattern(name) {
  return new RegExp(`(?:^|[\\s("'\`])/${escapeRegExp(name)}(?![/${WORD_CHARS}])`, 'i');
}

function isForced(skill, task) {
  if (skill.name.length < MIN_FORCED_NAME) return false;
  if (slashPattern(skill.name).test(task)) return true;
  return DISTINCTIVE.test(skill.name) && namePattern(skill.name).test(task);
}

function normalizeSkill(s, i) {
  if (!isObject(s)) throw fail(`catalog[${i}] must be an object`);
  if (typeof s.name !== 'string' || !s.name.trim()) throw fail(`catalog[${i}].name must be a non-empty string`);
  if (s.description != null && typeof s.description !== 'string') throw fail(`catalog[${i}].description must be a string`);
  if (s.path != null && typeof s.path !== 'string') throw fail(`catalog[${i}].path must be a string`);
  return { name: s.name.trim(), description: (s.description ?? '').trim(), path: s.path ?? null };
}

function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog)) throw fail('catalog must be an array');
  const out = catalog.map(normalizeSkill);
  const names = new Set();
  for (const { name } of out) {
    if (names.has(name)) throw fail(`duplicate skill name "${name}"`);
    names.add(name);
  }
  return out;
}

function normalizeDirs(dirs) {
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string' && d.trim())) {
    throw fail('dirs must be an array of folder paths');
  }
  return [...dirs];
}

/** Validates the input and returns a new object; the catalog entries are copied and checked. */
function normalize(input, cfg) {
  if (!isObject(input)) throw fail('input must be an object');
  if (typeof input.task !== 'string' || !input.task.trim()) throw fail('task must be a non-empty string');
  if (input.maxSkills !== undefined && !isPositiveInt(input.maxSkills)) throw fail('maxSkills must be a positive integer');
  return {
    task: input.task.trim(),
    maxSkills: input.maxSkills ?? cfg.skills.maxSkills,
    ...(input.catalog !== undefined ? { catalog: normalizeCatalog(input.catalog) } : {}),
    ...(input.dirs !== undefined ? { dirs: normalizeDirs(input.dirs) } : {}),
  };
}

/** Loads the catalog from `deps.loadCatalog` only when the input carries none. */
async function prepare(input, cfg, deps) {
  if (input.catalog !== undefined) return { ...input };
  if (typeof deps?.loadCatalog !== 'function') throw fail('no catalog loader in deps');
  const catalog = await deps.loadCatalog(input.dirs ?? cfg.skills.dirs);
  return { ...input, catalog: normalizeCatalog(catalog) };
}

/**
 * The forced skills, and the BM25 shortlist of the others (best first, at most
 * `cfg.skills.shortlist`), both computed from the same catalog.
 */
function candidates(input, cfg) {
  const { catalog, task } = input;
  if (!Array.isArray(catalog)) throw fail('no catalog; prepare the input before planning');
  const forced = catalog.filter((skill) => isForced(skill, task));
  const forcedNames = new Set(forced.map((skill) => skill.name));
  const index = createBm25(catalog.map((skill, i) => ({ id: String(i), text: `${skill.name} ${skill.description}` })));
  const shortlist = index.search(task, catalog.length)
    .map((hit) => ({ skill: catalog[Number(hit.id)], score: hit.score }))
    .filter(({ skill }) => !forcedNames.has(skill.name))
    .slice(0, cfg.skills.shortlist);
  return { forced, shortlist, maxSkills: input.maxSkills ?? cfg.skills.maxSkills };
}

/** Forced skills first, then `picks` in their order, cut to `maxSkills`. */
function select(forced, picks, maxSkills) {
  const pinned = forced.map((skill) => ({ skill, probability: null, reason: 'forced' }));
  return [...pinned, ...picks].slice(0, maxSkills);
}

function resultOf(selected, considered) {
  return {
    selected: selected.map(({ skill, probability, reason }) => ({
      name: skill.name, path: skill.path ?? null, probability, reason,
    })),
    considered,
  };
}

function reasonsOf(selected) {
  return selected.map(({ skill, reason }) => `${reason}: ${skill.name}`);
}

/**
 * The BM25 leaders: the best hit when it reaches LEXICAL_MIN, and each hit within LEXICAL_RATIO of it.
 * @param {{skill: object, score: number}[]} shortlist hits, best first
 * @returns {{skill: object, probability: null, reason: 'lexical'}[]}
 */
export function lexicalPicks(shortlist) {
  const top = shortlist[0]?.score ?? 0;
  if (top < LEXICAL_MIN) return [];
  return shortlist
    .filter(({ score }) => score >= LEXICAL_RATIO * top)
    .map(({ skill }) => ({ skill, probability: null, reason: 'lexical' }));
}

/** Settled with the forced skills when nothing is shortlisted; otherwise one predicate per skill. */
function plan(input, cfg) {
  const { forced, shortlist, maxSkills } = candidates(input, cfg);
  if (shortlist.length === 0) {
    const note = input.catalog.length === 0 ? 'catalog is empty' : 'no skill shares a term with the task';
    const selected = select(forced, [], maxSkills);
    return { settled: verdict(resultOf(selected, 0), null, [note, ...reasonsOf(selected)]) };
  }
  const ids = shortlist.map((_, i) => indexId('s', i));
  return {
    state: {
      task: excerpt(input.task, TASK_CHARS),
      skills: shortlist.map(({ skill }, i) => ({
        id: ids[i], name: skill.name, description: excerpt(skill.description, DESCRIPTION_CHARS),
      })),
    },
    questions: shortlist.map(({ skill }, i) => ({
      type: 'predicate',
      name: ids[i],
      instructions: `Should skill ${ids[i]} ("${skill.name}") be loaded for this task?`,
    })),
    ctx: { forced, shortlist: shortlist.map(({ skill }) => skill), maxSkills },
  };
}

/** Luna's verdict: forced skills, then shortlisted skills with p >= threshold by p desc. */
function interpret(answers, ctx, cfg) {
  const probabilities = ctx.shortlist.map((_, i) => predicateProbability(answers, indexId('s', i)));
  const picks = ctx.shortlist
    .map((skill, i) => ({ skill, probability: probabilities[i], reason: 'luna' }))
    .filter(({ probability }) => probability >= cfg.skills.threshold)
    .sort((a, b) => b.probability - a.probability);
  const selected = select(ctx.forced, picks, ctx.maxSkills);
  return verdict(resultOf(selected, ctx.shortlist.length), mean(probabilities.map(certainty)), reasonsOf(selected));
}

/** The rules' verdict, without Luna: forced skills, then the lexical leaders. */
function heuristic(input, cfg) {
  const { forced, shortlist, maxSkills } = candidates(input, cfg);
  const selected = select(forced, lexicalPicks(shortlist), maxSkills);
  return verdict(resultOf(selected, shortlist.length), null, reasonsOf(selected));
}

function summarize(result) {
  const names = result.selected.map((s) => s.name);
  const list = names.length ? ` (${names.join(', ')})` : '';
  return `skills: ${names.length} selected${list}, ${result.considered} considered`;
}

/** The `skills` kind module (src/contract.js). */
export const skills = Object.freeze({
  name: 'skills',
  normalize,
  prepare,
  plan,
  interpret,
  heuristic,
  summarize,
});
