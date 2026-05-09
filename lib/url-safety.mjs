import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

const LOCALHOST_NAMES = new Set(['localhost']);

function parseIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(part => Number(part));
  if (nums.some(num => !Number.isInteger(num) || num < 0 || num > 255)) return null;
  return nums;
}

function ipv4FromMappedIpv6(address) {
  const match = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return match ? match[1] : '';
}

export function isPrivateAddress(address) {
  const mapped = ipv4FromMappedIpv6(address);
  const value = mapped || address;
  const family = net.isIP(value);

  if (family === 4) {
    const [a, b] = parseIpv4(value) || [];
    if (a === undefined) return true;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (family === 6) {
    const lower = value.toLowerCase();
    return (
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    );
  }

  return true;
}

export async function validatePublicHttpUrl(rawUrl, { lookup = dnsLookup } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL must be a valid http(s) URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('URL must use http or https.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || LOCALHOST_NAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('Localhost URLs are not allowed.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error('Private or local network URLs are not allowed.');
    }
    return parsed;
  }

  const results = await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('Unable to resolve URL host.');
  }
  if (results.some(result => isPrivateAddress(result.address))) {
    throw new Error('URL host resolves to a private or local network address.');
  }

  return parsed;
}
