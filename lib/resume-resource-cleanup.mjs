import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// LM Studio's model worker is intentionally NOT killed: resume generation
// runs on the local model, and killing it unloads the model so the next run
// reloads with LM Studio's small default context. ensureLocalModelContext()
// in resume-gen.mjs loads it with an idle TTL instead.
const PROCESS_PATTERNS = [
  {
    name: 'headless LibreOffice',
    pattern: '(soffice|LibreOffice).*--headless',
  },
];

export function resumeCleanupEnabled(env = process.env) {
  return env.RESUME_CLEANUP_PROCESSES !== '0';
}

export async function cleanupResumeResourceProcesses({ env = process.env, log = process.stderr } = {}) {
  if (!resumeCleanupEnabled(env)) return [];

  const results = [];
  for (const target of PROCESS_PATTERNS) {
    try {
      await execFileAsync('pkill', ['-f', target.pattern], { timeout: 3000 });
      results.push({ ...target, killed: true });
    } catch (err) {
      if (err.code === 1) {
        results.push({ ...target, killed: false });
        continue;
      }
      log?.write?.(`[resume-cleanup] ${target.name}: ${err.message}\n`);
      results.push({ ...target, killed: false, error: err.message });
    }
  }
  return results;
}
