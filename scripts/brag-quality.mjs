#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeBragDocQuality, formatBragQualityReport } from '../lib/brag-quality.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BRAG = path.resolve(APP_ROOT, 'data', 'master-brag-document.md');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function main() {
  const bragPath = path.resolve(argValue('--brag', DEFAULT_BRAG));
  if (!fs.existsSync(bragPath)) {
    process.stderr.write(`Brag doc not found: ${bragPath}\n`);
    process.exit(1);
  }

  const report = analyzeBragDocQuality(fs.readFileSync(bragPath, 'utf8'));
  process.stdout.write(hasFlag('--json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatBragQualityReport(report));
}

main();
