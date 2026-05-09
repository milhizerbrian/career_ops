// Loads .env into process.env. Import this BEFORE any other lib module so that
// module-level constants in those files see the configured values.
//
// ESM imports are hoisted and evaluated top-to-bottom; if .env parsing happens
// after a `import './resume-gen.mjs'` statement, that file's `parseInt(process.env.X ?? '...')`
// constants will have already captured the fallback. Importing this module first
// guarantees process.env is populated before any consumer reads it.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const envPath = path.resolve(APP_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) {
        const key = m[1].trim();
        // Shell wins over .env, but a blank shell value loses to a non-blank .env value
        if (!process.env[key]) process.env[key] = m[2].trim();
      }
    }
  }
} catch { /* ignore */ }
