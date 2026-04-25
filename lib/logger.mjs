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
