import { cleanupResumeResourceProcesses } from './resume-resource-cleanup.mjs';
import { beginResumeResourceThrottle, scheduleResumeHelperRenice } from './resume-resource-throttle.mjs';

let activeCount = 0;
let sharedThrottle = null;
let sharedTimers = [];

export function resumeMaxConcurrent(env = process.env) {
  const value = Number.parseInt(env.RESUME_MAX_CONCURRENT ?? '3', 10);
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(8, value));
}

export function activeResumeResourceCount() {
  return activeCount;
}

export function canStartResumeRun({ runningCount = 0, env = process.env } = {}) {
  return runningCount < resumeMaxConcurrent(env);
}

export function beginSharedResumeResources({
  env = process.env,
  log = process.stderr,
  cleanup = cleanupResumeResourceProcesses,
  throttleFactory = beginResumeResourceThrottle,
  timerFactory = scheduleResumeHelperRenice,
} = {}) {
  if (activeCount === 0) {
    sharedThrottle = throttleFactory({ env, log });
    sharedTimers = timerFactory({ env, log });
  }
  activeCount += 1;

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount > 0) return;

      const timers = sharedTimers;
      const throttle = sharedThrottle;
      sharedTimers = [];
      sharedThrottle = null;

      timers.forEach(timer => clearTimeout(timer));
      await throttle?.restore?.();
      await cleanup({ env, log });
    },
  };
}
