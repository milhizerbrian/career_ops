import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const HELPER_PATTERNS = [
  {
    name: 'LM Studio model worker',
    pattern: '/.lmstudio/.internal/utils/node.*llmworker\\.js',
  },
  {
    name: 'headless LibreOffice',
    pattern: '(soffice|LibreOffice).*--headless',
  },
];

export function resumeThrottleEnabled(env = process.env) {
  return env.RESUME_RESOURCE_THROTTLE !== '0';
}

export function resumeNiceLevel(env = process.env) {
  const value = Number.parseInt(env.RESUME_NICE_LEVEL ?? '10', 10);
  if (!Number.isFinite(value)) return 10;
  return Math.max(0, Math.min(19, value));
}

function helperReniceDelays(env = process.env) {
  return String(env.RESUME_RENICE_DELAYS_MS ?? '500,2000,5000')
    .split(',')
    .map(value => Number.parseInt(value.trim(), 10))
    .filter(value => Number.isFinite(value) && value >= 0)
    .slice(0, 8);
}

export function niceCommand(command, args = [], env = process.env) {
  if (!resumeThrottleEnabled(env)) return { command, args };
  return {
    command: 'nice',
    args: ['-n', String(resumeNiceLevel(env)), command, ...args],
  };
}

export function beginResumeResourceThrottle({ env = process.env, log = process.stderr } = {}) {
  if (!resumeThrottleEnabled(env)) return { restore: async () => {} };

  let previousPriority = null;
  try {
    previousPriority = os.getPriority(process.pid);
    os.setPriority(process.pid, resumeNiceLevel(env));
  } catch (err) {
    log?.write?.(`[resume-throttle] process priority: ${err.message}\n`);
  }

  return {
    async restore() {
      if (previousPriority == null) return;
      try {
        os.setPriority(process.pid, previousPriority);
      } catch (err) {
        log?.write?.(`[resume-throttle] restore priority: ${err.message}\n`);
      }
    },
  };
}

async function pidsForPattern(pattern) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', pattern], { timeout: 1500 });
    return stdout
      .split(/\s+/)
      .map(value => Number.parseInt(value, 10))
      .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

export async function reniceResumeHelpers({ env = process.env, log = process.stderr } = {}) {
  if (!resumeThrottleEnabled(env) || env.RESUME_RENICE_HELPERS === '0') return [];

  const level = String(resumeNiceLevel(env));
  const results = [];
  for (const target of HELPER_PATTERNS) {
    const pids = await pidsForPattern(target.pattern);
    if (!pids.length) {
      results.push({ ...target, pids, changed: false });
      continue;
    }
    try {
      await execFileAsync('renice', ['-n', level, '-p', ...pids.map(String)], { timeout: 2000 });
      results.push({ ...target, pids, changed: true });
    } catch (err) {
      log?.write?.(`[resume-throttle] ${target.name}: ${err.message}\n`);
      results.push({ ...target, pids, changed: false, error: err.message });
    }
  }
  return results;
}

export function scheduleResumeHelperRenice({ env = process.env, log = process.stderr } = {}) {
  if (!resumeThrottleEnabled(env) || env.RESUME_RENICE_HELPERS === '0') return [];

  return helperReniceDelays(env).map(delayMs => {
    const timer = setTimeout(() => {
      reniceResumeHelpers({ env, log }).catch(err => {
        log?.write?.(`[resume-throttle] helper renice: ${err.message}\n`);
      });
    }, delayMs);
    timer.unref?.();
    return timer;
  });
}
