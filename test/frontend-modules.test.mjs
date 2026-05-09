import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.resolve(APP_ROOT, file), 'utf8');

describe('frontend ES modules', () => {
  it('loads dashboard as the browser module entrypoint', () => {
    const html = read('public/index.html');
    assert.match(html, /<script type="module" src="\/js\/dashboard\.js"><\/script>/);
    assert.doesNotMatch(html, /<script>\s*\/\/ ─── State/);
  });

  it('keeps expected frontend modules present and imported', () => {
    for (const file of [
      'public/js/api.js',
      'public/js/state.js',
      'public/js/dashboard.js',
      'public/js/jobs-table.js',
      'public/js/progress.js',
      'public/js/source-badges.js',
    ]) {
      assert.ok(fs.existsSync(path.resolve(APP_ROOT, file)), `${file} exists`);
    }

    const dashboard = read('public/js/dashboard.js');
    for (const moduleName of ['api.js', 'state.js', 'jobs-table.js', 'progress.js', 'source-badges.js']) {
      assert.match(dashboard, new RegExp(`from '\\./${moduleName}'`));
    }
  });

  it('exposes sort handler for existing table header onclick attributes', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    assert.match(html, /onclick="setOppSort\('company'\)"/);
    assert.match(dashboard, /window\.setOppSort = setOppSort/);
  });

  it('wires a minimal ambiguous Gmail review panel', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');

    assert.match(html, /id="gmail-ambiguity-panel"/);
    assert.match(dashboard, /fetchAmbiguousGmailJobs/);
    assert.match(dashboard, /renderGmailAmbiguities/);
    assert.match(dashboard, /attachGmailAmbiguity/);
    assert.match(dashboard, /dismissGmailAmbiguity/);
    assert.match(api, /\/api\/gmail-jobs\/'\s*\+\s*encodeURIComponent\(threadId\)\s*\+\s*'\/attach/);
  });

  it('renders lightweight generated resume version history', () => {
    const dashboard = read('public/js/dashboard.js');
    assert.match(dashboard, /generatedResumeVersions/);
    assert.match(dashboard, /Resume Versions/);
    assert.match(dashboard, /resumeVersionScoreLabel/);
  });

  it('wires a lightweight brag doc quality coach panel', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');

    assert.match(html, /id="brag-quality-panel"/);
    assert.match(dashboard, /fetchBragQuality/);
    assert.match(dashboard, /renderBragQuality/);
    assert.match(api, /\/api\/brag-quality/);
  });

  it('renders compact job command center workflow indicators', () => {
    const html = read('public/index.html');
    const dashboard = read('public/js/dashboard.js');

    assert.match(html, /id="workflow-summary-grid"/);
    assert.match(dashboard, /renderWorkflowSummary/);
    assert.match(dashboard, /buildHealthSummaryCounts/);
    assert.match(dashboard, /GMAIL REVIEW/);
    assert.match(dashboard, /NEEDS RESUME/);
    assert.match(dashboard, /READY TO APPLY/);
    assert.match(dashboard, /INTERVIEW PREP/);
    assert.match(dashboard, /applyHealthSummaryFilter/);
    assert.match(dashboard, /Next Best Action/);
    assert.match(dashboard, /Workflow Timeline/);
  });

  it('wires manual job workflow action controls', () => {
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    assert.match(dashboard, /workflow-action-btn/);
    assert.match(dashboard, /submitWorkflowAction/);
    assert.match(api, /postWorkflowEvent/);
    assert.match(server, /\/api\/jobs\/:id\/workflow-event/);
  });

  it('wires a lightweight recruiter contact workspace', () => {
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    assert.match(dashboard, /contact-workspace/);
    assert.match(dashboard, /bindContactWorkspace/);
    assert.match(dashboard, /contact-outreach-btn/);
    assert.match(api, /upsertJobContact/);
    assert.match(server, /\/api\/jobs\/:id\/contacts/);
  });

  it('wires contact outreach draft generation', () => {
    const dashboard = read('public/js/dashboard.js');
    const api = read('public/js/api.js');
    const server = read('server.mjs');

    assert.match(dashboard, /contact-draft-btn/);
    assert.match(dashboard, /generateContactDraft/);
    assert.match(dashboard, /outreachDrafts/);
    assert.match(api, /generateContactOutreachDraft/);
    assert.match(server, /\/api\/jobs\/:id\/contacts\/outreach-draft/);
  });
});
