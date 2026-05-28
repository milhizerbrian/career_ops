import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { getCachedValue, invalidateCache } from '../lib/cache.mjs';

describe('derived cache helpers', () => {
  it('reuses named workspace values until invalidated', () => {
    invalidateCache();
    let builds = 0;

    const first = getCachedValue('test:workspace', () => ({ builds: ++builds }));
    const second = getCachedValue('test:workspace', () => ({ builds: ++builds }));

    assert.equal(first, second);
    assert.equal(second.builds, 1);

    invalidateCache();
    const third = getCachedValue('test:workspace', () => ({ builds: ++builds }));
    assert.notEqual(third, second);
    assert.equal(third.builds, 2);
    invalidateCache();
  });
});
