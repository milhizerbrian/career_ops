import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isPrivateAddress, validatePublicHttpUrl } from '../lib/url-safety.mjs';

const publicLookup = async () => [{ address: '34.120.200.100', family: 4 }];

describe('validatePublicHttpUrl', () => {
  it('rejects localhost', async () => {
    await assert.rejects(
      () => validatePublicHttpUrl('http://localhost:3000/job'),
      /Localhost URLs are not allowed/
    );
  });

  it('rejects loopback IPs', async () => {
    await assert.rejects(
      () => validatePublicHttpUrl('http://127.0.0.1:3000/job'),
      /Private or local network URLs are not allowed/
    );
  });

  it('rejects metadata service IPs', async () => {
    await assert.rejects(
      () => validatePublicHttpUrl('http://169.254.169.254/latest/meta-data'),
      /Private or local network URLs are not allowed/
    );
  });

  it('rejects private IP ranges', async () => {
    for (const url of [
      'http://10.0.0.5/job',
      'http://172.16.1.10/job',
      'http://192.168.1.20/job',
      'http://[::1]/job',
      'http://[fd00::1]/job',
    ]) {
      await assert.rejects(
        () => validatePublicHttpUrl(url),
        /Private or local network URLs are not allowed/
      );
    }
  });

  it('rejects hostnames that resolve to private IPs', async () => {
    await assert.rejects(
      () => validatePublicHttpUrl('https://careers.example.com/job', {
        lookup: async () => [{ address: '10.1.2.3', family: 4 }],
      }),
      /resolves to a private or local network address/
    );
  });

  it('accepts known safe ATS URLs', async () => {
    const url = await validatePublicHttpUrl(
      'https://boards.greenhouse.io/wiz/jobs/6372189003',
      { lookup: publicLookup }
    );
    assert.equal(url.hostname, 'boards.greenhouse.io');
  });
});

describe('isPrivateAddress', () => {
  it('detects mapped IPv4 loopback addresses', () => {
    assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  });
});
