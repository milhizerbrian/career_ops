#!/usr/bin/env node
/**
 * evaluate.mjs — thin CLI wrapper around lib/evaluator.mjs.
 *
 * Reads unchecked items from data/pipeline.md, evaluates them with the same
 * engine used by the dashboard Add Job flow, then marks completed items [x].
 */

import './lib/env.mjs';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { loadPipeline, dismissPipelineItem } from './lib/data.mjs';
import { evaluateItem, loadTrackerRaw, urlToId } from './lib/evaluator.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORTALS_PATH = path.resolve(APP_ROOT, 'portals.yml');
const LM_STUDIO_BASE = 'http://localhost:1234';

export function parseCliArgs(argv = process.argv.slice(2)) {
  const valueAfter = (flag) => {
    const idx = argv.indexOf(flag);
    return idx === -1 ? null : argv[idx + 1];
  };

  const limitRaw = valueAfter('--limit');
  const concurrencyRaw = valueAfter('--concurrency');
  const daysRaw = valueAfter('--days');
  const company = valueAfter('--company') || '';

  return {
    dryRun: argv.includes('--dry-run'),
    limit: limitRaw == null ? Infinity : Number.parseInt(limitRaw, 10),
    concurrency: concurrencyRaw == null ? 1 : Number.parseInt(concurrencyRaw, 10),
    days: daysRaw == null ? null : Number.parseInt(daysRaw, 10),
    company,
  };
}

function buildLocationFilter(locationFilter) {
  const negative = (locationFilter?.negative || []).map(k => k.toLowerCase());
  return (location) => {
    if (!location) return true;
    const lower = location.toLowerCase();
    return !negative.some(k => lower.includes(k));
  };
}

export function selectPipelineItems(items, { limit = Infinity, company = '' } = {}) {
  const companyNeedle = company.trim().toLowerCase();
  const filtered = companyNeedle
    ? items.filter(item => String(item.company || '').toLowerCase().includes(companyNeedle))
    : items;
  return Number.isFinite(limit) ? filtered.slice(0, limit) : filtered;
}

async function assertLmStudioAvailable() {
  await fetch(`${LM_STUDIO_BASE}/v1/models`, { signal: AbortSignal.timeout(4000) });
}

export async function runCli(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  const opts = parseCliArgs(argv);
  const date = new Date().toISOString().slice(0, 10);

  stdout(`Career-Ops Evaluator — ${date}`);
  stdout('════════════════════════════════════════════');
  if (opts.dryRun) stdout('(dry run — no files will be written)\n');
  if (opts.days != null) stdout(`Days filter:         accepted (${opts.days}); scan.mjs owns pipeline lookback`);
  if (opts.company) stdout(`Company filter:      ${opts.company}`);

  const config = existsSync(PORTALS_PATH) ? yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) : {};
  const locationFilter = buildLocationFilter(config.location_filter);

  const pending = loadPipeline();
  stdout(`Pipeline pending:   ${pending.length} items`);
  if (pending.length === 0) {
    stdout('Nothing to evaluate.');
    return { evaluated: 0, skipped: 0, locFiltered: 0, fetchErrors: 0, scoreErrors: 0 };
  }

  const toProcess = selectPipelineItems(pending, opts);
  const concurrency = Math.max(1, Number.isFinite(opts.concurrency) ? opts.concurrency : 1);
  stdout(`Processing:         ${toProcess.length} items`);
  stdout(`Concurrency:        ${concurrency}`);
  if (toProcess.length === 0) {
    stdout('Nothing matched the selected filters.');
    return { evaluated: 0, skipped: 0, locFiltered: 0, fetchErrors: 0, scoreErrors: 0 };
  }

  const tracker = loadTrackerRaw();
  stdout(`Tracker entries:    ${Object.keys(tracker).length}`);

  try {
    await assertLmStudioAvailable();
    stdout('LM Studio:          connected\n');
  } catch {
    stderr('\nERROR: LM Studio not reachable at http://localhost:1234');
    stderr('Load a model in LM Studio and ensure the server is running.');
    return { fatal: true, evaluated: 0, skipped: 0, locFiltered: 0, fetchErrors: 0, scoreErrors: 0 };
  }

  let evaluated = 0;
  let skipped = 0;
  let locFiltered = 0;
  let fetchErrors = 0;
  let scoreErrors = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < toProcess.length) {
      const index = cursor++;
      const item = toProcess[index];
      const { url, company, title } = item;

      stdout(`\n[${index + 1}/${toProcess.length}] ${company || '?'} — ${title || '?'}`);

      if (/linkedin\.com/i.test(url)) {
        stdout('  → LinkedIn URL — scored by scan-linkedin.mjs, skipping');
        skipped++;
        if (!opts.dryRun) dismissPipelineItem(url);
        continue;
      }

      const id = urlToId(url);
      if (tracker[id]) {
        stdout(`  → Already evaluated (score: ${tracker[id].score ?? 'none'}), skipping`);
        skipped++;
        if (!opts.dryRun) dismissPipelineItem(url);
        continue;
      }

      let fetchedChars = 0;
      try {
        const result = await evaluateItem(item, {
          dryRun: opts.dryRun,
          scoreFallback: false,
          tracker,
          shouldEvaluate: (details) => {
            if (details.location && !locationFilter(details.location)) {
              stdout(`  → Location filtered: "${details.location}"`);
              locFiltered++;
              if (!opts.dryRun) dismissPipelineItem(url);
              return false;
            }
            return true;
          },
          onProgress: (stage, message) => {
            if (stage === 'fetch' && message.startsWith('Warning:')) fetchErrors++;
            if (stage === 'fetch' && message.startsWith('Fetched:')) return;
            if (stage === 'evaluate') return;
            if (stage === 'skip') return;
            stdout(`  → ${message}`);
          },
        });

        fetchedChars = result.details?.description?.length || 0;

        if (result.skipped) {
          continue;
        }

        if (opts.dryRun) {
          stdout(`  [dry-run] score=${result.entry.score} title="${result.entry.title}" (${fetchedChars} JD chars)`);
        } else {
          dismissPipelineItem(url);
          stdout(`  → Written to tracker (${fetchedChars} JD chars)`);
        }
        evaluated++;
      } catch (err) {
        scoreErrors++;
        stdout(`  → ERROR: ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, toProcess.length) }, worker);
  await Promise.all(workers);

  stdout(`\n${'━'.repeat(45)}`);
  stdout(`Evaluation Summary — ${date}`);
  stdout(`${'━'.repeat(45)}`);
  stdout(`Evaluated:          ${evaluated}`);
  stdout(`Skipped (exists):   ${skipped}`);
  stdout(`Location filtered:  ${locFiltered}`);
  stdout(`Fetch errors:       ${fetchErrors}`);
  stdout(`Score errors:       ${scoreErrors}`);
  stdout(`Tracker total:      ${Object.keys(tracker).length}`);

  if (!opts.dryRun && evaluated > 0) {
    stdout('\nDashboard will refresh on next page load (file watcher).');
  }

  return { evaluated, skipped, locFiltered, fetchErrors, scoreErrors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then(result => {
    if (result?.fatal) process.exit(1);
  }).catch(err => {
    console.error('\nFatal:', err.message);
    process.exit(1);
  });
}
