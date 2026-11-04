#!/usr/bin/env node
// The `luna-core` command: loads the env files (variables already set win), then runs the CLI.
// Ctrl+C and SIGTERM stop `serve` cleanly; other commands keep the default signal behaviour.
import { loadEnvFiles } from '../src/envfile.js';
import { main } from '../src/cli.js';

const SERVE = 'serve';
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

const argv = process.argv.slice(2);
for (const failure of loadEnvFiles(process.env).filter((f) => f.error)) {
  process.stderr.write(`luna-core: cannot read ${failure.file}: ${failure.error}\n`);
}

const stop = new AbortController();
if (argv[0] === SERVE) {
  for (const signal of STOP_SIGNALS) process.once(signal, () => stop.abort());
}

process.exitCode = await main(argv, {
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: stop.signal,
});
