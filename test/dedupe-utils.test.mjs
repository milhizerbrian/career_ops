import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCompanyName,
  normalizeJobTitle,
  normalizeLocation,
  normalizeText,
  buildJobFingerprint,
  calculateJobSimilarity,
  isLikelyDuplicate,
  findDuplicateJob,
} from '../lib/dedupe-utils.mjs';

// ── normalizeCompanyName ───────────────────────────────────────────────────────

describe('normalizeCompanyName', () => {
  it('strips trailing Inc.', () => {
    assert.equal(normalizeCompanyName('Wiz, Inc.'), 'wiz');
  });

  it('strips trailing LLC', () => {
    assert.equal(normalizeCompanyName('Acme LLC'), 'acme');
  });

  it('strips trailing Ltd.', () => {
    assert.equal(normalizeCompanyName('Palo Alto Networks, Ltd.'), 'palo alto networks');
  });

  it('strips trailing Corp', () => {
    assert.equal(normalizeCompanyName('BigCo Corp'), 'bigco');
  });

  it('preserves multi-word names without suffix', () => {
    assert.equal(normalizeCompanyName('Palo Alto Networks'), 'palo alto networks');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(normalizeCompanyName(null), '');
    assert.equal(normalizeCompanyName(undefined), '');
    assert.equal(normalizeCompanyName(''), '');
  });
});

// ── normalizeJobTitle ─────────────────────────────────────────────────────────

describe('normalizeJobTitle', () => {
  it('expands Sr. to senior', () => {
    assert.equal(normalizeJobTitle('Sr. CSM'), 'senior csm');
  });

  it('expands Mgr to manager', () => {
    assert.equal(normalizeJobTitle('Customer Success Mgr'), 'customer success manager');
  });

  it('expands Sr. and Mgr together', () => {
    assert.equal(
      normalizeJobTitle('Sr. Customer Success Mgr - Strategic'),
      'senior customer success manager   strategic'
        .replace(/\s+/g, ' ').trim()
    );
  });

  it('expands VP to vice president', () => {
    assert.equal(normalizeJobTitle('VP of Sales'), 'vice president of sales');
  });

  it('lowercases and removes extra punctuation', () => {
    assert.equal(normalizeJobTitle('Senior Customer Success Manager'), 'senior customer success manager');
  });

  it('returns empty string for falsy input', () => {
    assert.equal(normalizeJobTitle(null), '');
    assert.equal(normalizeJobTitle(undefined), '');
  });
});

// ── normalizeLocation ─────────────────────────────────────────────────────────

describe('normalizeLocation', () => {
  it('lowercases and strips punctuation', () => {
    assert.equal(normalizeLocation('Dallas, TX'), 'dallas tx');
  });

  it('handles remote notation', () => {
    const result = normalizeLocation('United States (Remote)');
    assert.ok(result.includes('remote'));
  });

  it('returns empty string for falsy input', () => {
    assert.equal(normalizeLocation(null), '');
    assert.equal(normalizeLocation(undefined), '');
  });
});

// ── normalizeText ─────────────────────────────────────────────────────────────

describe('normalizeText', () => {
  it('returns a Set', () => {
    const result = normalizeText('hello world');
    assert.ok(result instanceof Set);
  });

  it('filters out short words (< 5 chars)', () => {
    const result = normalizeText('the quick brown fox jumps');
    assert.ok(!result.has('the'));
    assert.ok(!result.has('fox'));
    assert.ok(result.has('quick'));
    assert.ok(result.has('brown'));
    assert.ok(result.has('jumps'));
  });

  it('filters out stop words', () => {
    const result = normalizeText('position company ability through');
    // 'position' and 'company' are in DESC_STOP; 'ability' and 'through' are not
    assert.ok(!result.has('position'));
    assert.ok(!result.has('company'));
  });

  it('returns empty Set for falsy input', () => {
    assert.equal(normalizeText(null).size, 0);
    assert.equal(normalizeText('').size, 0);
  });
});

// ── isLikelyDuplicate ─────────────────────────────────────────────────────────

describe('isLikelyDuplicate', () => {
  it('marks score >= 85 as duplicate', () => {
    assert.deepEqual(isLikelyDuplicate(85), { isDuplicate: true, isPossibleDuplicate: false });
    assert.deepEqual(isLikelyDuplicate(100), { isDuplicate: true, isPossibleDuplicate: false });
  });

  it('marks 70-84 as possible duplicate only', () => {
    assert.deepEqual(isLikelyDuplicate(70), { isDuplicate: false, isPossibleDuplicate: true });
    assert.deepEqual(isLikelyDuplicate(84), { isDuplicate: false, isPossibleDuplicate: true });
  });

  it('marks < 70 as neither', () => {
    assert.deepEqual(isLikelyDuplicate(69), { isDuplicate: false, isPossibleDuplicate: false });
    assert.deepEqual(isLikelyDuplicate(0),  { isDuplicate: false, isPossibleDuplicate: false });
  });
});

// ── calculateJobSimilarity ────────────────────────────────────────────────────

