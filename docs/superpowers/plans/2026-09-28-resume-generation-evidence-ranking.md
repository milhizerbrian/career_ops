# Resume Generation Evidence-Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make JD-requirement importance, verified-evidence strength, and per-employer bullet coverage systemically drive resume content selection — fixing the Arms Cyber defects (buried onboarding/startup proof, repeated summary sentence, un-surfaced CRM gap) as a byproduct of general rules, not one-off patches.

**Architecture:** `lib/resume-gen.mjs` already has a mature, working pipeline (JD requirement extraction → evidence map → section plan → LM Studio synthesis → dynamic bullet selection → critique/repair → page-fit trimming → evidence enforcement). This plan makes six surgical, additive changes to that existing pipeline — it does not replace any subsystem. It reuses two modules that already exist but aren't wired into resume generation: `lib/jd-parser.mjs` (required/preferred section splitting) and `lib/candidate-fit-analysis.mjs` (verified-vault-backed 4-tier requirement classification, already built for job-fit scoring). No new files, no new dependencies, no Arms-Cyber-specific strings.

**Tech Stack:** Node.js ES modules, `node:test` + `node:assert/strict`, existing LM Studio/Claude synthesis pipeline (unchanged).

**Spec:** User's pasted requirements (10-point systemic resume-generation improvement spec, career-ops session 2026-09-28). Conversation-only — no separate spec file; this plan's Global Constraints section restates the binding rules.

## Global Constraints

- Never invent employers, dates, metrics, certifications, tools, or experience not in `career-evidence/candidate/*.json`. Evidence enforcement (`lib/resume-evidence.mjs`, `lib/evidence-validator.mjs`) stays BLOCK by default — do not weaken it.
- No Arms-Cyber-specific or any other single-JD-specific strings, keywords, or branches. Every change must generalize across JDs.
- LM Studio 7B only for resume AI work; no new Anthropic/OpenAI calls added by this plan.
- Preserve existing exported function signatures used by `test/resume-gen.test.mjs` (1700 lines) and `server.mjs` — additive fields/params only, never remove or repurpose an existing field.
- `npm test` must pass after every task before moving to the next.
- Do not touch Gmail, cron, scanners, opportunity lifecycle, or files outside `lib/resume-gen.mjs`, `test/resume-gen.test.mjs`, and (read-only) `lib/jd-parser.mjs` / `lib/candidate-fit-analysis.mjs` / `lib/candidate-data.mjs`.

## Review Focus

- **Circular ES module imports** (`resume-gen.mjs` → `jd-parser.mjs` → `resume-gen.mjs`, and `resume-gen.mjs` → `candidate-fit-analysis.mjs` → `jd-parser.mjs`/`resume-gen.mjs`): every new cross-import must only be used inside function bodies, never at module top-level, or Node's ESM loader will throw on a `ReferenceError`/TDZ access. Task 1 and Task 3 each end with a full-suite run specifically to catch this.
- **`extractJobRequirements` re-ranking changes which 12 requirements survive the `.slice(0, 12)` cutoff** for some real JDs even when it preserves the existing unit tests (which mostly use single-section JD text where relative order is untouched). Task 1's test suite includes one JD with explicit "Requirements:" and "Nice to have:" headers to pin the new required-outranks-preferred behavior.
- **`buildEvidenceMap`'s matching fix (Task 2) changes `status` results for any alias that was previously a substring false-positive** (e.g. short aliases like `ai`, `sme`, `grr` matching inside unrelated words). Existing tests only use full clean words, so this is expected to be safe, but Task 2 adds a regression test for the exact false-positive class the fix closes.
- **A role losing all its bullets during page-fit trimming** (the confirmed Arms Cyber defect — Total Trial Services shipped with 0 of its 3 template bullet slots filled despite 4 verified, JD-relevant, `allowed_in_resume` achievements). Task 4's test pins "no role goes from >0 bullets to 0 while any other role still has a droppable bullet."
- **Repeated sentence openings in `PROFESSIONAL_SUMMARY`** (the confirmed Arms Cyber defect — two consecutive sentences both opened "Supported enterprise customers..."). Task 5 pins detection; the fix reuses the existing LM-Studio critique-repair path rather than adding new repair code.

---

### Task 1: Weight JD requirement priority by required/preferred/responsibilities section

**Files:**
- Modify: `lib/resume-gen.mjs:854-883` (`extractJobRequirements`), imports at `lib/resume-gen.mjs:1`
- Test: `test/resume-gen.test.mjs` (new `describe('extractJobRequirements section weighting', ...)` block, placed after the existing `describe('generic resume evidence review', ...)` block around line 502)

**Interfaces:**
- Consumes: `splitIntoSections(text)` from `lib/jd-parser.mjs` (already exported, signature `(text: string) => { responsibilities, required, preferred, benefits, unlabeled }`, all strings).
- Produces: `extractJobRequirements(jdText, keywords)` keeps its existing signature and return shape (`{ requirement, source, priority }[]`, sorted desc by priority, sliced to 12) — only the `priority` computation changes, so every existing caller (`buildResumePlanningContext`, `buildResumeSectionPlan` via `evidenceStatus`, `bulletSelectionScore`, tests) is unaffected by shape.

- [ ] **Step 1: Write the failing test**

```javascript
// In test/resume-gen.test.mjs, add after the 'generic resume evidence review' describe block (~line 502):
describe('extractJobRequirements section weighting', () => {
  it('ranks a requirement named in the Requirements section above one only in Nice to Have', () => {
    const jd = [
      'Requirements:',
      'Experience with CRM tooling and keeping customer records current is required.',
      '',
      'Nice to have:',
      'Familiarity with BOM review is a plus.',
    ].join('\n');

    const requirements = extractJobRequirements(jd, '');
    const crmIndex = requirements.findIndex(item => item.requirement === 'CRM opportunity hygiene');
    const bomIndex = requirements.findIndex(item => item.requirement === 'BOM review');

    assert.ok(crmIndex >= 0, 'CRM opportunity hygiene should be detected');
    assert.ok(bomIndex >= 0, 'BOM review should be detected');
    assert.ok(requirements[crmIndex].priority > requirements[bomIndex].priority);
  });

  it('preserves existing behavior for JD text with no section headers', () => {
    // Regression pin: this exact text/assertions already existed in
    // 'generic resume evidence review' > 'surfaces generic people-leadership
    // and operating gaps from a non-security JD' — re-asserted here to lock
    // down that unsectioned JD text still produces the same top requirements.
    const requirements = extractJobRequirements(
      'Manage and develop a team. Coach team members. Drive playbooks, operational consistency, GRR, NRR, lifecycle programs, and 1-to-many automation.',
      ''
    );
    assert.ok(requirements.some(item => item.requirement === 'people management'));
    assert.ok(requirements.some(item => item.requirement === 'team coaching and development'));
    assert.ok(requirements.some(item => item.requirement === 'customer success metrics management'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A5 "section weighting"`
