import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS_DIR = path.resolve(APP_ROOT, 'logs');

/**
 * Creates a logger for a single generation run.
 * Writes timestamped lines to logs/run-{runId}.log and stdout.
 */
export function createLogger(runId) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.resolve(LOGS_DIR, `run-${runId}.log`);

  function log(stage, message) {
    const line = `[${new Date().toISOString()}] [${stage}] ${message}\n`;
    fs.appendFileSync(logPath, line);
    process.stdout.write(line);
  }

  log('init', `Run started: ${runId}`);
  return { log, logPath };
}

/**
 * Strips credential-looking values (API keys, bearer tokens, key=value
 * secrets) from text before it is logged.
 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b((?:x-)?api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2***');
}
