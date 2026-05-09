# SQLite Migration Plan

This is a planning document only. Do not implement SQLite from this plan without a separate change request.

## Current Source Of Truth

`data/tracker.json` remains the application source of truth until the atomic JSON tracker store is stable under normal dashboard, scanner, Gmail, resume, and recruiter-targeting writes. SQLite should begin as a read-only mirror or shadow-write target, not as the primary runtime store.

## Goals

- Preserve the current dashboard/API behavior while reducing JSON contention and ad hoc nested writes.
- Normalize frequently queried data into relational tables.
- Keep export back to the current JSON shape simple and lossless.
- Allow phased rollout with feature flags and easy rollback.

## Proposed Tables

### `jobs`

Primary row per tracker entry.

Suggested columns:
- `id text primary key`
- `company text`
- `title text`
- `url text`
- `source text`
- `status text`
- `score real`
- `ats_score real`
- `location text`
- `date_updated text`
- `date_added text`
- `next_steps text`
- `notes text`
- `last_email_subject text`
- `last_email_date text`
- `last_email_snippet text`
- `description_preview text`
- `full_description text`
- `report_json text`
- `oi_signals_json text`
- `raw_json text not null`
- `created_at text`
- `updated_at text`

Notes:
- `raw_json` preserves unknown or rarely used fields for backward-compatible export.
- `status` should use canonical values from `lib/status-utils.mjs`.

### `generated_docs`

Generated resume metadata, keyed by job and variant.

Suggested columns:
- `id integer primary key autoincrement`
- `job_id text not null references jobs(id) on delete cascade`
- `variant text not null default 'default'`
- `docx_url text not null`
- `pdf_url text null`
- `page_count integer null`
- `page_validation_status text`
- `page_validation_message text`
- `page_validation_json text`
- `generated_at text not null`
- `raw_json text`
- `unique(job_id, variant)`

This maps directly from `generatedDocs.default = { docxUrl, pdfUrl, pageCount, pageValidation, generatedAt }`. `pdf_url` must stay nullable.

### `gmail_events`

Matched or discovered Gmail job events.

Suggested columns:
- `id integer primary key autoincrement`
- `job_id text null references jobs(id) on delete set null`
- `gmail_thread_id text`
- `gmail_message_id text`
- `company text`
- `title text`
- `subject text`
- `snippet text`
- `event_date text`
- `status text`
- `next_steps text`
- `match_confidence real`
- `match_status text`
- `source_url text`
- `raw_json text`
- `created_at text`

Use `match_status` for values such as `matched`, `ambiguous`, and `unmatched` so Gmail ambiguity remains explicit.

### `recruiter_contacts`

Outreach targeting and contact attempt history.

Suggested columns:
- `id integer primary key autoincrement`
- `job_id text not null references jobs(id) on delete cascade`
- `contact_type text`
- `name text`
- `title text`
- `linkedin_url text`
- `best_connection_path text`
- `suggested_message text`
- `follow_up_date text`
- `response_status text`
- `attempt_date text`
- `attempt_channel text`
- `attempt_message text`
- `attempt_status text`
- `raw_json text`
- `created_at text`
- `updated_at text`

The current `job.recruiterTargeting` object can be represented as one summary row plus one row per `contactAttempts` entry, or split later into `recruiter_targets` and `recruiter_contact_attempts` if the UI needs richer querying.

### `applications`

Application/submission log derived from tracker status changes and human-readable application records.

Suggested columns:
- `id integer primary key autoincrement`
- `job_id text not null references jobs(id) on delete cascade`
- `application_date text`
- `status text`
- `variant text`
- `channel text`
- `notes text`
- `raw_json text`
- `created_at text`
- `updated_at text`

This table should be populated conservatively at first from existing tracker fields and A/B submissions. Do not infer application dates when the source data is missing.

### `scan_history`

Deduplication history currently represented by `data/scan-history.tsv`.

Suggested columns:
- `id integer primary key autoincrement`
- `source text`
- `url text not null`
- `company text`
- `title text`
- `seen_at text`
- `matched_job_id text null references jobs(id) on delete set null`
- `raw_line text`
- `unique(url)`

Keep `raw_line` so TSV export can preserve unrecognized columns during migration.

### `ab_analytics`

Submission-level A/B data currently stored in `data/ab-analytics.json`.

Suggested columns:
- `id integer primary key autoincrement`
- `job_id text not null references jobs(id) on delete cascade`
- `variant text not null`
- `submitted_at text not null`
- `raw_json text`
- `unique(job_id, variant)`

Alternative: use `analytics_versions` if analytics expands beyond resume variants.

