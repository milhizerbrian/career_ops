import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeResumeResourceCount,
  beginSharedResumeResources,
  canStartResumeRun,
  resumeMaxConcurrent,
} from '../lib/resume-run-coordinator.mjs';

describe('resume run coordinator', () => {
  it('allows multiple resume runs up to the configured limit', () => {
    assert.equal(resumeMaxConcurrent({ RESUME_MAX_CONCURRENT: '3' }), 3);
    assert.equal(canStartResumeRun({ runningCount: 2, env: { RESUME_MAX_CONCURRENT: '3' } }), true);
    assert.equal(canStartResumeRun({ runningCount: 3, env: { RESUME_MAX_CONCURRENT: '3' } }), false);
  });

  it('shares throttle and cleanup across overlapping resume runs', async () => {
    let throttleStarts = 0;
    let restores = 0;
    let cleanupCalls = 0;
    const timers = [{ id: 1 }, { id: 2 }];
    const cleared = [];
    const originalClearTimeout = global.clearTimeout;
    global.clearTimeout = timer => cleared.push(timer);

    try {
      const run1 = beginSharedResumeResources({
        throttleFactory: () => {
          throttleStarts += 1;
          return { restore: async () => { restores += 1; } };
        },
        timerFactory: () => timers,
        cleanup: async () => { cleanupCalls += 1; },
      });
      const run2 = beginSharedResumeResources({
        throttleFactory: () => {
          throttleStarts += 1;
          return { restore: async () => { restores += 1; } };
        },
        timerFactory: () => timers,
        cleanup: async () => { cleanupCalls += 1; },
      });

      assert.equal(activeResumeResourceCount(), 2);
      assert.equal(throttleStarts, 1);
      await run1.release();
      assert.equal(activeResumeResourceCount(), 1);
      assert.equal(restores, 0);
      assert.equal(cleanupCalls, 0);
      await run2.release();
      assert.equal(activeResumeResourceCount(), 0);
      assert.equal(restores, 1);
      assert.equal(cleanupCalls, 1);
      assert.deepEqual(cleared, timers);
    } finally {
      global.clearTimeout = originalClearTimeout;
    }
  });
});
