export const DEFAULT_LM_STUDIO_ANALYSIS_MODEL = 'qwen2.5-coder-7b-instruct-mlx';

export function getLmStudioAnalysisModel(env = process.env) {
  return env.LM_STUDIO_ANALYSIS_MODEL || DEFAULT_LM_STUDIO_ANALYSIS_MODEL;
}