Expected: FAIL on the first test — `crmIndex`/`bomIndex` priorities are currently equal (both computed from flat whole-text hit counts), so `priority > priority` is false.

- [ ] **Step 3: Write minimal implementation**

Add the import (top of `lib/resume-gen.mjs`, with the other local imports):

```javascript
import { splitIntoSections } from './jd-parser.mjs';
```

Replace `extractJobRequirements` (`lib/resume-gen.mjs:854-883`):

```javascript
const JD_SECTION_WEIGHT = { required: 3, responsibilities: 2, unlabeled: 2, preferred: 1 };

export function extractJobRequirements(jdText, keywords = '') {
  const sections = splitIntoSections(jdText);
  const weightedSections = [
    ['required', sections.required],
    ['responsibilities', sections.responsibilities],
    ['unlabeled', sections.unlabeled],
    ['preferred', sections.preferred],
  ].map(([key, body]) => [JD_SECTION_WEIGHT[key], normalizeText(body)]);
  // Extracted keywords (Pass 1's local keyword analysis) aren't tied to a JD
  // section, so they contribute at a flat 1x weight, same as the old
  // flat-priority behavior for keyword-only matches — they must not dominate
  // just because they'd otherwise be counted once per weighted section.
  const keywordText = normalizeText(keywords);

  const found = [];
  for (const item of REQUIREMENT_CATALOG) {
    const aliases = item.aliases.map(normalizeText);
    const priority = weightedSections.reduce(
      (sum, [weight, text]) => sum + weight * termHits(text, aliases),
      termHits(keywordText, aliases)
    );
    if (priority > 0) found.push({ requirement: item.phrase, source: 'jd', priority });
  }

  for (const keyword of String(keywords ?? '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean)) {
    const normalized = normalizeText(keyword);
    if (normalized.length < 4) continue;
    if (GENERIC_KEYWORD_REQUIREMENTS.has(normalized)) continue;
    if (normalized.split(/\s+/).length === 1) continue;
    if (found.some(item => normalizeText(item.requirement) === normalized)) continue;
    found.push({
      requirement: keyword,
      source: 'keyword',
      priority: 1,
    });
  }

  return found
    .sort((a, b) => b.priority - a.priority || a.requirement.localeCompare(b.requirement))
    .slice(0, 12);
}
```

