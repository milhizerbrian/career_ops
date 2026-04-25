import Anthropic from '@anthropic-ai/sdk';
import { loadJobById, loadBragDoc, loadJdFromReports } from './data.mjs';
import { resolveTemplatePath, patchDocx, listTemplatePlaceholders } from './docx-utils.mjs';
import { docxToPdf } from './pdf-utils.mjs';
import { createLogger } from './logger.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── LM Studio helpers ─────────────────────────────────────────────────────────

const LM_STUDIO_BASE = 'http://localhost:1234';

async function lmStudioChat(model, messages, { maxTokens = 2000 } = {}) {
  const res = await fetch(`${LM_STUDIO_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LM Studio HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function localKeywordExtract(jdText) {
  const freq = {};
  for (const w of jdText.replace(/[^a-zA-Z0-9\s\-]/g, ' ').split(/\s+/)) {
    if (w.length >= 7) freq[w.toLowerCase()] = (freq[w.toLowerCase()] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w)
    .join(', ');
}

// ── Pass 1: LM Studio keyword analysis ───────────────────────────────────────

async function pass1KeywordAnalysis(jdText, log) {
  const model = process.env.LM_STUDIO_ANALYSIS_MODEL ?? 'qwen2.5-coder-7b-instruct-mlx';
  const prompt = `Extract the 20 most important ATS keywords and required skills from this job description. Return a comma-separated list only, no explanation.\n\nJOB DESCRIPTION:\n${jdText.slice(0, 4000)}`;

  try {
    const result = await lmStudioChat(model, [{ role: 'user', content: prompt }]);
    log('lm-studio-pass1', 'done');
    return result.trim();
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.name === 'TimeoutError' || err.message.includes('fetch')) {
      log('lm-studio-pass1', `fallback to local extraction (${err.message.slice(0, 60)})`);
      return localKeywordExtract(jdText);
    }
    throw err;
  }
}

// ── Pass 2: Synthesis (Claude or LM Studio) ───────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are a senior executive resume writer and ATS optimization specialist. Return strict JSON only — no markdown, no code fences, no explanation.

Your task: fill every bracket placeholder in the resume template with tailored content for the target job.

HARD RULES:
1. Never invent employers, dates, metrics, certifications, degrees, tools, or experience not in candidate history.
2. Mirror exact JD language wherever candidate history supports it (ATS needs exact strings).
3. If a JD certification is not held, write "currently pursuing [CERT]" only if history supports it, otherwise use related domain language.
4. Every major JD responsibility maps to at least one proof point with metric, scope, stakeholder level, or concrete outcome.
5. Use the JD's dominant verbs naturally in bullets.
6. No banned phrases: results-driven, proven track record, passionate, dynamic, synergy, leverage (jargon), world-class, thought leader.
7. No em dashes.

OUTPUT: Return a single JSON object where each key is a bracket placeholder (without brackets) exactly as it appears in the template, and the value is the replacement text.`;

async function pass2Synthesis(jdText, keywords, bragDoc, placeholders, log) {
  const preferClaude = (process.env.PREFER_CLAUDE_SYNTHESIS ?? '0') === '1';
  const userContent = `CANDIDATE HISTORY:\n${bragDoc}\n\nJOB DESCRIPTION:\n${jdText}\n\nKEYWORDS FROM PASS 1:\n${keywords}\n\nTEMPLATE PLACEHOLDERS TO FILL (return one key per placeholder):\n${placeholders.map(p => `- ${p}`).join('\n')}\n\nReturn a JSON object mapping each placeholder key (without brackets) to its replacement value.`;

  if (preferClaude || !process.env.LM_STUDIO_SYNTHESIS_MODEL) {
    return await claudeSynthesis(userContent, log);
  }

  const model = process.env.LM_STUDIO_SYNTHESIS_MODEL ?? 'qwen2.5-14b-instruct-1m';
  try {
    const raw = await lmStudioChat(
      model,
      [
        { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      { maxTokens: 6000 }
    );
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    log('lm-studio-pass2', 'done');
    return parsed;
  } catch (err) {
    log('lm-studio-pass2', `fallback to Claude (${err.message.slice(0, 80)})`);
    return await claudeSynthesis(userContent, log);
  }
}

async function claudeSynthesis(userContent, log) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';

  const message = await client.messages.create({
    model,
    max_tokens: 8096,
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const rawText = message.content[0]?.text ?? '';
  const cleaned = rawText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const parsed = JSON.parse(cleaned);
  log('claude-synthesis', 'done');
  return parsed;
}

// ── Optional polish pass ──────────────────────────────────────────────────────

async function polishBullets(replacements, log) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return replacements;

  const bulletEntries = Object.entries(replacements)
    .filter(([k]) => k.toLowerCase().includes('achievement') || k.toLowerCase().includes('bullet'));
  if (!bulletEntries.length) return replacements;

  const client = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_POLISH_MODEL ?? 'claude-sonnet-4-6';
  const prompt = `Refine these resume bullet points for concision and impact. Return a JSON object with the same keys and refined values. No explanation.\n\n${JSON.stringify(Object.fromEntries(bulletEntries))}`;

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const polished = JSON.parse(cleaned);
    log('claude-polish', 'done');
    return { ...replacements, ...polished };
  } catch (err) {
    log('claude-polish', `skipped (${err.message.slice(0, 60)})`);
    return replacements;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate a tailored resume DOCX+PDF for the given job ID.
 * Emits socket.io progress events throughout.
 *
 * @param {string} jobId
 * @param {import('socket.io').Server} io
 * @returns {Promise<{ docxUrl: string, pdfUrl: string, unreplaced: string[] }>}
 */
export async function generateResume(jobId, io) {
  const runId = `${jobId}-${Date.now()}`;
  const { log } = createLogger(runId);

  const emit = (stage, status, extra = {}) => {
    io.emit('progress', { jobId, stage, status, ...extra });
    log(stage, status + (extra.message ? ': ' + extra.message : ''));
  };

  const job = loadJobById(jobId);
  let jdText = loadJdFromReports(jobId);
  if (!jdText) {
    jdText = [
      `Company: ${job.company}`,
      `Role: ${job.title}`,
      `Location: ${job.location || ''}`,
      '',
      job.full_description || job.description_preview || '',
    ].join('\n');
  }

  const bragDoc = loadBragDoc();
  const templatePath = resolveTemplatePath();
  const placeholders = listTemplatePlaceholders(templatePath);

  emit('lm-studio', 'started');
  const keywords = await pass1KeywordAnalysis(jdText, log);
  emit('lm-studio', 'done');

  emit('ai', 'started');
  let replacements = await pass2Synthesis(jdText, keywords, bragDoc, placeholders, log);
  emit('ai', 'done');

  emit('polish', 'started');
  replacements = await polishBullets(replacements, log);
  emit('polish', 'done');

  emit('docx', 'started');
  const datePart = new Date().toISOString().slice(0, 10);
  const companySafe = (job.company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const docxFilename = `resume-${companySafe}-${datePart}.docx`;
  const outputDir = path.resolve(APP_ROOT, 'output');
  const docxPath = path.resolve(outputDir, docxFilename);
  const { unreplaced } = patchDocx(templatePath, replacements, docxPath);
  emit('docx', 'done');

  emit('pdf', 'started');
  const pdfPath = await docxToPdf(docxPath, outputDir);
  const pdfFilename = path.basename(pdfPath);
  emit('pdf', 'done');

  const docxUrl = `/output/${docxFilename}`;
  const pdfUrl = `/output/${pdfFilename}`;

  io.emit('complete', { jobId, docxUrl, pdfUrl });
  log('complete', `docx=${docxFilename} pdf=${pdfFilename} unreplaced=${unreplaced.length}`);

  if (unreplaced.length) {
    emit('warning', 'done', { message: `Unreplaced: ${unreplaced.join(', ')}` });
  }

  return { docxUrl, pdfUrl, unreplaced };
}
