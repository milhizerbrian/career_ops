import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  matchesContactTitle,
  buildSearchUrl,
  getActiveCompanies,
  contactCountForCompany,
} from '../scripts/scrape-linkedin-contacts.mjs';

describe('matchesContactTitle', () => {
  it('matches VP of Customer Success', () => {
    assert.equal(matchesContactTitle('VP of Customer Success'), true);
  });
  it('matches Director, Customer Success', () => {
    assert.equal(matchesContactTitle('Director, Customer Success'), true);
  });
  it('matches Head of Customer Success', () => {
    assert.equal(matchesContactTitle('Head of Customer Success'), true);
  });
  it('matches Chief Customer Officer', () => {
    assert.equal(matchesContactTitle('Chief Customer Officer'), true);
  });
  it('matches Customer Success Manager', () => {
    assert.equal(matchesContactTitle('Customer Success Manager'), true);
  });
  it('matches Senior Customer Success Manager', () => {
    assert.equal(matchesContactTitle('Senior Customer Success Manager'), true);
  });
  it('rejects unrelated title', () => {
    assert.equal(matchesContactTitle('Software Engineer'), false);
  });
  it('rejects empty string', () => {
    assert.equal(matchesContactTitle(''), false);
  });
  it('is case-insensitive', () => {
    assert.equal(matchesContactTitle('VP OF CUSTOMER SUCCESS'), true);
  });
});

describe('buildSearchUrl', () => {
  it('builds a LinkedIn people search URL', () => {
    const url = buildSearchUrl('Axonius');
    assert.ok(url.startsWith('https://www.linkedin.com/search/results/people/'));
    assert.ok(url.includes('customer') && url.includes('success'));
    assert.ok(url.includes('Axonius') || url.includes(encodeURIComponent('Axonius')));
  });
  it('encodes company names with spaces', () => {
    const url = buildSearchUrl('Quest Software');
    assert.match(url, /Quest/);
    assert.match(url, /Software/);
  });
});

describe('getActiveCompanies', () => {
  const tracker = {
    'job-1': { id: 'job-1', company: 'Axonius',    status: 'applied',                contacts: [] },
    'job-2': { id: 'job-2', company: 'Bonterra',   status: 'recruiter_screen',       contacts: [] },
    'job-3': { id: 'job-3', company: 'Axonius',    status: 'hiring_manager_screen',  contacts: [] },
    'job-4': { id: 'job-4', company: 'OldCo',      status: 'rejected',               contacts: [] },
    'job-5': { id: 'job-5', company: 'ArchivedCo', status: 'archived',               contacts: [] },
  };

  it('returns only active-pipeline companies', () => {
    const names = getActiveCompanies(tracker).map(c => c.company);
    assert.ok(names.includes('Axonius'));
    assert.ok(names.includes('Bonterra'));
    assert.ok(!names.includes('OldCo'));
    assert.ok(!names.includes('ArchivedCo'));
  });

  it('deduplicates companies with multiple jobs', () => {
    const entries = getActiveCompanies(tracker).filter(c => c.company === 'Axonius');
    assert.equal(entries.length, 1);
  });

  it('collects all jobIds for the same company', () => {
    const axonius = getActiveCompanies(tracker).find(c => c.company === 'Axonius');
    assert.deepEqual(axonius.jobIds.sort(), ['job-1', 'job-3'].sort());
  });
});

describe('contactCountForCompany', () => {
  const tracker = {
    'job-1': {
      id: 'job-1', company: 'Axonius', status: 'applied',
      contacts: [
        { id: 'c1', name: 'Alice', title: 'VP CS',       company: 'Axonius', relationshipType: 'employee', responseStatus: 'not_contacted' },
        { id: 'c2', name: 'Bob',   title: 'Director CS', company: 'Axonius', relationshipType: 'employee', responseStatus: 'not_contacted' },
      ],
    },
    'job-2': {
      id: 'job-2', company: 'Axonius', status: 'recruiter_screen',
      contacts: [
        { id: 'c3', name: 'Carol', title: 'Head of CS', company: 'Axonius', relationshipType: 'employee', responseStatus: 'not_contacted' },
      ],
    },
    'job-3': { id: 'job-3', company: 'Bonterra', status: 'applied', contacts: [] },
  };

  it('sums contacts across all jobs for a company', () => {
    assert.equal(contactCountForCompany(tracker, 'Axonius'), 3);
  });

  it('returns 0 for a company with no contacts', () => {
    assert.equal(contactCountForCompany(tracker, 'Bonterra'), 0);
  });
});