(`keywords` is folded into every weighted section rather than appended once, since it's not JD text tied to a specific section — this keeps a keyword hit contributing at every weight tier it would have under the old flat-text behavior for JDs with no headers, where all sections collapse to `unlabeled`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A5 "section weighting"`
Expected: PASS, both tests.

- [ ] **Step 5: Run the full resume-gen suite and the jd-parser suite to catch any circular-import or ranking regression**

Run: `node --test test/resume-gen.test.mjs test/jd-parser.test.mjs test/candidate-fit-analysis.test.mjs 2>&1 | tail -40`
Expected: PASS. If any `buildResumeSectionPlan`/`critiqueResumeDraft` test that depends on `extractJobRequirements`'s top-12 output fails because a requirement fell out of the cutoff, adjust that test's JD text to include the requirement's aliases in a way that still ranks it in the top 12 — do not change the weighting to make a failing test pass by coincidence.

- [ ] **Step 6: Commit**

```bash
git add lib/resume-gen.mjs test/resume-gen.test.mjs
git commit -m "$(cat <<'EOF'
Weight JD requirement priority by required/responsibilities/preferred section

extractJobRequirements previously ranked every requirement by raw hit count
across the whole JD blob, so a requirement mentioned only in a "nice to
have" section could outrank one stated as required. Reuses jd-parser.mjs's
existing section splitter (no new parsing logic) to weight required 3x,
responsibilities/unlabeled 2x, preferred 1x.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Fix `buildEvidenceMap`'s substring false-positive matching

**Files:**
- Modify: `lib/resume-gen.mjs:934-947` (`buildEvidenceMap`), imports at `lib/resume-gen.mjs:1`
- Test: `test/resume-gen.test.mjs` (extend the existing `describe('generic resume evidence review', ...)` block, ~line 455)

**Interfaces:**
- Consumes: `containsAnyTerm(text, terms)` from `lib/text-match-utils.mjs` (already exported, whole-token-safe matching — this is the exact fix `text-match-utils.mjs`'s own header comment says it exists for).
- Produces: `buildEvidenceMap(requirements, bragDoc)` keeps its exact signature and return shape (`{ requirement, status, evidenceTerms }[]`) — only which aliases count as a "hit" changes.

- [ ] **Step 1: Write the failing test**

```javascript
// In test/resume-gen.test.mjs, inside describe('generic resume evidence review', ...):
it('does not treat a short alias as a hit when it only appears inside an unrelated word', () => {
  const requirements = [{ requirement: 'SME positioning' }]; // aliases: ['sme', 'subject matter', 'advisor', 'advisory', 'ciso', 'executive']
  const evidenceMap = buildEvidenceMap(
    requirements,
    // "smelled" contains the substring "sme" — old code's raw brag.includes('sme')
    // false-positives on this; none of the other SME-positioning aliases appear.
    'Helped customers who felt the onboarding process smelled off get back on track quickly.'
  );
  assert.equal(evidenceMap.find(item => item.requirement === 'SME positioning').status, 'gap');
});

it('still matches a short alias when it appears as its own word', () => {
  const requirements = [{ requirement: 'SME positioning' }];
  const evidenceMap = buildEvidenceMap(
    requirements,
    'Positioned as the SME for enterprise identity architecture during executive reviews.'
  );
  assert.equal(evidenceMap.find(item => item.requirement === 'SME positioning').status, 'supported');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -B2 -A8 "unrelated word\|own word"`
Expected: The first test fails — `'smelled'.includes('sme')` is `true` under the current raw-substring `brag.includes(normalizeText(alias))` check, so `SME positioning` comes back `'partial'` (one false-positive alias hit) instead of `'gap'`. The second test already passes under the old code (a real hit is still a hit either way) — keep it as a locked-in regression pin that the fix doesn't also break genuine whole-word matches.

- [ ] **Step 3: Write minimal implementation**

Add the import (top of `lib/resume-gen.mjs`):

```javascript
import { containsAnyTerm } from './text-match-utils.mjs';
```

Replace `buildEvidenceMap` (`lib/resume-gen.mjs:934-947`):

```javascript
export function buildEvidenceMap(requirements, bragDoc) {
  const brag = String(bragDoc ?? '');
  return requirements.map(item => {
    const requirement = item.requirement;
    const aliases = EVIDENCE_ALIASES[requirement] || normalizeText(requirement).split(/\s+/).filter(word => word.length >= 5);
    const hits = aliases.filter(alias => containsAnyTerm(brag, [alias]));
    const status = hits.length >= 2 ? 'supported' : hits.length === 1 ? 'partial' : 'gap';
    return {
      requirement,
      status,
      evidenceTerms: hits.slice(0, 5),
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -B2 -A8 "unrelated word\|larger number"`
Expected: PASS, both tests.

- [ ] **Step 5: Run the full resume-gen suite**

Run: `node --test test/resume-gen.test.mjs 2>&1 | tail -40`
Expected: PASS. All 8 existing `buildEvidenceMap(...)` call sites use full clean words in their bragDoc strings (verified during planning), so no existing assertion should flip.

- [ ] **Step 6: Commit**

```bash
git add lib/resume-gen.mjs test/resume-gen.test.mjs
git commit -m "$(cat <<'EOF'
Fix buildEvidenceMap false-positive substring matching

buildEvidenceMap matched EVIDENCE_ALIASES with raw brag.includes(alias),
which false-positives on short aliases inside unrelated words (e.g. "ai"
inside "domain"). Switches to text-match-utils.mjs's containsAnyTerm,
the same whole-token-safe matcher evidence-validator.mjs already uses.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Enrich the evidence map with verified-vault tiers (additive, non-breaking)

**Files:**
- Modify: `lib/resume-gen.mjs` — add `enrichEvidenceMapWithVault` near `buildEvidenceMap` (`lib/resume-gen.mjs:934-947`), wire it into `buildResumePlanningContext` (`lib/resume-gen.mjs:1218-1225`), imports at `lib/resume-gen.mjs:1`
- Test: `test/resume-gen.test.mjs` (new `describe('verified-vault evidence enrichment', ...)` block after the `describe('generic resume evidence review', ...)` block)

**Interfaces:**
- Consumes: `classifyRequirement(requirementLabel, candidateFacts)` from `lib/candidate-fit-analysis.mjs` (already exported, returns `{ tier: 'strong_match'|'partial_match'|'unknown'|'gap', evidenceIds: string[], reason: string }`), `loadCandidateFacts()` from `lib/candidate-data.mjs` (already imported in `resume-gen.mjs`).
- Produces: `enrichEvidenceMapWithVault(evidenceMap, candidateFacts?)` returns the same array shape as `buildEvidenceMap` plus two additive fields: `verifiedTier` (`'strong_match'|'partial_match'|'unknown'|'gap'`) and `verifiedEvidenceIds` (`string[]`). `buildResumePlanningContext(jdText, keywords, bragDoc)` keeps its exact 3-arg signature; its returned `evidenceMap` now carries these two extra fields on every entry — existing code reading only `.status`/`.requirement`/`.evidenceTerms` is unaffected. This is the requirement-to-evidence matrix from spec item 2 (STRONG VERIFIED MATCH / VERIFIED MATCH / PARTIAL VERIFIED MATCH / NO VERIFIED EVIDENCE), grounded in `career-evidence/candidate/*.json` fact IDs rather than free-text search, and it feeds Task 6's coverage audit.

- [ ] **Step 1: Write the failing test**

```javascript
// In test/resume-gen.test.mjs, add after the 'generic resume evidence review' describe block:
describe('verified-vault evidence enrichment', () => {
  it('tags a requirement backed by 2+ verified facts as strong_match with traceable fact ids', () => {
    const evidenceMap = [{ requirement: 'onboarding project management', status: 'partial', evidenceTerms: [] }];
    const candidateFacts = [
      { id: 'achievement-100', category: 'achievement', verified: true, allowed_in_resume: true, fact: 'Improved onboarding consistency across 87 client relationships.' },
      { id: 'achievement-101', category: 'achievement', verified: true, allowed_in_resume: true, fact: 'Reduced onboarding time by 30% through implementation redesign.' },
    ];
    const enriched = enrichEvidenceMapWithVault(evidenceMap, candidateFacts);

    assert.equal(enriched[0].verifiedTier, 'strong_match');
    assert.deepEqual(new Set(enriched[0].verifiedEvidenceIds), new Set(['achievement-100', 'achievement-101']));
    // Additive: the original text-heuristic field is untouched.
    assert.equal(enriched[0].status, 'partial');
  });

  it('never upgrades a requirement to a stronger tier than the vault actually supports', () => {
    const evidenceMap = [{ requirement: 'AI governance', status: 'gap', evidenceTerms: [] }];
    const candidateFacts = [
      { id: 'skill-050', category: 'skill', verified: true, allowed_in_resume: true, fact: 'Enterprise SIEM and IAM platform administration.' },
    ];
    const enriched = enrichEvidenceMapWithVault(evidenceMap, candidateFacts);

    assert.equal(enriched[0].verifiedTier, 'gap');
    assert.deepEqual(enriched[0].verifiedEvidenceIds, []);
  });

  it('falls back to the unenriched evidence map when no candidate facts are available', () => {
    const evidenceMap = [{ requirement: 'onboarding project management', status: 'partial', evidenceTerms: [] }];
    const enriched = enrichEvidenceMapWithVault(evidenceMap, []);
    assert.deepEqual(enriched, evidenceMap);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A8 "verified-vault evidence enrichment"`
Expected: FAIL — `enrichEvidenceMapWithVault is not defined` / not exported.

- [ ] **Step 3: Write minimal implementation**

Add the import (top of `lib/resume-gen.mjs`):

```javascript
import { classifyRequirement } from './candidate-fit-analysis.mjs';
```

Add this function directly after `buildEvidenceMap` (`lib/resume-gen.mjs:947`):

```javascript
/**
 * Enriches a text-heuristic evidenceMap (buildEvidenceMap's output) with the
 * vault-backed 4-tier classification already built for job-fit scoring
 * (candidate-fit-analysis.mjs::classifyRequirement) — strong_match /
 * partial_match / unknown / gap, traced to specific career-evidence/candidate/*.json
 * fact ids. Additive only: never removes or downgrades the existing `status`
 * field, so every current caller of buildEvidenceMap/buildResumePlanningContext
 * keeps working unchanged. Falls back to returning evidenceMap as-is when no
 * verified facts are available (e.g. an isolated test with an empty vault).
 */
export function enrichEvidenceMapWithVault(evidenceMap, candidateFacts = loadCandidateFacts()) {
  if (!candidateFacts.length) return evidenceMap;
  return evidenceMap.map(item => {
    const { tier, evidenceIds } = classifyRequirement(item.requirement, candidateFacts);
    return { ...item, verifiedTier: tier, verifiedEvidenceIds: evidenceIds };
  });
}
```

Wire it into `buildResumePlanningContext` (`lib/resume-gen.mjs:1218-1225`):

```javascript
export function buildResumePlanningContext(jdText, keywords, bragDoc) {
  const roleMode = classifyResumeRole(jdText);
  const jdSignals = extractJdSignals(jdText, keywords);
  const requirements = extractJobRequirements(jdText, keywords);
  const evidenceMap = enrichEvidenceMapWithVault(buildEvidenceMap(requirements, bragDoc));
  const sectionPlan = buildResumeSectionPlan({ roleMode, requirements, evidenceMap });
  return { roleMode, jdSignals, requirements, evidenceMap, sectionPlan, jdText };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A8 "verified-vault evidence enrichment"`
Expected: PASS, all three tests.

- [ ] **Step 5: Run the full suite, including candidate-fit-analysis, to catch the 3-way circular import (resume-gen → candidate-fit-analysis → jd-parser → resume-gen)**

Run: `npm test 2>&1 | tail -60`
Expected: PASS. If Node throws a `ReferenceError` about an uninitialized binding during module load, it means a new import got used at module top-level instead of inside a function body — check `lib/resume-gen.mjs`, `lib/jd-parser.mjs`, `lib/candidate-fit-analysis.mjs` top-level statements (outside function bodies) for any use of `classifyRequirement`, `splitIntoSections`, `REQUIREMENT_CATALOG`, or `DOMAIN_CATALOG` and move it inside a function.

- [ ] **Step 6: Commit**

```bash
git add lib/resume-gen.mjs test/resume-gen.test.mjs
git commit -m "$(cat <<'EOF'
Enrich resume evidence map with vault-backed 4-tier classification

Resume generation's evidenceMap was built purely from free-text search
against the flattened brag doc. Job-fit scoring already has a stronger
verified-fact-vault classifier (candidate-fit-analysis.mjs::
classifyRequirement, tracing every match to a career-evidence/candidate/*.json
fact id). Wires it in as additive verifiedTier/verifiedEvidenceIds fields
on the existing evidenceMap shape so it becomes the basis for the JD
coverage audit (next task) without changing any existing consumer.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Guarantee every role with content keeps at least one bullet during page-fit trimming

**Files:**
- Modify: `lib/resume-gen.mjs:3580-3591` (`lowestPrioritySelectedBullet`)
- Test: `test/resume-gen.test.mjs` (new `describe('page-fit bullet floor', ...)` block, placed after the existing `describe('dynamic resume bullets', ...)` block ~line 453)

**Interfaces:**
- Consumes: nothing new — reuses `selectedBulletEntries`, `protectedBulletReason`, `bulletSelectionScore`, all already defined above this function in `lib/resume-gen.mjs`.
- Produces: `lowestPrioritySelectedBullet(replacements, planningContext)` keeps its exact signature and return shape (a single scored bullet entry or `undefined`) — only which bullet it picks changes when the previous pick would zero out a role.

- [ ] **Step 1: Write the failing test**

```javascript
// In test/resume-gen.test.mjs, add after the 'dynamic resume bullets' describe block:
describe('page-fit bullet floor', () => {
  it('never drops a role to zero bullets while another role still has a droppable bullet', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    const replacements = {
      // Role 1 has three bullets, each scoring higher (metric/domain proof) than
      // role 5's single, deliberately quiet bullet below.
      JOB_1_BULLET_1: 'Managed a $23M enterprise portfolio across 30 accounts with executive stakeholder alignment.',
      JOB_1_BULLET_2: 'Drove 98% retention through structured account health reviews and CISO business reviews.',
      JOB_1_BULLET_3: 'Reduced churn by identifying at-risk accounts and coordinating cross-functional recovery plans.',
      // Role 5 has exactly one bullet left, and it's the lowest-scoring bullet
      // in the whole set (no metric, no domain term) — bulletSelectionScore
      // alone would pick it first every time, which is exactly the bug: the
      // real Arms Cyber run dropped all 3 of an employer's bullets this way.
      JOB_5_BULLET_1: 'Supported day-to-day account activity without a specific metric.',
    };

    // Drop the lowest-priority bullet twice — role 1 has 3 bullets, so it
    // takes exactly 2 drops to bring it down to role 5's level (1 bullet
    // each). Until then, role 5's only bullet must never be the one picked,
    // even though it scores lower than some of role 1's remaining bullets.
    // (Once both roles are down to their last bullet, score-based
    // tie-breaking is fair game — that's not tested here.)
    let current = { ...replacements };
    for (let i = 0; i < 2; i += 1) {
      const drop = lowestPrioritySelectedBullet(current, planningContext);
      assert.ok(drop, `expected a droppable bullet on iteration ${i}`);
      assert.notEqual(drop.field, 'JOB_5_BULLET_1', `role 5's only bullet should not be dropped while role 1 still has more than one (iteration ${i})`);
      current = { ...current, [drop.field]: '' };
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A10 "page-fit bullet floor"`
Expected: FAIL on iteration `i=0` — role 5's bullet is the lowest-scoring bullet in the whole set, and the current code sorts purely by score with no per-role floor, so it gets dropped first even though it's the only bullet its role has left.

- [ ] **Step 3: Write minimal implementation**

Replace `lowestPrioritySelectedBullet` (`lib/resume-gen.mjs:3580-3591`):

```javascript
export function lowestPrioritySelectedBullet(replacements, planningContext) {
  const scored = selectedBulletEntries(replacements)
    .map(item => ({
      ...item,
      protectedReason: protectedBulletReason(item, planningContext),
      score: bulletSelectionScore(item.text, item.roleIndex, planningContext),
    }));

  const bulletCountByRole = new Map();
  for (const item of scored) {
    bulletCountByRole.set(item.roleIndex, (bulletCountByRole.get(item.roleIndex) ?? 0) + 1);
  }
  const wouldEmptyRole = item => bulletCountByRole.get(item.roleIndex) === 1;

  const unprotected = scored.filter(item => !item.protectedReason);
  const preserveRoleFloor = unprotected.filter(item => !wouldEmptyRole(item));
  const pool = preserveRoleFloor.length ? preserveRoleFloor : unprotected.length ? unprotected : scored;

  return pool
    .sort((a, b) => a.score - b.score || b.roleIndex - a.roleIndex)
    .at(0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A10 "page-fit bullet floor"`
Expected: PASS.

- [ ] **Step 5: Run the full resume-gen suite**

Run: `node --test test/resume-gen.test.mjs 2>&1 | tail -40`
Expected: PASS, including the existing `chooseDynamicPageFitAction`/`fitDynamicResumeLocally`-adjacent tests, since the "everything already protected/equal" fallback path (`scored` when both `preserveRoleFloor` and `unprotected` are empty) preserves the exact prior behavior for a single-role-remaining resume.

- [ ] **Step 6: Commit**

```bash
git add lib/resume-gen.mjs test/resume-gen.test.mjs
git commit -m "$(cat <<'EOF'
Prevent page-fit trimming from zeroing out an entire employer's bullets

lowestPrioritySelectedBullet only protected specific hardcoded phrase
matches from a small set of role modes. On the Arms Cyber JD, Total Trial
Services' role mode wasn't one of those, so all 3 of its bullet slots got
trimmed to empty during page-fit even though career-evidence/candidate/
achievements.json has 4 verified, allowed_in_resume, directly JD-relevant
achievements for that employer (onboarding consistency, escalation
handling, team scaling). Adds a general per-role floor: a bullet that
would take its role to zero is only dropped once no other droppable
bullet exists anywhere else in the resume.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Detect repeated sentence openers and near-duplicate sentences in `PROFESSIONAL_SUMMARY`

**Files:**
- Modify: `lib/resume-gen.mjs:1673-1755` (`critiqueResumeDraft`, in the section that already checks bullet-opener repetition), `lib/resume-evidence.mjs` (export the existing `jaccard` helper)
- Test: `test/resume-gen.test.mjs` (new `describe('summary sentence repetition', ...)` block after `describe('generic resume evidence review', ...)`)

**Interfaces:**
- Consumes: `jaccard(a, b)` from `lib/resume-evidence.mjs` — already defined there (content-word Jaccard similarity, used to suppress near-duplicate bullets during evidence enforcement) but not currently exported; this task adds `export` to its existing definition so `critiqueResumeDraft` can reuse the exact same similarity measure instead of writing a second one.
- Produces: `critiqueResumeDraft(replacements, planningContext)` keeps its exact signature and return shape (`{ field, code, message }[]`) — adds two new possible issue codes: `'repeated-summary-opener'` (two consecutive sentences open with the same two words — catches the observed Arms Cyber defect cheaply) and `'near-duplicate-summary-sentence'` (two sentences share ≥0.5 Jaccard content-word overlap even with different openers — catches paraphrased duplication the opener check would miss). Both flow through the existing, unmodified `repairDraftFromCritique` LM-Studio repair path (any issue code not explicitly handled by `deterministicCritiqueRepair` is sent to the LM Studio repair prompt automatically — confirmed by reading `lib/resume-gen.mjs:2280-2325`), so no new repair code is needed.

- [ ] **Step 1: Write the failing test**

```javascript
// In test/resume-gen.test.mjs, add a new describe block after 'generic resume evidence review':
describe('summary sentence repetition', () => {
  it('flags consecutive PROFESSIONAL_SUMMARY sentences that open with the same words', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    const issues = critiqueResumeDraft({
      PROFESSIONAL_SUMMARY: 'Supported enterprise customers across endpoint and network security deployments, helping resolve escalations and maintain platform stability. Supported enterprise customers adopting identity and access management platforms, helping teams integrate authentication workflows and stabilize production deployments.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'repeated-summary-opener' && issue.field === 'PROFESSIONAL_SUMMARY'));
  });

  it('does not flag a summary whose sentences open differently and cover different ground', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    const issues = critiqueResumeDraft({
      PROFESSIONAL_SUMMARY: 'Led enterprise customer success across a $23M ARR portfolio. Reduced onboarding time by 30% through implementation redesign.',
    }, planningContext);

    assert.ok(!issues.some(issue => issue.code === 'repeated-summary-opener'));
    assert.ok(!issues.some(issue => issue.code === 'near-duplicate-summary-sentence'));
  });

  it('flags near-duplicate summary sentences even when their openers differ', () => {
    const planningContext = { roleMode: 'customer-success', requirements: [] };
    const issues = critiqueResumeDraft({
      // Different opening word ("Reduced" vs "Cut"), same content words otherwise
      // — the opener check alone would miss this; jaccard overlap catches it.
      PROFESSIONAL_SUMMARY: 'Reduced onboarding time across enterprise SIEM customers through process redesign and stakeholder alignment. Cut onboarding time across enterprise SIEM customers through process redesign and stakeholder alignment.',
    }, planningContext);

    assert.ok(issues.some(issue => issue.code === 'near-duplicate-summary-sentence' && issue.field === 'PROFESSIONAL_SUMMARY'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A8 "summary sentence repetition"`
Expected: FAIL on the first and third tests — neither `repeated-summary-opener` nor `near-duplicate-summary-sentence` codes exist yet.

- [ ] **Step 3: Write minimal implementation**

In `lib/resume-evidence.mjs`, change the existing private `jaccard` helper to be exported (keep its body exactly as-is):

```javascript
export function jaccard(a, b) {
```

Import it in `lib/resume-gen.mjs` (top of file, with the other local imports):

```javascript
import { jaccard } from './resume-evidence.mjs';
```

Add this block inside `critiqueResumeDraft`, right after the existing bullet-opener-repetition check (`lib/resume-gen.mjs`, immediately following the `gerund-streak` loop that ends around line 1756, i.e. right after the closing `}` of `for (let i = 2; i < starts.length; i += 1) { ... }`):

```javascript
  const summarySentences = String(replacements?.PROFESSIONAL_SUMMARY ?? '')
    .match(/[^.!?]+[.!?]*/g)
    ?.map(s => s.trim())
    .filter(Boolean) ?? [];
  for (let i = 1; i < summarySentences.length; i += 1) {
    const firstWords = s => s.split(/\s+/).slice(0, 2).join(' ').toLowerCase().replace(/[^a-z ]/g, '');
    if (firstWords(summarySentences[i]) && firstWords(summarySentences[i]) === firstWords(summarySentences[i - 1])) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'repeated-summary-opener',
        message: 'Consecutive summary sentences open with the same words.',
      });
    }
  }
  for (let i = 0; i < summarySentences.length; i += 1) {
    for (let j = i + 1; j < summarySentences.length; j += 1) {
      if (jaccard(summarySentences[i], summarySentences[j]) >= 0.5) {
        issues.push({
          field: 'PROFESSIONAL_SUMMARY',
          code: 'near-duplicate-summary-sentence',
          message: 'Two summary sentences cover nearly the same ground.',
        });
      }
    }
  }
```

(The opener check compares only the first two words, since generic openers like "Led enterprise..." vs "Led onboarding..." are fine on their own — the near-duplicate check is the broader net, catching paraphrased repetition of the same content regardless of opener. 0.5 is looser than `resume-evidence.mjs`'s own `NEAR_DUPLICATE = 0.7` bullet threshold on purpose: summary sentences are shorter and more paraphrase-prone than bullets, so a lower bar catches real duplication without the stricter bullet threshold's risk of false positives here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A8 "summary sentence repetition"`
Expected: PASS, all three tests.

- [ ] **Step 5: Run the full resume-gen suite**

Run: `node --test test/resume-gen.test.mjs 2>&1 | tail -40`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/resume-gen.mjs lib/resume-evidence.mjs test/resume-gen.test.mjs
git commit -m "$(cat <<'EOF'
Flag repeated and near-duplicate PROFESSIONAL_SUMMARY sentences

critiqueResumeDraft already flagged repeated bullet openers but nothing
caught repeated or near-duplicate summary sentences — the defect in the
shipped Arms Cyber resume ("Supported enterprise customers..." twice in
a row). Adds a same-opener check plus a broader jaccard-overlap check
(reusing resume-evidence.mjs's existing near-duplicate-bullet measure,
now exported) so paraphrased duplication with a different opener is also
caught. Both flow through the existing repairDraftFromCritique LM-Studio
repair path; no new repair code needed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Final JD coverage audit that drives a targeted revision pass (not just a log line)

This is the task the whole plan hinges on: a JD coverage audit that only logs its findings doesn't prevent a future resume from shipping with missing evidence — it has to feed back into the pipeline's existing repair mechanism. `generateResumeFinish` already has exactly that mechanism: after page-fit trimming, it recomputes `compareSupportedRequirementCoverage`/`critiqueResumeDraft` and, if either found a problem, calls `finalStrategicReviewAndRepair` (an LM-Studio JSON-diff repair pass against the JD, already wired to re-run page-fit if it changes anything). This task extends *that* trigger condition instead of adding a second, parallel repair path.

**Files:**
- Modify: `lib/resume-gen.mjs` — add `auditJdCoverage` near `supportedRequirementCoverage`/`compareSupportedRequirementCoverage` (found via `grep -n "export function compareSupportedRequirementCoverage" lib/resume-gen.mjs`); extend the existing post-page-fit trigger block inside `generateResumeFinish` (found via `grep -n "post-fit recheck triggered" lib/resume-gen.mjs`) to also run on audit findings; recompute the audit once more, unconditionally, right after that block for the value that gets logged and returned.
- Test: `test/resume-gen.test.mjs` (new `describe('JD coverage audit', ...)` block after `describe('generic resume evidence review', ...)`)

**Interfaces:**
- Consumes: `planningContext.requirements` (Task 1's section-weighted, priority-sorted list), `planningContext.evidenceMap` (Task 3's vault-enriched map), the `replacements` already in scope at each point in `generateResumeFinish`. Reuses `finalStrategicReviewAndRepair` and `fitDynamicResumeLocally` exactly as they exist today — no new repair code.
- Produces: `auditJdCoverage({ requirements, evidenceMap, replacements })` returns `{ covered: string[], missingWithEvidence: string[], unsupportedGaps: string[], buried: string[] }`. `generateResumeFinish`'s resolved value gains one additive field, `coverageAudit`, holding the *post-repair* audit (the one that reflects what actually shipped) — every existing destructuring caller (`generateResume`, `server.mjs`) keeps working since none of them use exhaustive object-shape assertions.

- [ ] **Step 1: Write the failing test**

```javascript
// In test/resume-gen.test.mjs, add after 'generic resume evidence review':
describe('JD coverage audit', () => {
  it('separates covered, missing-despite-evidence, unsupported-gap, and buried requirements', () => {
    const requirements = [
      { requirement: 'onboarding project management', source: 'jd', priority: 9 }, // top-priority, in KEY_ACHIEVEMENT_1 -> covered, not buried
      { requirement: 'people management', source: 'jd', priority: 8 }, // top-priority, evidence exists but no field mentions it -> missingWithEvidence
      { requirement: 'renewal and retention ownership', source: 'jd', priority: 7 }, // top-priority, only in a late-role bullet -> covered, buried
      { requirement: 'CRM opportunity hygiene', source: 'jd', priority: 1 }, // no evidence at all -> unsupportedGaps
    ];
    const evidenceMap = [
      { requirement: 'onboarding project management', status: 'supported' },
      { requirement: 'people management', status: 'supported' },
      { requirement: 'renewal and retention ownership', status: 'supported' },
      { requirement: 'CRM opportunity hygiene', status: 'gap' },
    ];
    const replacements = {
      KEY_ACHIEVEMENT_1: 'Improved onboarding consistency across 87 client relationships.',
      JOB_1_BULLET_1: 'Reduced churn by identifying at-risk accounts and coordinating recovery.',
      JOB_5_BULLET_1: 'Owned renewal execution and expansion for a mid-market book of business.',
    };

    const audit = auditJdCoverage({ requirements, evidenceMap, replacements });

    assert.ok(audit.covered.includes('onboarding project management'));
    assert.ok(!audit.buried.includes('onboarding project management'));
    assert.ok(audit.missingWithEvidence.includes('people management'));
    assert.ok(audit.covered.includes('renewal and retention ownership'));
    assert.ok(audit.buried.includes('renewal and retention ownership'));
    assert.ok(audit.unsupportedGaps.includes('CRM opportunity hygiene'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A15 "JD coverage audit"`
Expected: FAIL — `auditJdCoverage is not defined`.

- [ ] **Step 3: Write minimal implementation**

Add this function directly after `compareSupportedRequirementCoverage`:

```javascript
// Fields visible above the fold / in the most-read role — where a
// top-priority requirement's evidence needs to actually be, not just
// present somewhere in the document.
const PROMINENT_FIELD_RE = /^(PROFESSIONAL_SUMMARY|METRICS_LINE|KEY_ACHIEVEMENT_\d+|JOB_1_BULLET_\d+|JOB_1_CONTEXT)$/;
const TOP_PRIORITY_AUDIT_COUNT = 4;

/**
 * Compares the final resume against the full structured JD requirement set
 * (requirements is already sorted by Task 1's weighted priority, required
 * outranking preferred). Four buckets:
 *   - covered: requirement text appears anywhere in the shipped resume
 *   - missingWithEvidence: verified evidence supports it, but it didn't make
 *     the final cut (e.g. trimmed during page-fit, or outranked by other
 *     content) — never a reason to fabricate a claim, only to reconsider
 *     what got selected
 *   - unsupportedGaps: no verified evidence exists at all — correctly
 *     absent from the resume; surfaced so the gap is visible instead of
 *     silently disappearing
 *   - buried: one of the top TOP_PRIORITY_AUDIT_COUNT requirements by
 *     weighted priority is covered, but only outside the prominent fields
 *     (summary, metrics line, key achievements, most recent role) — present,
 *     but not where a reader skimming the top of the resume would see it
 * Duplicate/repeated phrasing is caught separately (Task 5's summary check,
 * plus verifyResumeEvidence's cross-field repeated-phrase check in
 * resume-evidence.mjs); this function doesn't re-detect it.
 */
export function auditJdCoverage({ requirements = [], evidenceMap = [], replacements = {} } = {}) {
  const resumeText = normalizeText(Object.values(replacements).join(' '));
  const prominentText = normalizeText(
    Object.entries(replacements)
      .filter(([field]) => PROMINENT_FIELD_RE.test(field))
      .map(([, value]) => value)
      .join(' ')
  );
  const topPriority = new Set(requirements.slice(0, TOP_PRIORITY_AUDIT_COUNT).map(item => item.requirement));

  const covered = [];
  const missingWithEvidence = [];
  const unsupportedGaps = [];
  const buried = [];

  for (const item of requirements) {
    const evidence = evidenceMap.find(e => e.requirement === item.requirement);
    if (evidence?.status === 'gap') {
      unsupportedGaps.push(item.requirement);
      continue;
    }
    const words = normalizeText(item.requirement).split(/\s+/).filter(word => word.length >= 4);
    if (!words.some(word => resumeText.includes(word))) {
      missingWithEvidence.push(item.requirement);
      continue;
    }
    covered.push(item.requirement);
    if (topPriority.has(item.requirement) && !words.some(word => prominentText.includes(word))) {
      buried.push(item.requirement);
    }
  }

  return { covered, missingWithEvidence, unsupportedGaps, buried };
}
```

Extend the existing post-page-fit trigger (find the exact surrounding lines via `grep -n "post-fit recheck triggered" lib/resume-gen.mjs`; the block currently reads as shown below — only the `coverageAudit` line and the widened `if` condition are new):

```javascript
        const lostCoverage = compareSupportedRequirementCoverage(preFitReplacements, replacements, planningContext);
        const fittedIssues = critiqueResumeDraft(replacements, planningContext);
        const coverageAudit = auditJdCoverage({
          requirements: planningContext?.requirements,
          evidenceMap: planningContext?.evidenceMap,
          replacements,
        });
        const auditFindingsNeedRevision = coverageAudit.missingWithEvidence.length > 0 || coverageAudit.buried.length > 0;
        if (lostCoverage.length || fittedIssues.length || auditFindingsNeedRevision) {
          log('final-review', `post-fit recheck triggered (lostCoverage=${lostCoverage.length}, issues=${fittedIssues.length}, missingWithEvidence=${coverageAudit.missingWithEvidence.length}, buried=${coverageAudit.buried.length})`);
          emit('final-review', 'started', { message: 'Rechecking fitted resume after layout changes' });
          const postFitFields = activeResumeFields(replacements, fields);
          const reviewed = await finalStrategicReviewAndRepair(
            replacements,
            postFitFields,
            {
              jdText: state.jdText || '',
              candidateTruth: state.candidateTruth || '',
              planningContext,
              log,
              notify: (stage, status, _source, message) => emit(stage, status, message ? { message } : {}),
            }
          );
          const changed = JSON.stringify(reviewed) !== JSON.stringify(replacements);
          replacements = sanitizeReplacementSet(reviewed, fields);
          enforceEvidence('post-fit-review');
          currentFields = activeResumeFields(replacements, fields);
          validateResumeQuality(replacements, currentFields);
          if (changed) {
            ({ unreplaced } = patchDocx(templatePath, replacements, workingDocxPath));
            const refitted = await fitDynamicResumeLocally({
              replacements,
              fields,
              docxPath: workingDocxPath,
              templatePath,
              planningContext,
              jdText: state.jdText || '',
              candidateTruth: state.candidateTruth || '',
              log,
              notify: (stage, status, _source, message) => emit(stage, status, message ? { message } : {}),
            });
            replacements = refitted.replacements;
            unreplaced = refitted.unreplaced;
            knownLayout = refitted.layout;
          }
          emit('final-review', 'done');
        } else {
          log('final-review', 'post-fit recheck passed');
        }
      }
```

(`finalStrategicReviewAndRepair` already takes `jdText`/`candidateTruth`/`planningContext` and asks the model to repair fields against the JD — it doesn't need to be told *which* requirement is missing/buried; the existing prompt already instructs it to compare the resume against the JD. Widening its trigger condition is enough to make it fire for audit findings, without editing its prompt.)

Immediately after that `if (isPageValidationEnabled()) { ... }` block closes (right before the `// Final gate: never mark a resume successful...` comment), recompute the audit unconditionally against whatever `replacements` ended up being — this covers the case where page validation is disabled (`RESUME_PAGE_VALIDATION=0`) and is what actually gets logged/returned:

```javascript
      const finalCoverageAudit = auditJdCoverage({
        requirements: planningContext?.requirements,
        evidenceMap: planningContext?.evidenceMap,
        replacements,
      });
      log('coverage-audit', `covered=${finalCoverageAudit.covered.length} missingWithEvidence=${finalCoverageAudit.missingWithEvidence.length} unsupportedGaps=${finalCoverageAudit.unsupportedGaps.length} buried=${finalCoverageAudit.buried.length}`);
      if (finalCoverageAudit.missingWithEvidence.length) {
        log('coverage-audit', `missing despite evidence: ${finalCoverageAudit.missingWithEvidence.join(', ')}`);
      }
      if (finalCoverageAudit.buried.length) {
        log('coverage-audit', `buried despite evidence: ${finalCoverageAudit.buried.join(', ')}`);
      }
```

Then add `coverageAudit: finalCoverageAudit` to the existing final `return { variant: 'default', docxUrl, pdfUrl, unreplaced, pageCount, pageValidation };` (locate via `grep -n "variant: 'default'" lib/resume-gen.mjs`) — only that one field is new, nothing else in the return statement changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/resume-gen.test.mjs 2>&1 | grep -A15 "JD coverage audit"`
Expected: PASS.

- [ ] **Step 5: Run the full suite, including the DOCX-first resume finish integration tests**

Run: `node --test test/resume-gen.test.mjs 2>&1 | tail -60`
Expected: PASS, including `describe('DOCX-first resume finish', ...)` (~line 780) — those tests call `generateResumeFinish` end-to-end. Widening the trigger condition means the final-review/repair path may now run in scenarios where it previously didn't (any existing fixture whose JD has evidenced-but-unplaced requirements) — if a DOCX-first test's mock LM Studio client isn't set up to answer a `finalStrategicReviewAndRepair` call it wasn't hitting before, extend that test's mock rather than narrowing the trigger condition.

- [ ] **Step 6: Commit**

```bash
git add lib/resume-gen.mjs test/resume-gen.test.mjs
git commit -m "$(cat <<'EOF'
Make the JD coverage audit drive a targeted revision pass, not just a log

auditJdCoverage compares the shipped resume against the full structured
JD requirement set (covered / missing-despite-evidence / unsupported-gap
/ buried-behind-less-relevant-content). Wires its findings into the
existing post-page-fit trigger for finalStrategicReviewAndRepair (the
pipeline's existing targeted-revision mechanism) instead of only logging
them — a resume with important, evidenced requirements missing or buried
now gets one automatic repair attempt before it ships, the same way a
resume that failed the draft critique already did.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Regenerate the Arms Cyber resume, verify the regression, run the full suite

**Files:** none modified — verification only.

**Interfaces:** none new.

- [ ] **Step 1: Run the full test suite**

Run: `npm test 2>&1 | tail -80`
Expected: PASS, 0 failures.

- [ ] **Step 2: Regenerate the Arms Cyber resume through the real pipeline**

Run:
```bash
lsof -ti :3000 | xargs kill -9 2>/dev/null
cd /Users/bmilhizer/career-ops && node server.mjs &
sleep 3
node -e "
import('./lib/resume-gen.mjs').then(async ({ generateResumeDraft, generateResumeFinish }) => {
  const io = { emit: () => {} };
  const state = await generateResumeDraft('li-4459786240', io, '');
  const result = await generateResumeFinish(state);
  console.log(JSON.stringify(result.coverageAudit, null, 2));
});
"
lsof -ti :3000 | xargs kill -9 2>/dev/null
```
Expected: no thrown error; `coverageAudit` prints with `covered`/`missingWithEvidence`/`unsupportedGaps` arrays. `unsupportedGaps` is expected to still include `CRM opportunity hygiene` (no verified evidence exists in `career-evidence/candidate/*.json` for any CRM/customer-success tool — confirmed during planning by grepping the vault) — that's correct behavior (spec: flag the gap, never invent Salesforce/Gainsight), not a regression.

- [ ] **Step 3: Extract the new DOCX text and diff against the pre-change version**

Run:
```bash
python3 -c "
import zipfile, re
z = zipfile.ZipFile('output/resume-arms-cyber-2026-09-28-default.docx')
xml = z.read('word/document.xml').decode('utf8')
print(re.sub('<[^>]+>', '', xml).replace('&amp;', '&'))
" | tr -s ' \n' ' \n' | fold -w 160
```
Expected checks (compare against the baseline captured during planning):
- `PROFESSIONAL_SUMMARY` no longer has two consecutive sentences opening "Supported enterprise customers..." (Task 5).
- `Total Trial Services` now shows at least one bullet (Task 4) — verify against `career-evidence/candidate/achievements.json` achievement-054 through achievement-057 to confirm the bullet is a verified fact, not new text.
- `CORE COMPETENCIES` still has no CRM/customer-success-tool line (correct — no verified evidence; Task 6's `unsupportedGaps` is the mechanism that now surfaces this instead of it silently vanishing).

- [ ] **Step 4: Confirm no unsupported claims were introduced**

Run: `grep -c "Evidence validation failed" logs/*.log 2>/dev/null || echo "no evidence-validation failures logged"`
Expected: The regeneration in Step 2 completed without throwing (already confirmed in Step 2) — this step is a secondary grep-based sanity check of the run's own log output for the evidence-block message, since `generateResumeFinish` throws (not silently logs-and-continues) on a blocking evidence failure in `evidenceMode === 'block'` (the default).

- [ ] **Step 5: Push**

```bash
git push
```

(No further commit here — Tasks 1-6 already committed their own changes; this task is verification-only. If Step 2 or 3 reveals a real defect, fix it as part of the relevant task above, re-run that task's tests, commit, and re-run this task from Step 1.)

---

## Explicitly out of scope (disclosed, not silently dropped)

- **Uniqueness as a distinct `bulletSelectionScore` dimension** (spec item 3 lists relevance/strength/metric/recency/uniqueness as five ranking factors; this plan implements four of the five directly and gets the effect of the fifth from Task 4's per-role floor plus `resume-evidence.mjs`'s existing jaccard near-duplicate suppression during evidence enforcement). Add a dedicated uniqueness term to `bulletSelectionScore` if a future regression shows two selected bullets covering identical ground while a third role's only distinct angle gets trimmed — no such case is confirmed today.
- **"Terminology gaps where equivalent verified experience exists" and "unnecessary/low-value content occupying space"** (two of the seven JD-coverage-audit dimensions in spec item 7). No reliable, non-speculative heuristic for either exists in this codebase today without real false-positive risk (terminology-equivalence needs a synonym judgment call; low-value-content needs a subjective value judgment). `auditJdCoverage` implements the five dimensions that have a concrete, testable definition; these two are left for a future pass once a real miss is observed.
