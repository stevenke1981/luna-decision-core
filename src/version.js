// The package version, read from package.json so the CLI, the HTTP health answer and the MCP
// server info never drift from the published number.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

/** The version string from package.json, e.g. "0.1.0". */
export const VERSION = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8')).version;