describe('calculateJobSimilarity — same URL implies high score', () => {
  it('identical jobs with matching URL score >= 85 (duplicate threshold)', () => {
    const job = {
      company: 'Wiz',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
      url: 'https://boards.greenhouse.io/wiz/jobs/4671778006',
    };
    const score = calculateJobSimilarity(job, { ...job });
    // company(35) + title(30) + location(10) + urlId(10) = 85 (no description to add more)
    assert.ok(score >= 85, `Expected score >= 85, got ${score}`);
    assert.equal(isLikelyDuplicate(score).isDuplicate, true);
  });

  it('identical jobs with description score 100', () => {
    const sharedDesc = 'Manage enterprise cybersecurity customer relationships across fortune enterprise accounts driving adoption expansion growth platform utilization'.repeat(3);
    const job = {
      company: 'Wiz',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
      url: 'https://boards.greenhouse.io/wiz/jobs/4671778006',
      full_description: sharedDesc,
    };
    const score = calculateJobSimilarity(job, { ...job });
    assert.equal(score, 100);
  });
});

describe('calculateJobSimilarity — same company + similar title → duplicate-range', () => {
  it('Greenhouse + LinkedIn cross-platform same role (no desc) scores in possible-dup range 70–84', () => {
    // Without matching description, cross-platform gets company(35)+title(30)+location(10)=75
    // which lands in the possible-dup range (70-84) — flagged but not auto-skipped
    const ghJob = {
      company: 'Palo Alto Networks',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
      url: 'https://boards.greenhouse.io/paloaltonetworks/jobs/4671778006',
    };
    const liJob = {
      company: 'Palo Alto Networks',
      title: 'Sr. Customer Success Mgr',
      location: 'Remote',
      url: 'https://www.linkedin.com/jobs/view/4671778001',
    };
    const score = calculateJobSimilarity(ghJob, liJob);
    assert.ok(score >= 70, `Expected score >= 70, got ${score}`);
    assert.equal(isLikelyDuplicate(score).isPossibleDuplicate || isLikelyDuplicate(score).isDuplicate, true);
  });

  it('Greenhouse + LinkedIn cross-platform same role with matching description scores >= 85', () => {
    const sharedDesc = 'Manage enterprise cybersecurity customer relationships driving adoption expansion growth platform utilization executive stakeholders strategic accounts'.repeat(2);
    const ghJob = {
      company: 'Palo Alto Networks',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
      url: 'https://boards.greenhouse.io/paloaltonetworks/jobs/4671778006',
      full_description: sharedDesc,
    };
    const liJob = {
      company: 'Palo Alto Networks',
      title: 'Sr. Customer Success Mgr',
      location: 'Remote',
      url: 'https://www.linkedin.com/jobs/view/4671778001',
      full_description: sharedDesc,
    };
    const score = calculateJobSimilarity(ghJob, liJob);
    assert.ok(score >= 85, `Expected score >= 85, got ${score}`);
    assert.equal(isLikelyDuplicate(score).isDuplicate, true);
  });
});

describe('calculateJobSimilarity — same company + different title → not duplicate', () => {
  it('same company but completely different role scores < 70', () => {
    const jobA = {
      company: 'Wiz',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
    };
    const jobB = {
      company: 'Wiz',
      title: 'Principal Software Engineer',
      location: 'Remote',
    };
    const score = calculateJobSimilarity(jobA, jobB);
    assert.ok(score < 70, `Expected score < 70, got ${score}`);
  });
});

describe('calculateJobSimilarity — same title + different company → not duplicate', () => {
  it('same title across different companies scores < 70', () => {
    const jobA = {
      company: 'Wiz',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
    };
    const jobB = {
      company: 'CrowdStrike',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
    };
    const score = calculateJobSimilarity(jobA, jobB);
    assert.ok(score < 70, `Expected score < 70, got ${score}`);
  });
});

// ── findDuplicateJob ───────────────────────────────────────────────────────────

describe('findDuplicateJob', () => {
  it('returns NONE for empty corpus', () => {
    const result = findDuplicateJob({ company: 'Wiz', title: 'CSM' }, []);
    assert.equal(result.isDuplicate, false);
    assert.equal(result.isPossibleDuplicate, false);
    assert.equal(result.score, 0);
    assert.equal(result.matchedJob, null);
  });

  it('returns NONE for null inputs', () => {
    assert.equal(findDuplicateJob(null, []).isDuplicate, false);
  });

  it('finds exact duplicate by URL (same URL → isDuplicate: true)', () => {
    const job = {
      company: 'Wiz',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
      url: 'https://boards.greenhouse.io/wiz/jobs/4671778006',
    };
    const result = findDuplicateJob(job, [{ ...job }]);
    assert.equal(result.isDuplicate, true);
    assert.ok(result.score >= 85);
    assert.ok(result.matchedJob !== null);
  });

  it('returns highest-scoring match when multiple exist', () => {
    const newJob = {
      company: 'Palo Alto Networks',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
    };
    const strongMatch = {
      company: 'Palo Alto Networks',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
    };
    const weakMatch = {
      company: 'CrowdStrike',
      title: 'Account Executive',
      location: 'Dallas TX',
    };
    const result = findDuplicateJob(newJob, [weakMatch, strongMatch]);
    assert.ok(result.isDuplicate || result.isPossibleDuplicate);
    assert.deepEqual(result.matchedJob, strongMatch);
  });

  it('short-circuits at score 100 (only possible with description data)', () => {
    const sharedDesc = 'Manage enterprise cybersecurity customer relationships driving adoption expansion growth platform utilization executive stakeholders strategic accounts'.repeat(2);
    const job = {
      company: 'Wiz',
      title: 'Senior Customer Success Manager',
      location: 'Remote',
      url: 'https://boards.greenhouse.io/wiz/jobs/4671778006',
      full_description: sharedDesc,
    };
    // Second item should never be scored once 100 is reached
    const corpus = [{ ...job }, { company: 'Other', title: 'Other' }];
    const result = findDuplicateJob(job, corpus);
    assert.equal(result.score, 100);
  });
});
