import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { getLmStudioAnalysisModel, DEFAULT_LM_STUDIO_ANALYSIS_MODEL } from '../lib/lm-studio-config.mjs';

describe('LM Studio model config', () => {
  it('uses LM_STUDIO_ANALYSIS_MODEL when provided', () => {
    assert.equal(
      getLmStudioAnalysisModel({ LM_STUDIO_ANALYSIS_MODEL: 'custom-analysis-model' }),
      'custom-analysis-model'
    );
  });

  it('keeps the analysis model fallback in shared config', () => {
    assert.equal(DEFAULT_LM_STUDIO_ANALYSIS_MODEL, 'qwen2.5-coder-7b-instruct-mlx');
    assert.equal(getLmStudioAnalysisModel({}), DEFAULT_LM_STUDIO_ANALYSIS_MODEL);
  });

  it('prevents scanner-local hardcoded model regressions', () => {
    const scanner = readFileSync(new URL('../scan-linkedin.mjs', import.meta.url), 'utf8');
    assert.match(scanner, /getLmStudioAnalysisModel\(\)/);
    assert.doesNotMatch(scanner, /qwen2\.5-coder/);
  });
});
