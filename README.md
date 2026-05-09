# Career Ops

Local dashboard and automation tools for tracking job opportunities, resume generation, Gmail application signals, recruiter contacts, and follow-up workflow.

## Setup

Install dependencies:

```bash
npm install
```

Create local config from samples:

```bash
cp config/profile.example.yml config/profile.yml
cp portals.example.yml portals.yml
cp .env.example .env
```

Edit `.env`, `config/profile.yml`, and `portals.yml` for your local machine. These files can include personal data and credentials, so they are intentionally ignored.

## Required Local Files

The app expects these local files for full functionality:

- `config/profile.yml`: candidate profile and scoring preferences.
- `portals.yml`: scanner searches and filters.
- `data/master-brag-document.md`: career evidence source used for resume and outreach generation.
- `data/tracker.json`: job tracker storage.
- Optional resume/profile assets in `data/`, such as a DOCX resume template or LinkedIn export.

For Gmail sync, run OAuth setup once:

```bash
node oauth-setup.mjs
```

Then add the generated Gmail values to `.env`.

## Run The Dashboard

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Useful health check:

```bash
npm run health
```

## Scans And Gmail Sync

Portal scan:

```bash
npm run scan
```

LinkedIn scan:

```bash
npm run scan:linkedin
```

Evaluate current pipeline:

```bash
npm run evaluate
```

Run the default pipeline:

```bash
npm run pipeline
```

Gmail sync:

```bash
npm run gmail-sync
```

## Tests

```bash
npm test
```

Broad syntax check:

```bash
find . -maxdepth 1 -name '*.mjs' -print0 | xargs -0 -n1 node --check
find lib test scripts public/js -type f \( -name '*.mjs' -o -name '*.js' \) -print0 | xargs -0 -n1 node --check
```

## Ignored Files

These are intentionally local-only:

- `.env`
- `config/profile.yml`
- `config/*.local.yml`
- `portals.yml`
- `data/`
- `output/`
- `reports/`
- `logs/`
- root `*-log.txt`
- local planning notes such as `CLAUDE*.md`, `Project_Summary.md`, and `SCRIPTS.md`

Sample files that are safe to commit:

- `.env.example`
- `config/profile.example.yml`
- `portals.example.yml`
