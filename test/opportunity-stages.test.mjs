import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  PIPELINE_STAGES,
  isValidStage,
  normalizeStage,
  deriveStageFromStatus,
  stageToLegacyStatus,
  stageLabel,
  isTerminalStage,
  LEGACY_STATUS_TO_STAGE,
  STAGE_TO_LEGACY_STATUS,
} from '../lib/opportunity-stages.mjs';
import { CANONICAL_STATUSES } from '../lib/status-utils.mjs';

describe('PIPELINE_STAGES', () => {
  it('has all 13 requested stages, in order, with no duplicates', () => {
    assert.equal(PIPELINE_STAGES.length, 13);
    assert.equal(new Set(PIPELINE_STAGES).size, 13);
    assert.deepEqual(PIPELINE_STAGES, [
      'discovered', 'qualified', 'review', 'pursuing', 'materials_ready',
      'applied', 'recruiter_screen', 'interview', 'final_round', 'offer',
      'rejected', 'withdrawn', 'archived',
    ]);
  });
});

describe('normalizeStage / isValidStage', () => {
  it('accepts every canonical stage', () => {
    for (const stage of PIPELINE_STAGES) {
      assert.equal(isValidStage(stage), true);
      assert.equal(normalizeStage(stage), stage);
    }
  });

  it('returns null for unknown or empty stages rather than guessing', () => {
    assert.equal(normalizeStage('not-a-stage'), null);
    assert.equal(normalizeStage(''), null);
    assert.equal(normalizeStage(null), null);
    assert.equal(normalizeStage(undefined), null);
  });

  it('throws for a non-string stage', () => {
    assert.throws(() => normalizeStage(42));
  });
});

describe('deriveStageFromStatus (old -> new, every legacy status covered)', () => {
  it('maps every canonical legacy status to a defined stage', () => {
    for (const status of CANONICAL_STATUSES) {
      const stage = deriveStageFromStatus(status);
      assert.ok(isValidStage(stage), `status "${status}" produced invalid stage "${stage}"`);
    }
  });

  it('matches the documented mapping exactly', () => {
    assert.equal(deriveStageFromStatus('lead'), 'discovered');
    assert.equal(deriveStageFromStatus('interested'), 'pursuing');
    assert.equal(deriveStageFromStatus('applied'), 'applied');
    assert.equal(deriveStageFromStatus('recruiter_screen'), 'recruiter_screen');
    assert.equal(deriveStageFromStatus('hiring_manager_screen'), 'interview');
    assert.equal(deriveStageFromStatus('technical_screen'), 'interview');
    assert.equal(deriveStageFromStatus('onsite'), 'final_round');
    assert.equal(deriveStageFromStatus('offer'), 'offer');
    assert.equal(deriveStageFromStatus('rejected'), 'rejected');
    assert.equal(deriveStageFromStatus('withdrawn'), 'withdrawn');
    assert.equal(deriveStageFromStatus('archived'), 'archived');
  });

  it('falls back to discovered for a null/unknown status rather than throwing', () => {
    assert.equal(deriveStageFromStatus(null), 'discovered');
    assert.equal(deriveStageFromStatus('totally-unknown'), 'discovered');
  });
});

describe('stageToLegacyStatus (new -> old, every stage covered)', () => {
  it('produces a valid canonical status for every stage', () => {
    for (const stage of PIPELINE_STAGES) {
      const status = stageToLegacyStatus(stage);
      assert.ok(CANONICAL_STATUSES.includes(status), `stage "${stage}" produced invalid status "${status}"`);
    }
  });

  it('throws for an invalid stage', () => {
    assert.throws(() => stageToLegacyStatus('not-a-stage'));
  });

  it('round-trips cleanly for every stage that has an exact legacy equivalent', () => {
    const exact = ['discovered', 'applied', 'recruiter_screen', 'offer', 'rejected', 'withdrawn', 'archived'];
    for (const stage of exact) {
      assert.equal(deriveStageFromStatus(stageToLegacyStatus(stage)), stage);
    }
  });
});

describe('LEGACY_STATUS_TO_STAGE / STAGE_TO_LEGACY_STATUS coverage', () => {
  it('every canonical status has a mapping', () => {
    for (const status of CANONICAL_STATUSES) {
      assert.ok(status in LEGACY_STATUS_TO_STAGE, `missing mapping for status "${status}"`);
    }
  });

  it('every stage has a reverse mapping', () => {
    for (const stage of PIPELINE_STAGES) {
      assert.ok(stage in STAGE_TO_LEGACY_STATUS, `missing reverse mapping for stage "${stage}"`);
    }
  });
});

describe('stageLabel / isTerminalStage', () => {
  it('produces a human label for every stage', () => {
    for (const stage of PIPELINE_STAGES) {
      assert.ok(stageLabel(stage).length > 0);
    }
  });

  it('flags exactly the four terminal stages', () => {
    const terminal = PIPELINE_STAGES.filter(isTerminalStage);
    assert.deepEqual(terminal.sort(), ['archived', 'offer', 'rejected', 'withdrawn'].sort());
  });
});
