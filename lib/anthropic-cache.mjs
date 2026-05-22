export function anthropicPromptCachingEnabled() {
  return !/^(0|false|no)$/i.test(String(process.env.ANTHROPIC_PROMPT_CACHING ?? '1'));
}

export function anthropicRequestCacheControl() {
  return anthropicPromptCachingEnabled() ? { type: 'ephemeral' } : undefined;
}

export function logAnthropicCacheUsage(log, label, usage = {}) {
  const created = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  if (!created && !read) return;
  log(label, `cache write=${created} read=${read}`);
}
