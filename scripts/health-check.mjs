#!/usr/bin/env node
import '../lib/env.mjs';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { getLmStudioAnalysisModel } from '../lib/lm-studio-config.mjs';
import { resolveTemplatePath } from '../lib/docx-utils.mjs';
import { validateTracker } from '../lib/tracker-store.mjs';

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LM_STUDIO_BASE = 'http://localhost:1234';

export function makeCheck(status, name, message) {
  return { status, name, message };
}

export function isEnabled(value) {
  return /^(1|true|yes)$/i.test(String(value ?? '0'));
}

export function checkNodeVersion(version = process.versions.node, minimumMajor = 18) {
  const major = Number(String(version).split('.')[0]);
  if (Number.isFinite(major) && major >= minimumMajor) {
    return makeCheck('PASS', 'Node version', `v${version}`);
  }
  return makeCheck('FAIL', 'Node version', `v${version}; requires ${minimumMajor}+`);
}

export function checkAnthropicEnv(env = process.env) {
  if (env.ANTHROPIC_API_KEY) return makeCheck('PASS', 'Anthropic key', 'present');
  return makeCheck('WARN', 'Anthropic key', 'missing; Claude fallback/polish unavailable');
}

export function checkGmailEnv(env = process.env) {
  const keys = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
  const present = keys.filter(key => env[key]);
  if (present.length === keys.length) return makeCheck('PASS', 'Gmail OAuth env', 'present');
  if (present.length === 0) return makeCheck('WARN', 'Gmail OAuth env', 'missing; Gmail sync disabled');
  return makeCheck('FAIL', 'Gmail OAuth env', `partial; missing ${keys.filter(key => !env[key]).join(', ')}`);
}

export function checkPdfExportEnv(env = process.env) {
  if (!isEnabled(env.RESUME_PDF_EXPORT)) {
    return makeCheck('PASS', 'PDF tools', 'skipped; RESUME_PDF_EXPORT=0');
  }
  return null;
}

