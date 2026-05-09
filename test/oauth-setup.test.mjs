import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildAuthUrl, createOAuthState, parseOAuthCallback } from '../oauth-setup.mjs';

describe('OAuth setup state protection', () => {
  it('generates high-entropy URL-safe state values', () => {
    const a = createOAuthState();
    const b = createOAuthState();
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.equal(a.length, 43);
    assert.notEqual(a, b);
  });

  it('includes state in the Google auth URL options', () => {
    let options;
    const fakeClient = {
      generateAuthUrl(opts) {
        options = opts;
        return `https://accounts.google.com/o/oauth2/v2/auth?state=${opts.state}`;
      },
    };
    const url = buildAuthUrl(fakeClient, 'state-123');
    assert.equal(options.state, 'state-123');
    assert.equal(options.access_type, 'offline');
    assert.deepEqual(options.scope, ['https://www.googleapis.com/auth/gmail.readonly']);
    assert.match(url, /state=state-123/);
  });

  it('accepts a callback with matching state', () => {
    assert.deepEqual(
      parseOAuthCallback('/?code=abc&state=expected', 'http://localhost:55555', 'expected'),
      { type: 'code', code: 'abc' }
    );
  });

  it('rejects missing callback state before token exchange', () => {
    assert.throws(
      () => parseOAuthCallback('/?code=abc', 'http://localhost:55555', 'expected'),
      /Missing OAuth state/
    );
  });

  it('rejects mismatched callback state before token exchange', () => {
    assert.throws(
      () => parseOAuthCallback('/?code=abc&state=wrong', 'http://localhost:55555', 'expected'),
      /OAuth state mismatch/
    );
  });

  it('preserves redirect and denied-auth behavior', () => {
    assert.deepEqual(
      parseOAuthCallback('/', 'http://localhost:55555', 'expected'),
      { type: 'redirect' }
    );
    assert.deepEqual(
      parseOAuthCallback('/?error=access_denied&state=expected', 'http://localhost:55555', 'expected'),
      { type: 'error', error: 'access_denied' }
    );
  });
});
