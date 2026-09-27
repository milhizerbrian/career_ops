import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  mergeFacts,
  parseIdentity,
  parseRoles,
  parseCertifications,
  corpusContainsToken,
  extractCountPhrases,
  wordsToDigits,
  findUnverifiedProfileYmlClaims,
} from '../scripts/migrate-candidate-data.mjs';

describe('mergeFacts (dedupe + id assignment)', () => {
  it('assigns sequential ids on first migration', () => {
    const { records, added, skipped } = mergeFacts([], [
      { fact: 'Managed $23M ARR portfolio', category: 'metric', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
      { fact: 'Led onboarding for enterprise customers', category: 'achievement', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
    ], 'achievement');
    assert.equal(added.length, 2);
    assert.equal(skipped.length, 0);
    assert.deepEqual(records.map(r => r.id), ['achievement-001', 'achievement-002']);
  });

  it('skips an exact-text duplicate within the same category+employer on re-run', () => {
    const first = mergeFacts([], [
      { fact: 'Managed $23M ARR portfolio', category: 'metric', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
    ], 'achievement');
    const second = mergeFacts(first.records, [
      { fact: 'Managed $23M ARR portfolio', category: 'metric', employer: 'ExtraHop', source: 'master-brag-document.md', verified: true, allowed_in_resume: true },
    ], 'achievement');
    assert.equal(second.added.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.records.length, 1);
  });

  it('is case/whitespace-insensitive when detecting duplicates', () => {
    const first = mergeFacts([], [
      { fact: 'Managed  $23M ARR portfolio', category: 'metric', employer: 'ExtraHop', source: 'x', verified: true, allowed_in_resume: true },
    ], 'achievement');
    const second = mergeFacts(first.records, [
      { fact: 'managed $23m arr portfolio', category: 'metric', employer: 'ExtraHop', source: 'x', verified: true, allowed_in_resume: true },
    ], 'achievement');
    assert.equal(second.added.length, 0);
    assert.equal(second.skipped.length, 1);
  });

  it('treats the same fact text under a different employer as distinct', () => {
    const first = mergeFacts([], [
      { fact: 'Delivered demos and POCs', category: 'achievement', employer: 'ExtraHop', source: 'x', verified: true, allowed_in_resume: true },
    ], 'achievement');
    const second = mergeFacts(first.records, [
      { fact: 'Delivered demos and POCs', category: 'achievement', employer: 'Securonix', source: 'x', verified: true, allowed_in_resume: true },
    ], 'achievement');
    assert.equal(second.added.length, 1);
    assert.equal(second.records.length, 2);
  });

  it('continues id numbering from the highest existing id rather than restarting at 1', () => {
    const existing = [{ id: 'achievement-007', fact: 'Existing fact', category: 'achievement', employer: null, source: 'x', verified: true, allowed_in_resume: true }];
    const { records } = mergeFacts(existing, [
      { fact: 'A brand new fact', category: 'achievement', employer: null, source: 'x', verified: true, allowed_in_resume: true },
    ], 'achievement');
    assert.equal(records[1].id, 'achievement-008');
  });
});

describe('master-brag-document.md parsing (against a fixture, not the real file)', () => {
  const FIXTURE = `# Master Career Database — Test Person

## Identity

- **Name:** Test Person
- **Email:** test@example.com
- **Phone:** (555) 555-5555
- **Location:** Testville, TX
- **LinkedIn:** linkedin.com/in/testperson
- **Portfolio:** example.com
- **Headline:** Test Headline
- **Top Skills:** Skill A, Skill B

---

## Target Roles

## Experience Details (Chronological, Most Recent First)

## Exact Role Titles — No Inflation

- TestCo: Test Title

---

### TestCo — Test Title
**Jan 2020 – Present (Test tenure) | Remote**
**Domain:** Testing

**Key Metrics:**
- Portfolio: $10M ARR
- Retention: 90%

**Keywords:** testing, quality

**Bullets:**
- Managed a $10M ARR portfolio across enterprise test accounts
- Maintained 90% retention across the test portfolio

---

## Certifications

- Test Certification A
- Test Certification B

## Resume Writing Rules
`;

  it('parses identity fields', () => {
    const identity = parseIdentity(FIXTURE);
    assert.equal(identity.name, 'Test Person');
    assert.equal(identity.email, 'test@example.com');
    assert.equal(identity.topSkills, 'Skill A, Skill B');
  });

  it('parses one role per ### heading with metrics and bullets', () => {
    const roles = parseRoles(FIXTURE);
    assert.equal(roles.length, 1);
    assert.equal(roles[0].employer, 'TestCo');
    assert.equal(roles[0].title, 'Test Title');
    assert.deepEqual(roles[0].metrics, ['Portfolio: $10M ARR', 'Retention: 90%']);
    assert.deepEqual(roles[0].bullets, [
      'Managed a $10M ARR portfolio across enterprise test accounts',
      'Maintained 90% retention across the test portfolio',
    ]);
  });

  it('parses certifications as a flat list', () => {
    assert.deepEqual(parseCertifications(FIXTURE), ['Test Certification A', 'Test Certification B']);
  });
});

describe('corpusContainsToken (word/digit boundary safety)', () => {
  it('does not let "8 accounts" match inside "18 accounts"', () => {
    assert.equal(corpusContainsToken('across 18 accounts total', '8 account'), false);
  });

  it('does match a genuine whole-number occurrence', () => {
    assert.equal(corpusContainsToken('across 8 accounts total', '8 account'), true);
  });

  it('does not let "$5M" match inside "$65M"', () => {
    assert.equal(corpusContainsToken('grew arr to $65m', '$5M'), false);
  });
});

describe('extractCountPhrases + wordsToDigits', () => {
  it('converts spelled-out counts to digits before matching', () => {
    assert.equal(wordsToDigits('eight accounts'), '8 accounts');
    assert.deepEqual(extractCountPhrases('managed eight accounts this year'), ['8 account']);
  });
});

describe('findUnverifiedProfileYmlClaims (scoped to narrative/background only)', () => {
  it('returns [] when no profile.yml exists at the given path', () => {
    const brag = 'Portfolio: $23M ARR across enterprise accounts.';
    assert.deepEqual(findUnverifiedProfileYmlClaims(brag, '/definitely/missing/profile.yml'), []);
  });

  it('flags a narrative dollar figure absent from the brag doc, but ignores compensation/scoring sections', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-yml-'));
    const ymlPath = path.join(dir, 'profile.yml');
    fs.writeFileSync(ymlPath, [
      'narrative:',
      '  superpowers:',
      '    - "Saved $1.35M at-risk renewal"',
      'compensation:',
      '  minimum: "$165K"',
    ].join('\n'), 'utf8');
    const brag = 'Portfolio: $23M ARR across enterprise accounts.';
    try {
      const claims = findUnverifiedProfileYmlClaims(brag, ymlPath);
      assert.equal(claims.length, 1);
      assert.equal(claims[0].token, '$1.35M');
      assert.ok(claims[0].sourcePath.startsWith('narrative.'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
