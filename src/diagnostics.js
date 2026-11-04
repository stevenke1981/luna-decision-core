// Read-only local diagnostics. These checks inspect configuration and directory metadata;
// they never construct an engine, contact a provider, read store contents or create files.
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from './contract.js';
import { VERSION } from './version.js';

const MIN_NODE = '22.15.0';
const configuredKey = (config) => Boolean(config.apiKey);

function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 15);
}

function endpointLabel(text) {
  const url = new URL(text);
  // Query strings sometimes carry proxy credentials. Their values are not needed here.
  return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`;
}

/** Scrub each string before serialization, keeping the report valid JSON. */
function safeValue(value, secrets) {
  if (typeof value === 'string') return scrub(value, secrets);
  if (Array.isArray(value)) return value.map((item) => safeValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValue(item, secrets)]));
  }
  return value;
}

function directoryCheck(dir, id, label, cwd) {
  const resolved = path.resolve(cwd, dir);
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      return { id, status: 'fail', message: `${label}: ${resolved} is not a directory.`, action: 'Set this path to a directory.' };
    }
    fs.accessSync(resolved, fs.constants.R_OK);
    return { id, status: 'pass', message: `${label}: ${resolved}` };
  } catch (err) {
    return {
      id,
      status: err.code === 'ENOENT' ? 'warn' : 'fail',
      message: `${label}: ${resolved} (${err.code ?? 'not accessible'}).`,
      action: 'Check the path and read permissions in the selected configuration file.',
    };
  }
}

/**
 * The local configuration report. A passed check does not validate the API key or model access.
 * Missing keys are a failure in auto/luna mode; heuristic mode does not need one. Missing optional
 * folders are warnings. `ok` means no failed local check, never that a live call has succeeded.
 */
export function diagnose(config, runtime = {}) {
  const node = runtime.node ?? process.versions.node;
  const checks = [{
    id: 'node',
    status: supportedNode(node) ? 'pass' : 'fail',
    message: `Node.js ${node}; requires >= ${MIN_NODE}.`,
    ...(!supportedNode(node) ? { action: 'Install a supported Node.js version before running luna-core.' } : {}),
  }];
  if (config.mode === 'heuristic') {
    checks.push({ id: 'api-key', status: 'pass', message: 'Heuristic mode uses local rules; no API key is required.' });
  } else if (configuredKey(config)) {
    checks.push({ id: 'api-key', status: 'pass', message: 'An API key is configured. Its validity and API access have not been checked.' });
  } else {
    checks.push({
      id: 'api-key', status: 'fail',
      message: `No API key is configured. ${config.mode === 'auto' ? 'Auto mode will fall back to local rules.' : 'Luna mode cannot make a live decision.'}`,
      action: 'Set LUNA_API_KEY or OPENAI_API_KEY, or select --mode heuristic for offline decisions.',
    });
  }
  checks.push({
    id: 'generation-models', status: 'info',
    message: 'Generation models are configured candidates; account access and model capabilities have not been checked. The host must apply route results.',
  });
  if (config.route.models.every((model) => model.id.startsWith('claude-'))) {
    checks.push({
      id: 'claude-candidates', status: 'info',
      message: 'All generation candidates are Claude models. The Luna decision model is configured separately.',
      action: 'To route GPT/Codex work, set route.models to the generation models supported by your host.',
    });
  }
  if (config.skills.dirs.length === 0) {
    checks.push({
      id: 'skills', status: 'warn', message: 'No skill folders are configured.',
      action: 'Pass skills --dir DIR, supply a catalog, or set skills.dirs in an explicit or home configuration file.',
    });
  } else {
    config.skills.dirs.forEach((dir, i) => checks.push(directoryCheck(dir, `skills-${i}`, 'Skill folder', config.cwd)));
  }
  const roots = config.retrieve.allowedRoots.length ? config.retrieve.allowedRoots : [config.cwd];
  roots.forEach((root, i) => checks.push(directoryCheck(root, `retrieve-${i}`, 'Retrieval scope', config.cwd)));
  const report = {
    ok: !checks.some((check) => check.status === 'fail'),
    version: VERSION,
    offline: true,
    runtime: { node, minimumNode: MIN_NODE, platform: runtime.platform ?? process.platform, arch: runtime.arch ?? process.arch },
    mode: config.mode,
    configFile: config.configFile,
    cwd: config.cwd,
    home: config.home,
    decisionModel: {
      model: config.luna.model,
      endpoint: endpointLabel(config.luna.url),
      apiKey: configuredKey(config) ? 'set' : 'unset',
      liveCheck: 'not_run',
    },
    generationModels: config.route.models.map(({ id, tier, contextWindow, capabilities, local, efforts }) => ({
      id, tier, contextWindow, capabilities, local, efforts, availability: 'not_checked',
    })),
    skillsDirs: config.skills.dirs,
    retrievalRoots: roots,
    stores: { memory: config.memory.path, ledger: config.ledger.path, ledgerEnabled: config.ledger.enabled },
    checks,
  };
  return safeValue(report, [config.apiKey]);
}

/** A short readable report; `diagnose` already scrubbed every string. */
export function formatDiagnostics(report) {
  const lines = [
    `luna-core doctor ${report.version} (offline)`,
    `Local checks: ${report.ok ? 'passed' : 'need attention'}`,
    `Mode: ${report.mode}`,
    `Configuration: ${report.configFile ?? 'defaults and environment (no JSON config file)'}`,
    `Working folder: ${report.cwd}`,
    `Decision model: ${report.decisionModel.model}`,
    `Decision endpoint: ${report.decisionModel.endpoint}`,
    `API key: ${report.decisionModel.apiKey} (live check not run)`,
    `Generation candidates: ${report.generationModels.map((model) => model.id).join(', ')} (availability not checked)`,
    `Memory: ${report.stores.memory}`,
    `Ledger: ${report.stores.ledger} (${report.stores.ledgerEnabled ? 'enabled' : 'disabled'})`,
    '',
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.message}`);
    if (check.action) lines.push(`  ${check.action}`);
  }
  lines.push('', 'No network requests were made and no files were written.',
    'Optional live check: luna-core probe (makes a billed API call).');
  return `${lines.join('\n')}\n`;
}