Suggested `analytics_versions` columns:
- `id integer primary key autoincrement`
- `kind text not null`
- `version_key text not null`
- `label text`
- `metadata_json text`
- `created_at text`
- `unique(kind, version_key)`

## Migration Path From `tracker.json`

1. Snapshot current files:
   - `data/tracker.json`
   - `data/gmail-jobs.json`
   - `data/scan-history.tsv`
   - `data/ab-analytics.json`
2. Validate JSON with the existing tracker validator and normalize statuses using `normalizeStatus`.
3. Create SQLite schema in a local database such as `data/career-ops.sqlite`.
4. Import each tracker entry into `jobs`.
5. Copy the full original job object to `jobs.raw_json`.
6. Import `job.generatedDocs` entries into `generated_docs`, preserving old shapes in `raw_json`.
7. Import `job.recruiterTargeting` into `recruiter_contacts`, preserving contact attempts.
8. Import Gmail-derived fields from tracker entries into `gmail_events`; import broad discoveries from `data/gmail-jobs.json` as unmatched events.
9. Import `data/scan-history.tsv` into `scan_history`.
10. Import `data/ab-analytics.json.submissions` into `ab_analytics`.
11. Run parity checks before any runtime path reads from SQLite.

## Rollback And JSON Export

Rollback must be possible without SQLite availability.

Export process:
1. Read `jobs` ordered by `id`.
2. Start each job object from `jobs.raw_json`.
3. Overlay normalized top-level columns that changed in SQLite.
4. Rebuild `generatedDocs` from `generated_docs` grouped by `job_id` and `variant`.
5. Rebuild `recruiterTargeting` from `recruiter_contacts`, including `contactAttempts`.
6. Overlay Gmail latest fields from the newest matched `gmail_events` row.
7. Write to a temporary file, validate with the tracker validator, then atomically rename to `data/tracker.json`.
8. Export `scan_history` back to `data/scan-history.tsv`.
9. Export `ab_analytics` back to `{ "submissions": [...] }`.

During early rollout, keep automatic periodic JSON exports enabled so rollback is a file switch, not a recovery project.

## Validation Checks

- Row count parity: tracker job count equals `jobs` count.
- Required fields: every `jobs.id` is non-empty; `company` and `title` are strings when present.
- Status parity: all statuses normalize to canonical values.
- Generated docs parity: every `generatedDocs` variant has a row; `docx_url` is present; `pdf_url` may be null.
- Resume metadata parity: `pageValidation` survives import/export.
- Gmail parity: matched Gmail fields on jobs survive export.
- Recruiter parity: `responseStatus`, suggested message, contacts, and contact attempts survive export.
- Scan dedupe parity: every TSV URL appears once in `scan_history`.
- A/B parity: submission counts by variant match existing analytics.
- Round-trip parity: `tracker.json -> SQLite -> tracker.json` should produce semantically equivalent JSON after normalization.

## Phased Rollout

1. **Plan only**
   - Land this document. No runtime code or DB behavior changes.
2. **Offline importer/exporter**
   - Add scripts that read JSON/TSV inputs and write SQLite, then export JSON.
   - Run only against copied data.
3. **Shadow database**
   - On app startup or manual command, build SQLite from JSON.
   - Dashboard and APIs continue reading JSON only.
4. **Shadow writes**
   - After JSON writes succeed, also write equivalent SQLite rows.
   - Treat SQLite failures as warnings while JSON remains authoritative.
5. **Read comparison**
   - Add optional parity checks comparing dashboard data loaded from JSON and SQLite.
   - Log diffs but serve JSON.
6. **Feature-flagged SQLite reads**
   - Read dashboard data from SQLite only behind an explicit env flag.
   - Keep JSON export after every successful SQLite write.
7. **SQLite primary**
   - Promote SQLite only after parity checks, export checks, and concurrent write tests are stable.
   - Keep JSON export as a supported backup path.

## Risks

- Nested tracker fields may contain undocumented keys; `raw_json` is required to avoid data loss.
- Divergence can occur during shadow writes if JSON succeeds and SQLite fails.
- SQLite locking behavior must be tested with dashboard writes, scanner writes, Gmail sync, and resume generation running close together.
- JSON export can accidentally reorder or normalize fields; validation should compare semantics, not exact formatting.
- Gmail matching ambiguity must not be collapsed into a false job match.
- Generated DOCX metadata must not regress to requiring PDF fields.
- Scanner dedupe behavior depends on exact URL normalization; migration must preserve existing URL strings.

## Non-Goals For Initial Migration

- No dashboard redesign.
- No ORM requirement.
- No multi-user/cloud database behavior.
- No removal of JSON backup/export support.
- No changes to resume generation, Gmail sync, scanner, or evaluator behavior during the planning phase.
