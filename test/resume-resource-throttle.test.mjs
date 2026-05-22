import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  niceCommand,
  resumeNiceLevel,
  resumeThrottleEnabled,
  scheduleResumeHelperRenice,
} from '../lib/resume-resource-throttle.mjs';

describe('resume resource throttling', () => {
  it('is enabled by default and can be disabled explicitly', () => {
    assert.equal(resumeThrottleEnabled({}), true);
    assert.equal(resumeThrottleEnabled({ RESUME_RESOURCE_THROTTLE: '0' }), false);
  });

  it('clamps resume nice level into the user-safe nice range', () => {
    assert.equal(resumeNiceLevel({ RESUME_NICE_LEVEL: '15' }), 15);
    assert.equal(resumeNiceLevel({ RESUME_NICE_LEVEL: '-5' }), 0);
    assert.equal(resumeNiceLevel({ RESUME_NICE_LEVEL: '99' }), 19);
    assert.equal(resumeNiceLevel({ RESUME_NICE_LEVEL: 'nope' }), 10);
  });

  it('wraps heavy helper commands with nice when throttling is enabled', () => {
    assert.deepEqual(
      niceCommand('/usr/bin/soffice', ['--headless'], { RESUME_NICE_LEVEL: '12' }),
      { command: 'nice', args: ['-n', '12', '/usr/bin/soffice', '--headless'] }
    );
    assert.deepEqual(
      niceCommand('/usr/bin/soffice', ['--headless'], { RESUME_RESOURCE_THROTTLE: '0' }),
      { command: '/usr/bin/soffice', args: ['--headless'] }
    );
  });

  it('does not schedule helper renice timers when helper renicing is disabled', () => {
    assert.deepEqual(scheduleResumeHelperRenice({ env: { RESUME_RENICE_HELPERS: '0' } }), []);
  });
});