async function commandExists(command, args = ['--version']) {
  try {
    await execFileAsync(command, args, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function sofficeCandidates(env = process.env) {
  return [
    env.RESUME_SOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice',
    'soffice',
  ].filter(Boolean);
}

export async function checkPdfTools(env = process.env) {
  const skipped = checkPdfExportEnv(env);
  if (skipped) return skipped;

  const hasSoffice = await firstAvailableCommand(sofficeCandidates(env), ['--version']);
  const hasPdfinfo = await commandExists('pdfinfo', ['-v']);
  if (hasSoffice && hasPdfinfo) return makeCheck('PASS', 'PDF tools', 'LibreOffice and pdfinfo available');
  const missing = [
    hasSoffice ? null : 'LibreOffice/soffice',
    hasPdfinfo ? null : 'pdfinfo',
  ].filter(Boolean).join(', ');
  return makeCheck('FAIL', 'PDF tools', `missing ${missing}`);
}

async function firstAvailableCommand(commands, args) {
  for (const command of commands) {
    if (await commandExists(command, args)) return command;
  }
  return '';
}

export async function fetchLmStudioModels(fetchImpl = fetch, timeoutMs = 2500) {
  const res = await fetchImpl(`${LM_STUDIO_BASE}/v1/models`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const models = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return models.map(model => typeof model === 'string' ? model : model.id).filter(Boolean);
}

export async function checkLmStudio(fetchImpl = fetch, env = process.env) {
  const configuredModel = getLmStudioAnalysisModel(env);
  try {
    const models = await fetchLmStudioModels(fetchImpl);
    const hasModel = models.includes(configuredModel);
    return [
      makeCheck('PASS', 'LM Studio reachable', `${models.length} model(s) reported`),
      hasModel
        ? makeCheck('PASS', 'Configured LM model', configuredModel)
        : makeCheck('WARN', 'Configured LM model', `${configuredModel} not reported by LM Studio`),
    ];
  } catch (err) {
    return [
      makeCheck('WARN', 'LM Studio reachable', `unavailable: ${err.message}`),
      makeCheck('WARN', 'Configured LM model', `${configuredModel}; not checked`),
    ];
  }
}

export function checkPlaywrightChromium() {
  try {
    const executable = chromium.executablePath();
    if (executable && fs.existsSync(executable)) {
      return makeCheck('PASS', 'Playwright Chromium', 'installed');
    }
    return makeCheck('FAIL', 'Playwright Chromium', 'browser executable not found');
  } catch (err) {
    return makeCheck('FAIL', 'Playwright Chromium', err.message);
  }
}

export function checkResumeTemplate() {
  try {
    const templatePath = resolveTemplatePath();
    fs.accessSync(templatePath, fs.constants.R_OK);
    return makeCheck('PASS', 'Resume template', path.relative(APP_ROOT, templatePath));
  } catch (err) {
    return makeCheck('FAIL', 'Resume template', err.message);
  }
}

export function checkTrackerJson(trackerPath = path.resolve(APP_ROOT, 'data', 'tracker.json')) {
  try {
    if (!fs.existsSync(trackerPath)) return makeCheck('WARN', 'Tracker JSON', 'missing; no jobs loaded');
    const parsed = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
    validateTracker(parsed);
    return makeCheck('PASS', 'Tracker JSON', `${Object.keys(parsed).length} job(s)`);
  } catch (err) {
    return makeCheck('FAIL', 'Tracker JSON', err.message);
  }
}

export function checkProfileYaml(profilePath = path.resolve(APP_ROOT, 'config', 'profile.yml')) {
  try {
    yaml.load(fs.readFileSync(profilePath, 'utf8'));
    return makeCheck('PASS', 'Profile YAML', path.relative(APP_ROOT, profilePath));
  } catch (err) {
    return makeCheck('FAIL', 'Profile YAML', err.message);
  }
}

export function checkOutputWritable(outputDir = path.resolve(APP_ROOT, 'output')) {
  const probe = path.join(outputDir, `.health-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return makeCheck('PASS', 'Output directory', 'writable');
  } catch (err) {
    try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch {}
    return makeCheck('FAIL', 'Output directory', err.message);
  }
}

export async function runHealthChecks({ env = process.env, fetchImpl = fetch } = {}) {
  const lmChecks = await checkLmStudio(fetchImpl, env);
  const trackerPath = env.CAREER_OPS_TRACKER_PATH || (
    env.CAREER_OPS_DATA_DIR ? path.resolve(env.CAREER_OPS_DATA_DIR, 'tracker.json') : undefined
  );
  const profilePath = env.CAREER_OPS_CONFIG_DIR
    ? path.resolve(env.CAREER_OPS_CONFIG_DIR, 'profile.yml')
    : undefined;
  const checks = [
    checkNodeVersion(),
    ...lmChecks,
    checkAnthropicEnv(env),
    checkGmailEnv(env),
    await checkPdfTools(env),
    checkPlaywrightChromium(),
    checkResumeTemplate(),
    checkTrackerJson(trackerPath),
    checkProfileYaml(profilePath),
    checkOutputWritable(),
  ];
  if (isEnabled(env.CAREER_OPS_HEALTH_NON_SECRET)) {
    return checks.map(check => (
      check.status === 'FAIL' && ['Playwright Chromium', 'Resume template', 'Profile YAML'].includes(check.name)
        ? { ...check, status: 'WARN', message: `${check.message}; skipped in non-secret CI mode` }
        : check
    ));
  }
  return checks;
}

export function formatChecks(checks) {
  const width = Math.max(...checks.map(check => check.name.length), 1);
  return checks
    .map(check => `${check.status.padEnd(4)} ${check.name.padEnd(width)} ${check.message}`)
    .join(os.EOL);
}

export function exitCodeForChecks(checks) {
  return checks.some(check => check.status === 'FAIL') ? 1 : 0;
}

export async function main({ stdout = process.stdout } = {}) {
  const checks = await runHealthChecks();
  stdout.write(formatChecks(checks) + os.EOL);
  process.exitCode = exitCodeForChecks(checks);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    process.stderr.write(`FAIL Health check ${err.message}\n`);
    process.exitCode = 1;
  });
}
