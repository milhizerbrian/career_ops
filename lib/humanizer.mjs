export const HUMANIZED_OUTPUT_RULES = `HUMANIZER STANDARD:
- Write like a specific senior operator, not a template or generic AI assistant.
- Lead with the concrete point. Avoid setup phrases, throat-clearing, and summary-of-summary language.
- Vary sentence length and rhythm. Mix short direct sentences with slightly longer contextual ones when format allows.
- Use plain verbs and specific nouns. Prefer "built", "fixed", "recovered", "aligned", "reduced", and "owned" over polished abstraction.
- Do not use em dashes, hype language, generic praise, or consultant filler.
- Avoid phrases Brian would not say out loud in a normal professional conversation.
- Keep the required output format exactly as requested, including strict JSON when JSON is required.`;

export function withHumanizer(prompt) {
  return `${prompt}\n\n${HUMANIZED_OUTPUT_RULES}`;
}
