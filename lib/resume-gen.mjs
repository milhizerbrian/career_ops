import { loadJobById, loadBragDoc, saveBragDoc, loadLinkedInText, loadJdFromReports } from './data.mjs';
import { loadCandidateFacts, evidenceValidationMode } from './candidate-data.mjs';
import { findUnsupportedFactualClaims, validateGeneratedClaims } from './evidence-validator.mjs';
import { resolveTemplatePath, patchDocx, listTemplateFields, tightenDocxLayout } from './docx-utils.mjs';
import { docxToPdf, getPdfPageCount, getPdfPageMetrics } from './pdf-utils.mjs';
import { createLogger, redactSecrets } from './logger.mjs';
import { getLmStudioAnalysisModel } from './lm-studio-config.mjs';
import { HUMANIZED_OUTPUT_RULES, withHumanizer } from './humanizer.mjs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDF_VALIDATION_DISABLED = {
  status: 'skipped',
  message: 'PDF validation disabled',
};
const MIN_FULL_SECOND_PAGE_RATIO = Number(process.env.RESUME_MIN_SECOND_PAGE_FILL_RATIO ?? '0.88');
const MAX_RENDERED_RESUME_WORDS = Number(process.env.RESUME_MAX_RENDERED_WORDS ?? '1000');
const PROFILE_PDF_NAME = 'Profile.pdf';
const MASTER_BRAG_NAME = 'master-brag-document.md';
const TEMPLATE_NAME = 'FINAL Brian Milhizer Production Resume Template v3.dotx';
const ROLE_SLOT_COUNTS = [5, 4, 4, 3, 3, 2];
const DEFAULT_DYNAMIC_BULLET_BUDGET = Number(process.env.RESUME_BULLET_BUDGET ?? '18');

const RESUME_IMPROVEMENT_PRINCIPLES = [
  'Lead with measurable results: prioritize metrics, scope, stakeholder level, and business outcomes over responsibility statements.',
  'Tailor to the exact JD: mirror supported keywords, role function, buyer, and operating model without copying unsupported target ranges.',
  'Strengthen the top third: TITLE_LINE, METRICS_LINE, PROFESSIONAL_SUMMARY, CORE_COMPETENCIES, and KEY_ACHIEVEMENTS must make seniority, fit, scale, and credibility obvious in seconds.',
  'Write clear impact bullets: start with concrete action, then show mechanism, scope, domain language, and outcome without repeated openers or generic verbs.',
  'Remove clutter: omit weak, stale, duplicated, unsupported, low-match, or source-domain-heavy details that do not improve fit for the target role.',
];

const TOP_APPLICANT_RESUME_PRINCIPLES = [
  'Increase evidence density: every major claim should carry dollars, percentages, account count, customer segment, team size, timeline, platform, or executive audience.',
  'Show judgment, not activity: explain the problem, decision, tradeoff, prioritization, or sequencing behind the outcome.',
  'Match the role business model: enterprise SaaS, startup CS, pre-sales, MSP delivery, and cybersecurity advisory resumes must optimize for different success measures.',
  'Make accomplishments hard to copy: use specific operating systems, playbooks, workflows, governance models, escalation paths, or customer motions Brian built.',
  'Use a final hiring-manager rejection lens: remove anything that leaves fit unclear, proof weak, bullets generic, JD priorities missing, or skills overstuffed.',
];

// ── Local AI (LM Studio only) ─────────────────────────────────────────────────
// Career-Ops uses no paid AI APIs: every AI step in resume generation runs on
// the local LM Studio server via lmStudioChat(). localAiClient keeps the
// `messages.create({ max_tokens, system, messages })` -> `{ content: [{ text }] }`
// call shape the pipeline steps below were written against. Optional steps
// (critique/quality/final-review/page-fit/polish) keep their deterministic
// fallbacks when LM Studio errors; synthesis fails with a clear LM Studio error.
function localAiEnabled() {
  return process.env.CAREER_OPS_DISABLE_LM_STUDIO !== '1';
}

function localResumeModel() {
  return process.env.LM_STUDIO_SYNTHESIS_MODEL || getLmStudioAnalysisModel();
}

function localAiTimeoutMs() {
  return parseInt(process.env.LM_STUDIO_SYNTHESIS_TIMEOUT_MS ?? '180000', 10);
}

const execFileAsync = promisify(execFile);

/**
 * Makes sure the local resume model is loaded with enough context for the
 * synthesis prompt. LM Studio's on-demand loading uses a small default
 * context, which rejects the prompt. Uses the `lms` CLI when present and
 * sets an idle TTL so the model still frees memory after an hour unused.
 * Returns 'ready' | 'loaded' | 'no-cli' | 'unknown' | 'disabled'.
 */
export async function ensureLocalModelContext({
  model = localResumeModel(),
  contextTokens = parseInt(process.env.LM_STUDIO_CONTEXT_TOKENS ?? '16384', 10),
  fetchImpl = fetch,
  execImpl = (file, args) => execFileAsync(file, args, { timeout: 180_000 }),
  lmsPath = process.env.LMS_CLI_PATH || path.join(os.homedir(), '.lmstudio', 'bin', 'lms'),
  exists = fs.existsSync,
  log = () => {},
} = {}) {
  if (!localAiEnabled()) return 'disabled';
  let info;
  try {
    const res = await fetchImpl(`${LM_STUDIO_BASE}/api/v0/models/${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(5000) });
    info = await res.json();
  } catch {
    return 'unknown'; // LM Studio unreachable; synthesis reports the clear error
  }
  const loadedContext = Number(info?.loaded_context_length);
  if (info?.state === 'loaded' && (!Number.isFinite(loadedContext) || loadedContext >= contextTokens)) return 'ready';
  if (!exists(lmsPath)) {
    log('lm-studio', `${model} not loaded with ${contextTokens} context and lms CLI not found; relying on LM Studio on-demand load`);
    return 'no-cli';
  }
  if (info?.state === 'loaded') await execImpl(lmsPath, ['unload', model]);
  await execImpl(lmsPath, ['load', model, '--context-length', String(contextTokens), '--ttl', '3600', '-y']);
  log('lm-studio', `loaded ${model} with ${contextTokens} context`);
  return 'loaded';
}

const localAiClient = {
  messages: {
    async create({ model = localResumeModel(), max_tokens: maxTokens = 2000, system, messages = [] } = {}) {
      const systemText = Array.isArray(system) ? system.map(block => block?.text ?? '').join('\n') : system;
      const chat = [...(systemText ? [{ role: 'system', content: systemText }] : []), ...messages];
      const text = await lmStudioChat(model, chat, { maxTokens, timeoutMs: localAiTimeoutMs() });
      return { content: [{ type: 'text', text }] };
    },
  },
};

// ── LM Studio helpers ─────────────────────────────────────────────────────────

const LM_STUDIO_BASE = 'http://localhost:1234';

export async function lmStudioChat(model, messages, { maxTokens = 2000, timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${LM_STUDIO_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = /context length/i.test(body)
      ? ` Load the model with a larger context, e.g. \`lms load ${model} --context-length 16384\`.`
      : '';
    throw new Error(`LM Studio HTTP ${res.status}: ${body.slice(0, 200)}${hint}`);
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

export function buildCandidateTruthContext({
  bragDoc,
  linkedInText = '',
  templatePath = '',
} = {}) {
  const sources = [
    `${MASTER_BRAG_NAME}: detailed evidence, metrics, positioning, writing rules, and supported accomplishments.`,
    `${PROFILE_PDF_NAME}: LinkedIn/export backstop for role chronology, exact titles, dates, profile wording, and tenure. Use it to verify, not to invent.`,
    `${TEMPLATE_NAME}: required DOCX structure, fillable fields, formatting constraints, and output shape.`,
  ];
  return [
    'PRIMARY RESUME SOURCES OF TRUTH:',
    ...sources.map(source => `- ${source}`),
    templatePath ? `- Active template path: ${templatePath}` : '',
    '',
    'SOURCE PRECEDENCE:',
    '1. If a title, date, employer, certification, or metric conflicts, use only facts supported by the master brag document or Profile.pdf.',
    '2. Use the master brag document for detailed achievement evidence and operator framing.',
    '3. Use Profile.pdf as a chronology/title/date backstop.',
    '4. Use the v3 DOTX template fields exactly; do not add user-facing fields or change the dashboard workflow.',
    '',
    `MASTER_BRAG_DOCUMENT (${MASTER_BRAG_NAME}):`,
    String(bragDoc ?? '').trim(),
    '',
    `LINKEDIN_PROFILE_BACKSTOP (${PROFILE_PDF_NAME}):`,
    String(linkedInText ?? '').trim() || '[Profile.pdf unavailable or unreadable]',
  ].filter(line => line !== '').join('\n');
}

// ── Pass 1: LM Studio keyword analysis ───────────────────────────────────────

// Input caps for synthesis pass — tune via env vars
const CAP_BRAG  = parseInt(process.env.SYNTH_BRAG_CHARS  ?? '8000', 10);
const CAP_JD    = parseInt(process.env.SYNTH_JD_CHARS    ?? '5000', 10);

async function pass1KeywordAnalysis(jdText, log, notify = () => {}) {
  if (!localAiEnabled()) {
    const keywords = localKeywordExtract(jdText);
    log('local-pass1', 'done');
    notify('keyword-analysis', 'done', 'Local', 'Keywords extracted locally');
    return keywords;
  }

  const model = getLmStudioAnalysisModel();
  const prompt = `Extract the 20 most important ATS keywords and required skills from this job description. Return a comma-separated list only, no explanation.\n\nJOB DESCRIPTION:\n${jdText.slice(0, 2500)}`;

  try {
    notify('lm-keyword', 'running', 'LM Studio', `Extracting keywords · ${model}`);
    const result = await lmStudioChat(model, [{ role: 'user', content: prompt }], { maxTokens: 300 });
    log('lm-studio-pass1', 'done');
    notify('lm-keyword', 'done', 'LM Studio', 'Keywords extracted');
    return result.trim();
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.name === 'TimeoutError' || err.message.includes('fetch')) {
      log('lm-studio-pass1', `fallback to local extraction (${err.message.slice(0, 60)})`);
      notify('lm-keyword', 'fallback', 'local', 'LM Studio unavailable — local keyword extraction');
      return localKeywordExtract(jdText);
    }
    throw err;
  }
}

// ── Pass 2: Synthesis (Claude or LM Studio) ───────────────────────────────────

const SYNTHESIS_SYSTEM_PROMPT = `You are an elite executive resume strategist for top-1% enterprise technical advisory, solutions engineering, customer success engineering, TAM, and cybersecurity GTM candidates. Return strict JSON only — no markdown, no explanation.

Fill every named template field with content tailored to the target job.

CANONICAL CANDIDATE GUARDRAILS:
- Exact role titles only. Do not inflate titles. ExtraHop: Customer Success Engineer (Strategic Accounts). Securonix: Strategic Customer Success Manager. McAfee: Enterprise CSM. Auth0/Okta: Senior CSM. Total Trial Services: Director of CS. Proofpoint: CSM. Trend Micro: TAM/Customer Account Manager. Dynatrace: Global Manager, Technical Support & Sales Engineer.
- Core identity: senior CS/TAM/CSE/CS Architect operator in cybersecurity SaaS across NDR, SIEM, XDR, EDR, IAM, NPM, SOC enablement, identity, cloud, and enterprise security operations.
- Differentiation standard: every bullet should make clear what Brian did that most senior applicants would not. Show the problem, the decision/system/method, and the measurable result.
- Operator thesis: frame Brian as someone who builds systems, aligns stakeholders, drives execution, closes gaps, and owns commercial outcomes. Do not frame him as a relationship manager, support contact, or passive facilitator.

RULES:
0. UNIVERSAL RESUME IMPROVEMENT STANDARD:
${RESUME_IMPROVEMENT_PRINCIPLES.map((principle, index) => `   ${index + 1}. ${principle}`).join('\n')}
0A. TOP-1% APPLICANT STANDARD:
${TOP_APPLICANT_RESUME_PRINCIPLES.map((principle, index) => `   ${index + 1}. ${principle}`).join('\n')}
1. Never invent employers, dates, metrics, certs, tools, or experience not in candidate history.
2. Mirror exact JD language for ATS matching only when candidate history supports it.
3. Every major JD requirement maps to a proof point with metric, scope, stakeholder, product/domain, or outcome.
4. Use the JD's dominant verbs naturally. No em dashes.
5. Banned: results-driven, proven track record, passionate, dynamic, synergy, leverage as jargon, world-class, best-in-class, thought leader, empowered.
6. QUALITY BAR: Write for a top-1% applicant. Basic bullets are unacceptable. Each job bullet must include at least two of these five elements: measurable impact, scope, method/system, stakeholder, and business outcome. Strong bullets include scope, concrete action/mechanism, domain language, and measurable outcome where available.
7. DEPTH: Do not write generic activity bullets like "managed accounts", "supported customers", "partnered with teams", "drove adoption", or "improved engagement" unless the same sentence explains the specific scope, mechanism, and result.
8. TWO-PAGE TARGET: The finished DOCX must be a full, dense 2-page resume only. Do not produce a sparse 1-page or 1.5-page resume, and do not run onto a third page. PROFESSIONAL_SUMMARY should be 60-85 words across 3 sentences. KEY_ACHIEVEMENT fields should be 20-30 words. Role context fields should be 18-26 words. Candidate experience bullets should be 24-36 words and may wrap to two lines if needed.
9. CHARACTER TARGETS: For JOB_1 through JOB_4 bullets, target 175-240 characters. For older or compressed JOB_5+ bullets, target 140-210 characters.
10. Return more candidate bullets for stronger JD matches and fewer for weak matches. Older or less relevant roles may return zero candidate bullets when the context line is sufficient. Do not write filler merely to populate a role.
11. ROLE FRAME: Infer the target function from the JD title, responsibilities, and repeated vocabulary before writing. Do not default to Customer Success language when the JD is pre-sales, solutions architecture, sales engineering, technical advisory, or a startup CSM builder role.
12. PRE-SALES / SOLUTIONS ARCHITECT MODE: When the JD mentions solution architect, client solutions engineer, sales engineer, pre-sales, presales, technical architect, solution sizing, BOM, RFP/RFI, POC, demo, discovery, technical sales campaign, data center, cloud management, infrastructure, or security architecture:
   - TITLE_LINE must mirror the JD function and signal role comprehension, e.g. Senior Client Solutions Engineer | Pre-Sales Technical Advisory | Enterprise Cloud & Security Architecture. Do not open with Enterprise Customer Success leader.
   - PROFESSIONAL_SUMMARY must open with a pre-sales/technical-advisory identity and include campaign ownership, architecture/design guidance, SME positioning, and solution sizing or BOM review when supported by the JD and candidate history.
   - CORE_COMPETENCIES should be the only skills/platform section. Use labeled groups when possible: Security Platforms, Cloud & Infrastructure, GTM/CS Platforms, and Security Domains. Use named platforms from candidate history or the JD only. Do not create or imply a duplicate Tools & Platforms block.
   - CERTIFICATIONS_LINE must prioritize the most relevant supported cybersecurity certification first. For technical cybersecurity, sales engineering, endpoint, application control, Zero Trust, or security architecture roles, lead with Certified Ethical Hacker (CEH).
   - ExtraHop bullets should prioritize architecture design decisions, technical business case construction, solution design changes, demos/discovery, and stakeholder technical advisory. Cut or de-emphasize pure adoption, renewal recovery, NRR, churn, or account-health metrics unless tied directly to technical sales execution.
   - Securonix bullets should lead with SIEM/log ingestion architecture, vulnerability-management integrations, onboarding architecture, competitive displacement, and security workflow design. Do not lead with internal CS health scoring or escalation operations.
13. CUSTOMER SUCCESS MODE: Use retention, NRR, renewal, churn prevention, adoption, and account-health vocabulary only when the JD is actually a CS, CSM, TAM, renewal, or post-sale leadership role.
   - For commercial CSM roles, treat NRR/quota, ARR, renewal, upsell, cross-sell, account health, risk action plans, executive business reviews, demos, escalations, and team mentorship as first-class JD requirements when present.
   - Do not copy the JD's target workload range, such as "30-40 named accounts", into the resume as candidate history unless the source truth supports that exact range. Translate it as named-account or portfolio management instead.
14. STARTUP CSM BUILDER MODE: When the JD is an individual-contributor CSM role at a high-growth startup and repeatedly asks for build-from-scratch ownership, process design, scalable onboarding workflows, AI-driven efficiency, Voice of Customer, cross-functional quarterbacking, onsite engagement, or customer advocacy:
   - Do not over-position Brian as a Director, people manager, or generic strategic account owner. TITLE_LINE should mirror the CSM job while signaling cybersecurity startup CS builder, process design, and threat-hunting domain fluency.
   - PROFESSIONAL_SUMMARY must make Total Trial Services prominent as proof that Brian built a CS function from scratch, while preserving ExtraHop and Securonix as the cybersecurity proof base.
   - KEY_ACHIEVEMENTS must include one Total Trial Services builder proof point when fields are available: 87 clients, 8 direct reports, 22% retention improvement, onboarding consistency, satisfaction tracking, or escalation handling.
   - CORE_COMPETENCIES must include Process Design & Implementation, Scalable Onboarding Workflows, AI-Assisted Documentation / Workflow Scale, Strategic Business Reviews, Voice of Customer, Product & Engineering Feedback Loops, Sales Handoffs, Marketing Advocacy, Threat Hunting, Behavioral Detection, Endpoint / Identity / Cloud Telemetry, Credential Misuse, Lateral Movement, and Post-Access Activity when source-supported or JD-supported.
   - ExtraHop bullets should lead with NDR threat visibility, investigation workflows, behavioral detection/use-case mapping, telemetry-driven workflow improvement, onboarding/time-to-value, CISO stakeholder alignment, and cross-functional execution. Do not claim direct AI workflow automation unless source truth contains concrete proof.
   - Securonix bullets should lead with SIEM/UEBA onboarding reduction, lifecycle model building, escalation protocols, investigation workflows, and Product/Engineering feedback loops.
   - Total Trial Services bullets must not be buried when the JD asks for build-from-scratch process ownership; include at least one bullet or key achievement if the template fields allow it.
   - Downrank pure director-level people leadership, broad enterprise portfolio management, and NRR-heavy commercial framing unless tied directly to startup CS operating systems and customer value.
15. COMMERCIAL STARTUP CSM BUILDER MODE: When the JD asks a CSM to own a book of business, expansion, retention, churn save, AE partnership, account planning, renewal motions, CRM/Pipedrive hygiene, and startup playbook building:
   - Frame Brian as a commercial CSM operator and CS-function builder, not a support rep, TAM, generic strategic account manager, or cybersecurity-only specialist.
   - TITLE_LINE must mirror Customer Success Manager while signaling expansion, retention, churn save, startup CS playbook building, AE partnership, and physical-security / IoT adjacency when relevant.
   - PROFESSIONAL_SUMMARY must make Total Trial Services prominent as proof that Brian built a CS function from scratch; pair it with Securonix churn-save/onboarding proof and ExtraHop enterprise renewal/expansion discipline.
   - KEY_ACHIEVEMENTS must include one Total Trial Services builder proof point and one Securonix churn-save or onboarding proof point when fields are available: 100% renewal, three at-risk accounts retained, 30% onboarding reduction, or 81% ARR expansion.
   - CORE_COMPETENCIES must prioritize Expansion & Retention Ownership, Churn Save, Book of Business Management, AE Partnership, Account Planning, Renewal Motions, Pipedrive / CRM Hygiene, QBRs, Proactive Outreach, Playbook Building, Voice of Customer, Product Feedback, Startup Operating Cadence, Physical Security / IoT Adjacency, Security Chiefs / IT / Ops Stakeholders.
   - Treat physical security, IoT, hardware-software, facilities, ops, and security chiefs as an adjacency/buyer bridge unless source truth says Brian has direct experience.
   - Do not invent AI deployed inside customer SOC environments or direct physical-security background. Downrank threat-hunting and telemetry inventories unless the JD is explicitly cybersecurity.
16A. AI-NATIVE CUSTOMER EXPERIENCE MODE: When the JD is for a CXM/CSM at an enterprise AI, conversational AI, AI-agent, AI-copilot, LLM, or autonomous-support platform:
   - TITLE_LINE must mirror Customer Experience Manager / Strategic CXM and signal Enterprise AI Platform Adoption, Strategic Account Leadership, and quality/usage-data feedback loops.
   - PROFESSIONAL_SUMMARY must translate supported experience into complex enterprise onboarding, adoption/consumption, multi-department workflow integration, Product/Engineering feedback loops, quality/usage data, and Fortune 100/500 stakeholder management.
   - Do not claim direct LLM, prompt tuning, training-data, conversational-AI implementation, AI-agent deployment, or customer-deployed AI workflow automation unless concrete source truth exists.
   - KEY_ACHIEVEMENTS must elevate McAfee's largest cloud-security onboarding/highest NPS, Securonix usage-data and Product/Engineering feedback proof, Auth0 integration complexity, and ExtraHop telemetry-driven business cases when fields allow.
   - Downrank NDR/SIEM acronym inventories, threat hunting, and cybersecurity as the headline unless translated into customer-experience, adoption, integration, and business-outcome language.
16B. MSP / COMPLIANCE DELIVERY MODE: When the JD emphasizes managed services, compliance programs, service delivery, onboarding project management, corrective action plans, technical project execution, technology rollouts, environment builds, dashboards, ticket queues, backlog, escalation accountability, or cross-functional execution:
   - Reframe the resume around delivery accountability, execution coordination, operating cadence, playbooks, escalation protocols, customer communication, and team standards.
   - TITLE_LINE should signal managed services, cybersecurity delivery, execution leadership, compliance-aligned program delivery, or service delivery leadership. Do not lead with Retention & Expansion Ownership.
   - METRICS_LINE should prioritize scale, team leadership, portfolio size, retention, CS function building, onboarding reduction, or direct reports ahead of NRR.
   - PROFESSIONAL_SUMMARY should read like a general manager of customer delivery: onboarding execution, corrective action coordination, escalation accountability, cross-functional team alignment, and process scale.
   - CORE_COMPETENCIES should be a clean competency list with execution/project/compliance/service-delivery terms. Avoid a duplicate Tools & Platforms inventory unless the JD is platform-specific.
   - Use compliance-adjacent language honestly. If CMMC, DIB, GRC, or audit language appears in the JD but candidate history does not show direct experience, say compliance-aligned, regulated-industry, audit-readiness, DLP, IAM, email security, SIEM/SOC, or policy-enforcement workflows only where supported. Do not claim direct CMMC ownership unless present in source material.
   - ExtraHop bullets should lead with onboarding, time-to-value, delivery roadmap, executive/technical alignment, adoption gap resolution, and measurable customer outcome before expansion language.
   - Securonix and Total Trial Services should emphasize lifecycle model building, onboarding reduction, escalation protocols, team accountability, and delivery infrastructure.
   - Downrank pure QBR pipeline, expansion-assist, NRR, ARR growth, and commercial-owner language unless the JD makes upsell/renewal ownership a dominant requirement.
17. SUMMARY: Three sentences maximum. Sentence 1 shows domain, seniority, scope, and years. Sentence 2 states the operator thesis. Sentence 3 gives a hard-to-replicate differentiator tied to the JD's unstated priorities. Do not open with a personal pronoun or adjective-heavy phrase.
18. 7-SECOND SCAN: Above the fold, make seniority, scale, role-specific outcome, and cybersecurity domain credibility immediately visible. For SaaS CS roles, the outcome may be retention/expansion. For delivery/compliance roles, the outcome should be execution, onboarding, escalation, compliance alignment, or team operating scale.
19. HUMAN VOICE: Apply the humanizer standard. No JD restatements, no "Responsible for..." phrasing, no three consecutive gerund-opening bullets, no identical sentence structures inside the same role, no consecutive bullets starting with the same verb. Use concrete operator language that Brian could say out loud.
20. METRICS_LINE should use Brian's strongest truthful scale signal for the JD. For enterprise cybersecurity or Sales Engineer roles, prefer $55M ARR Portfolio (peak) over lower current-role portfolio numbers unless the JD clearly values most-recent scope more.
21. When a supported metric is missing, use a neutral placeholder such as [X%] or [$XM ARR] rather than inventing a number.

${HUMANIZED_OUTPUT_RULES}

FIELDS: TITLE_LINE=positioning tagline | METRICS_LINE=4-5 compact career metrics | PROFESSIONAL_SUMMARY=3 strong executive sentences | CORE_COMPETENCIES=single skills/platform section with labeled platform/domain groups where useful | KEY_ACHIEVEMENT_1-4=metric-driven accomplishment | CERTIFICATIONS_LINE=certifications only, ordered by JD relevance and source truth | ROLES=array of six chronological role objects with roleIndex, context, and bullets[]

Return strict JSON. Use scalar fields for the top-level sections plus ROLES: [{roleIndex: 1, context: "...", bullets: ["...", "..."]}, ...].`;

export function synthesisSystemBlocks() {
  return SYNTHESIS_SYSTEM_PROMPT;
}

const ROLE_DEFINITIONS = [
  {
    mode: 'pre-sales-solutions-architecture',
    terms: [
      'solution architect',
      'solutions architect',
      'client solutions engineer',
      'sales engineer',
      'pre-sales',
      'presales',
      'technical architect',
      'solution sizing',
      'bill of materials',
      'bom',
      'rfp',
      'rfi',
      'proof of concept',
      'poc',
      'demo',
      'technical sales campaign',
      'data center',
      'cloud management',
      'infrastructure architecture',
      'security architecture',
    ],
  },
  {
    mode: 'msp-compliance-delivery',
    terms: [
      'managed services',
      'managed service provider',
      'msp',
      'service delivery',
      'compliance program',
      'cmmc',
      'defense industrial base',
      'dib',
      'corrective action plan',
      'corrective action plans',
      'execution coordination',
      'onboarding project management',
      'project management',
      'technical projects',
      'technology rollouts',
      'environment builds',
      'ticket queues',
      'backlog',
      'escalation with accountability',
      'single point of accountability',
      'conductor',
      'orchestra',
      'playbooks',
      'dashboards',
      'customer communication',
      'team optimization',
    ],
  },
  {
    mode: 'ai-customer-experience',
    terms: [
      'customer experience manager',
      'cxm',
      'enterprise ai platform',
      'conversational ai',
      'ai agent',
      'ai agents',
      'ai copilot',
      'ai copilots',
      'llm',
      'llms',
      'prompt tuning',
      'training data',
      'ai quality',
      'quality response generation',
      'customer service ai',
      'autonomous support',
      'support use case',
      'contracted volumes',
      'consumption',
      'human and ai-generated responses',
    ],
  },
  {
    mode: 'startup-commercial-cs-builder',
    terms: [
      'book of business',
      'expansion',
      'retention',
      'churn save',
      'gross retention',
      'net new revenue from existing accounts',
      'shared accounts',
      'account executives',
      'aes',
      'account planning',
      'renewal motions',
      'renewal strategy',
      'expansion strategy',
      'pipedrive',
      'customer records',
      'account context',
      'startup mentality',
      'build rather than inherit',
      'no fully established playbooks',
      'playbook building',
      'shape cs',
      'physical security',
      'iot',
      'hardware-software',
      'industrial tech',
      'ops leaders',
      'facilities leaders',
      'security chiefs',
    ],
  },
  {
    mode: 'startup-cs-builder',
    terms: [
      'startup enthusiast',
      'high-growth startup',
      'fast-paced cybersecurity company',
      'fast-paced startup',
      'build from the ground up',
      'from the ground up',
      'foundational member',
      'foundational member of the cs team',
      'process design',
      'process design & implementation',
      'designing, building, and iterating',
      'scalable onboarding workflows',
      'customer support processes',
      'ai-driven efficiency',
      'generative ai tools',
      'chatgpt',
      'claude',
      'gemini',
      'internal quarterback',
      'voice of the customer',
      'onsite customer engagement',
      'strategic business reviews',
      'security workshops',
      'sales synergy',
      'marketing advocacy',
      'case studies',
      'testimonials',
    ],
  },
  {
    mode: 'strategic-cs-leadership',
    terms: [
      'director, customer success',
      'director customer success',
      'strategic customer success',
      'strategic enterprise accounts',
      'customer success strategy',
      'customer health',
      'value realization',
      'executive sponsor',
      'executive-level relationships',
      'team of senior customer success',
      'lead, coach, and develop',
      'high-performing customer success team',
      'segmentation strategy',
      'organizational planning',
      'customer planning',
      'high-growth environment',
      'fast-paced, mission-driven',
    ],
  },
  {
    mode: 'tam',
    terms: [
      'technical account manager',
      'tam',
      'technical account',
      'account planning',
      'escalation management',
      'customer engineering',
      'technical relationship',
    ],
  },
  {
    mode: 'cse',
    terms: [
      'customer success engineer',
      'technical customer success',
      'implementation engineer',
      'customer engineer',
      'technical onboarding',
      'solution adoption',
    ],
  },
  {
    mode: 'leadership',
    terms: [
      'director',
      'senior manager',
      'head of',
      'vp ',
      'vice president',
      'people manager',
      'team leadership',
      'build the team',
      'manage a team',
    ],
  },
  {
    mode: 'customer-success',
    terms: [
      'customer success manager',
      'customer success',
      'renewal',
      'retention',
      'churn',
      'nrr',
      'adoption',
      'account health',
      'post-sale',
      'post sale',
    ],
  },
];

export const REQUIREMENT_CATALOG = [
  { phrase: 'named account portfolio management', aliases: ['named accounts', 'portfolio of', 'customer portfolio', 'existing customers', 'global customer base', 'book of business'] },
  { phrase: 'commercial NRR and expansion ownership', aliases: ['net revenue retention', 'nrr', 'quarterly quota', 'commission', 'upsell', 'cross-sell', 'cross sell', 'annual recurring revenue', 'arr', 'renewals', 'expansion'] },
  { phrase: 'solution presentation and demonstration', aliases: ['present', 'presents', 'presentation', 'discuss', 'demonstrate', 'demonstrates', 'demonstration', 'demo', 'demos'] },
  { phrase: 'deployment health checks and risk action plans', aliases: ['health checks', 'deployment health', 'customer engagement levels', 'assess risk', 'action plans', 'account health', 'health score'] },
  { phrase: 'customer escalation management', aliases: ['customer escalations', 'manage escalations', 'escalation management', 'escalations to resolution'] },
  { phrase: 'CSM mentorship and ramp', aliases: ['mentor developing customer success managers', 'mentor', 'mentorship', 'best practices', 'ramp up new team members', 'new team members'] },
  { phrase: 'managed services delivery', aliases: ['managed services', 'managed service provider', 'msp', 'service delivery'] },
  { phrase: 'compliance program delivery', aliases: ['compliance program', 'compliance', 'cmmc', 'dib', 'defense industrial base'] },
  { phrase: 'corrective action plan management', aliases: ['corrective action plan', 'corrective action plans', 'cap management'] },
  { phrase: 'technical project coordination', aliases: ['technical project', 'technical projects', 'project management', 'technology rollouts', 'environment builds'] },
  { phrase: 'onboarding project management', aliases: ['onboarding project management', 'onboarding', 'implementation', 'customer onboarding'] },
  { phrase: 'escalation accountability', aliases: ['escalation with accountability', 'escalation accountability', 'escalation', 'mitigation paths'] },
  { phrase: 'service instrumentation and dashboards', aliases: ['dashboards', 'ticket queues', 'backlog', 'kpis', 'health indicators'] },
  { phrase: 'team standards and accountability', aliases: ['team leadership', 'team optimization', 'hold team members accountable', 'standards'] },
  { phrase: 'solution sizing', aliases: ['solution sizing', 'sizing'] },
  { phrase: 'BOM review', aliases: ['bom', 'bill of materials'] },
  { phrase: 'data center infrastructure', aliases: ['data center', 'infrastructure'] },
  { phrase: 'cloud management', aliases: ['cloud management', 'cloud'] },
  { phrase: 'security architecture', aliases: ['security architecture', 'cybersecurity architecture'] },
  { phrase: 'pre-sales technical campaigns', aliases: ['pre-sales', 'presales', 'technical sales campaign'] },
  { phrase: 'technical discovery', aliases: ['discovery', 'technical discovery'] },
  { phrase: 'demos and proof of concept', aliases: ['demo', 'demos', 'poc', 'proof of concept'] },
  { phrase: 'RFP/RFI response', aliases: ['rfp', 'rfi'] },
  { phrase: 'SME positioning', aliases: ['sme', 'subject matter expert'] },
  { phrase: 'SIEM/log ingestion architecture', aliases: ['siem', 'log ingestion'] },
  { phrase: 'vulnerability management integration', aliases: ['vulnerability management', 'vulnerability-management integration', 'vulnerability scanner integration'] },
  { phrase: 'AI governance', aliases: ['ai governance', 'ai standards', 'agentic security', 'ai agent security'] },
  { phrase: 'AI platform adoption', aliases: ['enterprise ai platform', 'ai platform', 'ai solutions', 'ai copilots', 'ai agents', 'conversational ai', 'autonomous support'] },
  { phrase: 'AI quality and response improvement', aliases: ['ai quality', 'quality response generation', 'human and ai-generated responses', 'prompt tuning', 'training data', 'responses where', 'high quality'] },
  { phrase: 'consumption-based adoption', aliases: ['consumption', 'contracted volumes', 'scale usage', 'usage', 'adoption and expansion'] },
  { phrase: 'enterprise workflow integration', aliases: ['integrates knowledge', 'personalization sources', 'fragmented systems', 'multi-department enterprise workflows', 'complex multi-department enterprise workflows', 'enterprise workflows'] },
  { phrase: 'LCNC governance', aliases: ['lcnc', 'low-code/no-code', 'low code no code'] },
  { phrase: 'enterprise application security', aliases: ['application security', 'appsec', 'enterprise application security'] },
  { phrase: 'governance framework advisory', aliases: ['governance framework', 'governance frameworks', 'security governance'] },
  { phrase: 'policy configuration guidance', aliases: ['configuring policies', 'policy configuration', 'platform risk areas'] },
  { phrase: 'security violation remediation', aliases: ['security violations', 'remediation guidance', 'troubleshoot security violations'] },
  { phrase: 'risk reduction analytics', aliases: ['risk reduction metrics', 'security improvements', 'data analysis'] },
  { phrase: 'product feedback loops', aliases: ['product roadmap', 'product feedback', 'influence roadmap', 'product and engineering'] },
  { phrase: 'single-point deployment coordination', aliases: ['single strategic point of coordination', 'single point of coordination'] },
  { phrase: 'OWASP/MITRE familiarity', aliases: ['owasp', 'mitre'] },
  { phrase: 'enterprise stakeholder advisory', aliases: ['stakeholder', 'executive', 'ciso', 'enterprise'] },
  { phrase: 'executive relationship management', aliases: ['executive relationship', 'executive-level relationship', 'executive sponsor', 'executive engagement'] },
  { phrase: 'strategic customer success leadership', aliases: ['strategic customer success', 'customer success strategy', 'strategic account management'] },
  { phrase: 'people management', aliases: ['manage and develop a team', 'managing and developing', 'people management', 'direct reports', 'manage a team', 'lead a team'] },
  { phrase: 'team coaching and development', aliases: ['lead, coach, and develop', 'coach team members', 'coaching', 'mentorship', 'developing high-performing teams'] },
  { phrase: 'playbook development', aliases: ['playbooks', 'playbook development', 'operating playbooks'] },
  { phrase: 'lifecycle program management', aliases: ['lifecycle programs', 'customer lifecycle', 'onboarding, adoption, retention, and expansion'] },
  { phrase: 'process optimization', aliases: ['process optimization', 'improve internal processes', 'operational consistency', 'operational excellence'] },
  { phrase: 'customer success metrics management', aliases: ['grr', 'nrr', 'portfolio performance', 'customer success metrics'] },
  { phrase: 'automation and one-to-many engagement', aliases: ['1-to-many', 'one-to-many', 'automation', 'ai-driven insights'] },
  { phrase: 'customer health strategy', aliases: ['customer health', 'health metrics', 'health scoring', 'health indicators'] },
  { phrase: 'value realization', aliases: ['value realization', 'business outcomes', 'measurable business impact'] },
  { phrase: 'customer engagement strategy', aliases: ['customer engagement', 'engagement strategies', 'member adoption'] },
  { phrase: 'customer planning and QBR governance', aliases: ['customer planning', 'qbr', 'quarterly business review', 'executive business review'] },
  { phrase: 'cross-functional influence', aliases: ['cross-functional', 'product', 'sales', 'marketing', 'operations'] },
  { phrase: 'scalable success operations', aliases: ['scalable operational processes', 'operating rhythms', 'best practices', 'segmentation strategy', 'team structure'] },
  { phrase: 'renewal and retention ownership', aliases: ['renewal', 'retention', 'churn', 'nrr'] },
  { phrase: 'adoption planning', aliases: ['adoption', 'time-to-value', 'customer onboarding'] },
  { phrase: 'customer health management', aliases: ['account health', 'health score', 'health scoring'] },
  { phrase: 'commercial CSM KPI ownership', aliases: ['book of business', 'expansion', 'retention', 'churn save', 'gross retention', 'net new revenue from existing accounts'] },
  { phrase: 'AE partnership and account planning', aliases: ['account executives', 'AEs', 'shared accounts', 'joint planning', 'renewal motions', 'renewal strategy', 'expansion strategy', 'account planning', 'intel sharing'] },
  { phrase: 'CRM opportunity hygiene', aliases: ['pipedrive', 'expansion opportunities', 'customer records', 'account context'] },
  { phrase: 'physical security and IoT adjacency', aliases: ['physical security', 'iot', 'hardware-software', 'industrial tech', 'ops leaders', 'security chiefs', 'facilities leaders'] },
  { phrase: 'startup CS playbook building', aliases: ['startup mentality', 'build rather than inherit', 'no fully established playbooks', 'playbook building', 'build a CS function', 'shape CS'] },
  { phrase: 'startup CS function building', aliases: ['startup enthusiast', 'build from the ground up', 'from the ground up', 'foundational member', 'high-growth startup', 'fast-growing SaaS'] },
  { phrase: 'process design and implementation', aliases: ['process design', 'process design & implementation', 'designing, building, and iterating', 'support processes', 'customer support processes', 'documenting and implementing', 'onboarding workflows'] },
  { phrase: 'AI-driven workflow efficiency', aliases: ['ai-driven efficiency', 'generative ai', 'chatgpt', 'claude', 'gemini', 'ai tools', 'support documentation', 'streamline customer communications'] },
  { phrase: 'onsite strategic customer engagement', aliases: ['onsite customer engagement', 'travel', 'in-person', 'strategic business reviews', 'security workshops', 'face-to-face partnership'] },
  { phrase: 'voice of customer product alignment', aliases: ['voice of the customer', 'user feedback', 'technical requirements', 'feature requests', 'product and engineering', 'product & engineering'] },
  { phrase: 'sales handoff and expansion partnership', aliases: ['sales synergy', 'post-sale handoffs', 'sales team', 'expansion opportunities', 'retention rates'] },
  { phrase: 'marketing advocacy and case studies', aliases: ['marketing advocacy', 'power users', 'brand advocates', 'case studies', 'testimonials'] },
  { phrase: 'threat hunting and behavioral detection', aliases: ['threat hunting', 'behavioral detection', 'behavior-based detections', 'behaviors, not just iocs', 'iocs'] },
  { phrase: 'endpoint identity cloud telemetry', aliases: ['endpoint telemetry', 'identity telemetry', 'cloud telemetry', 'endpoint, identity, and cloud telemetry'] },
  { phrase: 'credential misuse and lateral movement', aliases: ['credential misuse', 'lateral movement', 'post-access activity', 'insider threats'] },
];

export const DOMAIN_CATALOG = [
  { domain: 'Physical Security / IoT', aliases: ['physical security', 'iot', 'hardware-software', 'industrial tech', 'facilities', 'security chiefs', 'ops leaders'] },
  { domain: 'Threat Hunting / Behavioral Detection', aliases: ['threat hunting', 'behavioral detection', 'behavior-based detection', 'behavioral signals', 'credential misuse', 'lateral movement', 'post-access activity', 'ioc', 'iocs'] },
  { domain: 'NDR/NPM', aliases: ['ndr', 'npm', 'network detection', 'network performance', 'network visibility', 'east-west'] },
  { domain: 'SIEM/SOC', aliases: ['siem', 'ueba', 'soc', 'security operations', 'log ingestion', 'detection engineering'] },
  { domain: 'XDR/EDR', aliases: ['xdr', 'edr', 'endpoint', 'endpoint detection'] },
  { domain: 'IAM/Identity', aliases: ['iam', 'identity', 'authentication', 'authorization', 'oauth', 'oidc', 'machine identity', 'secrets'] },
  { domain: 'Cloud Security', aliases: ['cloud security', 'cnapp', 'cwpp', 'kubernetes', 'aws', 'azure', 'gcp', 'cloud workload'] },
  { domain: 'AppSec/API Security', aliases: ['appsec', 'application security', 'api security', 'devsecops', 'sast', 'dast'] },
  { domain: 'GRC/Risk', aliases: ['grc', 'compliance', 'risk posture', 'audit', 'governance'] },
  { domain: 'Managed Services/Compliance Delivery', aliases: ['managed services', 'msp', 'service delivery', 'cmmc', 'dib', 'compliance program', 'corrective action'] },
];

const POWER_NOUNS = [
  'threat hunting',
  'behavioral detection',
  'credential misuse',
  'lateral movement',
  'post-access activity',
  'endpoint telemetry',
  'identity telemetry',
  'cloud telemetry',
  'telemetry',
  'detection engineering',
  'risk posture',
  'renewal lifecycle',
  'account protection',
  'solution sizing',
  'BOM',
  'architecture',
  'integration',
  'workflow',
  'cloud management',
  'security operations',
  'log ingestion',
  'stakeholder alignment',
  'business case',
  'value realization',
  'time-to-value',
  'expansion',
  'retention',
  'service delivery',
  'execution coordination',
  'corrective action plan',
  'onboarding project management',
  'technology rollout',
  'environment build',
  'ticket queue',
  'backlog',
  'playbook',
  'book of business',
  'churn save',
  'account planning',
  'renewal motion',
  'Pipedrive',
  'physical security',
  'IoT',
  'facilities',
  'compliance program',
  'process design',
  'scalable onboarding workflow',
  'voice of customer',
  'customer advocacy',
  'strategic business review',
  'security workshop',
  'AI workflow automation',
];

const EXECUTION_VERBS = [
  'operationalized',
  'recovered',
  'stabilized',
  'accelerated',
  'negotiated',
  'aligned',
  'surfaced',
  'coordinated',
  'built',
  'reduced',
  'increased',
  'retained',
  'expanded',
  'designed',
  'prioritized',
  'coordinated',
  'orchestrated',
  'refined',
  'scaled',
  'escalated',
];

const STAKEHOLDER_CATALOG = [
  { stakeholder: 'CISO', aliases: ['ciso', 'security executive', 'security leadership'] },
  { stakeholder: 'SOC Director', aliases: ['soc director', 'soc lead', 'security operations'] },
  { stakeholder: 'VP of Sales', aliases: ['vp of sales', 'sales leadership', 'account executive', 'ae'] },
  { stakeholder: 'CFO', aliases: ['cfo', 'finance', 'procurement', 'commercial owner'] },
  { stakeholder: 'Security Engineering', aliases: ['security engineering', 'security engineer'] },
  { stakeholder: 'Compliance', aliases: ['compliance', 'audit', 'risk'] },
  { stakeholder: 'Service Delivery / Technical Operations', aliases: ['technicians', 'internal teams', 'service delivery', 'technical operations'] },
  { stakeholder: 'DevSecOps', aliases: ['devsecops', 'developer', 'platform engineering'] },
];

export const GENERIC_KEYWORD_REQUIREMENTS = new Set([
  'about',
  'alignment',
  'business',
  'company',
  'customer',
  'customers',
  'enterprise',
  'governance',
  'manager',
  'platform',
  'security',
  'strategic',
  'technical',
]);

export const GAP_QUESTION_PRIORITY = new Map([
  ['people management', 100],
  ['team coaching and development', 98],
  ['customer success metrics management', 94],
  ['playbook development', 92],
  ['lifecycle program management', 90],
  ['process optimization', 88],
  ['automation and one-to-many engagement', 86],
  ['AI governance', 100],
  ['LCNC governance', 95],
  ['OWASP/MITRE familiarity', 90],
  ['policy configuration guidance', 85],
  ['security violation remediation', 80],
  ['risk reduction analytics', 75],
  ['product feedback loops', 70],
  ['single-point deployment coordination', 65],
  ['governance framework advisory', 60],
]);

export const EVIDENCE_ALIASES = {
  'managed services delivery': ['managed services', 'service delivery', 'customer success', 'onboarding', 'delivery', 'support'],
  'named account portfolio management': ['portfolio', 'accounts', 'customers', 'arr', 'enterprise'],
  'commercial NRR and expansion ownership': ['nrr', 'net revenue retention', 'renewal', 'retention', 'expansion', 'upsell', 'cross-sell', 'arr'],
  'solution presentation and demonstration': ['demos', 'pocs', 'povs', 'ciso', 'executive', 'technical advisory'],
  'deployment health checks and risk action plans': ['health check', 'health scoring', 'deployment health', 'risk', 'at-risk', 'action plan'],
  'customer escalation management': ['escalation', 'escalation protocols', 'at-risk', 'recovery planning'],
  'CSM mentorship and ramp': ['mentorship', 'coach', 'team', 'best practices', 'direct reports', 'built'],
  'compliance program delivery': ['compliance', 'regulatory', 'audit', 'dlp', 'iam', 'proofpoint', 'mcafee', 'siem', 'soc'],
  'corrective action plan management': ['escalation', 'mitigation', 'at-risk', 'health score', 'recovery', 'playbook'],
  'technical project coordination': ['onboarding', 'implementation', 'rollout', 'integration', 'workflow', 'architecture'],
  'onboarding project management': ['onboarding', 'implementation', 'time-to-value', 'deployment', 'customer onboarding'],
  'escalation accountability': ['escalation', 'at-risk', 'recovered', 'mitigation', 'stakeholder', 'ciso'],
  'service instrumentation and dashboards': ['dashboard', 'health score', 'health scoring', 'kpi', 'account health', 'risk'],
  'team standards and accountability': ['direct reports', 'team', 'reports', 'manager', 'built', 'scaled'],
  'solution sizing': ['architecture', 'solution design', 'business case', 'technical business case', 'use case'],
  'BOM review': ['proposal', 'business case', 'technical validation'],
  'data center infrastructure': ['data center', 'network', 'ndr', 'npm', 'hybrid-cloud', 'cloud'],
  'cloud management': ['cloud', 'aws', 'azure', 'gcp', 'hybrid-cloud', 'kubernetes'],
  'security architecture': ['security architecture', 'security', 'cybersecurity', 'ndr', 'siem', 'iam', 'xdr'],
  'pre-sales technical campaigns': ['pre-sales', 'sales engineering', 'technical win', 'business case', 'discovery', 'demo'],
  'technical discovery': ['discovery', 'use case', 'requirements', 'technical validation'],
  'demos and proof of concept': ['demo', 'poc', 'proof of concept', 'technical validation'],
  'RFP/RFI response': ['rfp', 'rfi', 'proposal'],
  'SME positioning': ['sme', 'subject matter', 'advisor', 'advisory', 'ciso', 'executive'],
  'SIEM/log ingestion architecture': ['siem', 'log ingestion', 'securonix', 'ueba'],
  'vulnerability management integration': ['vulnerability', 'integration', 'workflow'],
  'AI governance': ['ai governance', 'ai standards', 'ai workflow automation'],
  'AI platform adoption': ['enterprise onboarding', 'platform adoption', 'adoption', 'automation', 'technical advisory'],
  'AI quality and response improvement': ['usage data', 'quality data', 'data analysis', 'product', 'engineering', 'feedback'],
  'consumption-based adoption': ['adoption', 'expansion', 'usage', 'nrr', 'renewal'],
  'enterprise workflow integration': ['integration', 'workflow', 'authentication', 'identity', 'onboarding', 'deployment'],
  'LCNC governance': ['lcnc', 'low-code/no-code', 'low code no code'],
  'enterprise application security': ['application security', 'appsec', 'api security'],
  'governance framework advisory': ['governance', 'compliance', 'audit', 'security maturity'],
  'policy configuration guidance': ['policy', 'configuration', 'platform configuration'],
  'security violation remediation': ['remediation', 'violation', 'troubleshoot'],
  'risk reduction analytics': ['risk reduction', 'data analysis', 'security improvements'],
  'product feedback loops': ['product', 'engineering', 'roadmap', 'customer advocate'],
  'single-point deployment coordination': ['cross-functional', 'coordination', 'product', 'engineering', 'sales'],
  'OWASP/MITRE familiarity': ['owasp', 'mitre'],
  'enterprise stakeholder advisory': ['enterprise', 'ciso', 'vp', 'executive', 'stakeholder'],
  'people management': ['direct reports', 'managed', 'manager', 'team', 'built', 'scaled'],
  'team coaching and development': ['coaching', 'coach', 'mentorship', 'people development'],
  'playbook development': ['playbook', 'playbooks', 'framework', 'operating model'],
  'lifecycle program management': ['lifecycle', 'onboarding', 'adoption', 'retention', 'expansion'],
  'process optimization': ['process', 'workflow', 'operating model', 'consistency', 'efficiency'],
  'customer success metrics management': ['grr', 'nrr', 'retention', 'portfolio', 'metrics'],
  'automation and one-to-many engagement': ['automation', 'one-to-many', '1-to-many', 'scaled engagement'],
  'renewal and retention ownership': ['renewal', 'retention', 'churn', 'nrr', 'grr'],
  'adoption planning': ['adoption', 'onboarding', 'time-to-value', 'customer success'],
  'customer health management': ['health score', 'account health', 'customer health'],
  'commercial CSM KPI ownership': ['expansion', 'retention', 'churn', 'churn save', 'grr', 'nrr', 'renewal', 'book of business'],
  'AE partnership and account planning': ['sales', 'account executive', 'ae', 'account planning', 'renewal strategy', 'expansion planning', 'joint account plan'],
  'CRM opportunity hygiene': ['pipedrive', 'salesforce', 'opportunity', 'account context', 'customer records', 'forecast'],
  'physical security and IoT adjacency': ['security operations', 'ops', 'facilities', 'iot', 'physical security', 'security chiefs', 'industrial'],
  'startup CS playbook building': ['cs function', 'from scratch', 'built', 'playbook', 'operating model', 'total trial services', 'director of customer success'],
  'startup CS function building': ['cs function', 'from scratch', 'built', 'startup', 'total trial services', 'director of customer success'],
  'process design and implementation': ['process', 'workflow', 'onboarding', 'playbook', 'satisfaction tracking', 'escalation handling'],
  'AI-driven workflow efficiency': ['ai workflow automation', 'automation', 'workflow automation', 'support documentation'],
  'onsite strategic customer engagement': ['qbr', 'executive engagement', 'workshop', 'customer review', 'onsite', 'travel'],
  'voice of customer product alignment': ['product', 'engineering', 'customer advocate', 'feedback', 'requirements'],
  'sales handoff and expansion partnership': ['sales', 'expansion', 'handoff', 'renewal', 'forecast'],
  'marketing advocacy and case studies': ['advocate', 'case study', 'testimonial', 'reference', 'power user'],
  'threat hunting and behavioral detection': ['threat hunting', 'behavioral detection', 'detection workflows', 'investigation workflows', 'ndr', 'siem', 'ueba'],
  'endpoint identity cloud telemetry': ['endpoint', 'identity', 'cloud', 'edr', 'iam', 'telemetry'],
  'credential misuse and lateral movement': ['credential', 'lateral movement', 'post-access', 'identity', 'investigation workflows'],
};

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9+/#.\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function termHits(text, terms) {
  return terms.filter(term => text.includes(term)).length;
}

function matchingCatalogLabels(text, catalog, key) {
  return catalog
    .map(item => ({ label: item[key], hits: termHits(text, item.aliases.map(normalizeText)) }))
    .filter(item => item.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.label.localeCompare(b.label))
    .map(item => item.label);
}

export function classifyResumeRole(jdText) {
  const text = String(jdText ?? '').toLowerCase();
  const scored = Object.fromEntries(ROLE_DEFINITIONS
    .map(role => ({ mode: role.mode, score: termHits(text, role.terms) }))
    .map(item => [item.mode, item.score]));
  const explicitPreSales = /\b(pre-sales|presales|client solutions engineer|solution architect|solutions architect|technical sales campaign|solution sizing|bom|rfp|rfi|proof of concept|poc)\b/i.test(text);
  const explicitTechnicalPostSale = /\b(technical customer success|customer success engineer|post-sale|post sale)\b/i.test(text);
  const explicitCommercialStartupCsBuilder = /\b(csm|customer success manager|customer success)\b/i.test(text)
    && /\b(book of business|expansion|retention|churn save|gross retention|account executive|aes?|shared accounts|account planning|renewal motions?|renewal strategy|pipedrive)\b/i.test(text)
    && /\b(startup|build rather than inherit|no fully established playbooks|playbook building|physical security|iot|hardware-software|industrial tech|facilities|security chiefs)\b/i.test(text);
  const explicitStartupCsBuilder = /\bcustomer success manager\b/i.test(text)
    && /\b(startup|high-growth|fast-paced|build from the ground up|from the ground up|foundational|process design|scalable onboarding workflows|ai-driven efficiency|generative ai|internal quarterback|voice of the customer)\b/i.test(text);
  const explicitAiCustomerExperience = /\b(customer experience manager|cxm|customer success manager|customer success)\b/i.test(text)
    && /\b(enterprise ai platform|conversational ai|ai agents?|ai copilots?|llms?|prompt tuning|training data|ai quality|quality response generation|autonomous support|customer service)\b/i.test(text);
  if (explicitTechnicalPostSale && !explicitPreSales) return 'cse';
  if (explicitPreSales || scored['pre-sales-solutions-architecture'] >= 2) return 'pre-sales-solutions-architecture';
  if (scored['msp-compliance-delivery'] > 1) return 'msp-compliance-delivery';
  if (explicitAiCustomerExperience || scored['ai-customer-experience'] >= 3) return 'ai-customer-experience';
  if (explicitCommercialStartupCsBuilder || scored['startup-commercial-cs-builder'] >= 3) return 'startup-commercial-cs-builder';
  if (explicitStartupCsBuilder || scored['startup-cs-builder'] >= 2) return 'startup-cs-builder';
  if (scored['strategic-cs-leadership'] > 1) return 'strategic-cs-leadership';
  if (scored.tam > 0) return 'tam';
  if (scored.cse > 0) return 'cse';
  if (scored.leadership > 0) return 'leadership';
  if (scored['customer-success'] > 0) return 'customer-success';
  return 'customer-success';
}

export function inferResumePositioningMode(jdText) {
  const mode = classifyResumeRole(jdText);
  return mode === 'pre-sales-solutions-architecture'
    ? 'pre-sales-solutions-architecture'
    : 'customer-success-technical-advisory';
}

export function extractJobRequirements(jdText, keywords = '') {
  const text = normalizeText(`${jdText}\n${keywords}`);
  const found = [];
  for (const item of REQUIREMENT_CATALOG) {
    const hitCount = termHits(text, item.aliases.map(normalizeText));
    if (!hitCount) continue;
    found.push({
      requirement: item.phrase,
      source: 'jd',
      priority: hitCount,
    });
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

export function extractJdSignals(jdText, keywords = '') {
  const text = normalizeText(`${jdText}\n${keywords}`);
  const domains = matchingCatalogLabels(text, DOMAIN_CATALOG, 'domain');
  const powerNouns = POWER_NOUNS
    .filter(noun => text.includes(normalizeText(noun)))
    .slice(0, 12);
  const executionVerbs = EXECUTION_VERBS
    .filter(verb => text.includes(normalizeText(verb)) || text.includes(normalizeText(verb.replace(/ed$/, ''))))
    .slice(0, 10);
  const hiddenStakeholders = matchingCatalogLabels(text, STAKEHOLDER_CATALOG, 'stakeholder');
  const unstatedPriorities = [];
  if (/\bcommercial owner|book of business|renewal|retention|nrr|arr|expansion\b/i.test(jdText)) {
    unstatedPriorities.push('Think like a commercial operator, not a support contact.');
  }
  if (/\bcustomer success\b/i.test(jdText) && /\b(nrr|net revenue retention|quota|commission|upsell|cross-sell|cross sell|renewal|arr|annual recurring revenue|expansion)\b/i.test(jdText)) {
    unstatedPriorities.push('For commercial CSM roles, make NRR, renewal, expansion, upsell/cross-sell, and ARR ownership visible above the fold and in at least one proof point.');
  }
  if (/\bcustomer success\b/i.test(jdText) && /\b(present|discuss|demonstrate|demo|ciso|executive leadership|business reviews?|health checks?|account health|assess risk|escalations?)\b/i.test(jdText)) {
    unstatedPriorities.push('Show the operating cadence: executive reviews, solution demonstrations, deployment health checks, risk action plans, and escalation closure.');
  }
  if (/\barchitecture|integration|technical|api|cloud|data center|security operations|soc|siem|ndr|iam\b/i.test(jdText)) {
    unstatedPriorities.push('Lead with technical depth, architecture judgment, and integration fluency.');
  }
  if (/\bdirector|head of|vp|scale|build|operating model|team\b/i.test(jdText)) {
    unstatedPriorities.push('Show operating model, team rhythm, and scalable systems, not only account execution.');
  }
  if (/\bmanaged services|msp|service delivery|compliance|cmmc|corrective action|onboarding project|technology rollout|environment build|ticket queue|backlog|playbook|execution coordination\b/i.test(jdText)) {
    unstatedPriorities.push('Prioritize delivery execution, onboarding coordination, corrective action discipline, escalation accountability, and service operating cadence over pure SaaS expansion framing.');
  }
  if (/\b(startup|high-growth|build from the ground up|from the ground up|foundational|process design|scalable onboarding|ai-driven|generative ai|internal quarterback|voice of the customer)\b/i.test(jdText)) {
    unstatedPriorities.push('Show first-CS-hire builder energy: process design, cross-functional ownership, AI-enabled operating leverage, and evidence that Brian has built CS systems from scratch.');
  }
  if (/\b(enterprise ai platform|conversational ai|ai agents?|ai copilots?|llms?|prompt tuning|training data|ai quality|quality response generation|autonomous support|customer service)\b/i.test(jdText)) {
    unstatedPriorities.push('For AI-native CX roles, show credible transfer: enterprise onboarding, adoption/consumption, workflow integration, quality-data loops, Product/Engineering feedback, and Fortune 100/500 stakeholder proof without claiming direct LLM or prompt-tuning experience unless sourced.');
  }
  if (/\b(book of business|expansion|retention|churn save|account planning|renewal motions?|Pipedrive|build rather than inherit|no fully established playbooks|physical security|IoT)\b/i.test(jdText)) {
    unstatedPriorities.push('Frame Brian as a commercial CSM operator who can own expansion, retention, churn-save, AE partnership, CRM discipline, and CS playbook building without claiming direct physical-security or IoT background.');
  }

  return {
    primaryDomain: domains[0] || 'Cybersecurity SaaS',
    domains: domains.slice(0, 4),
    powerNouns,
    executionVerbs,
    hiddenStakeholders: hiddenStakeholders.length ? hiddenStakeholders : ['CISO', 'SOC Director', 'VP/Executive stakeholders'],
    unstatedPriorities,
  };
}

export function buildEvidenceMap(requirements, bragDoc) {
  const brag = normalizeText(bragDoc);
  return requirements.map(item => {
    const requirement = item.requirement;
    const aliases = EVIDENCE_ALIASES[requirement] || normalizeText(requirement).split(/\s+/).filter(word => word.length >= 5);
    const hits = aliases.filter(alias => brag.includes(normalizeText(alias)));
    const status = hits.length >= 2 ? 'supported' : hits.length === 1 ? 'partial' : 'gap';
    return {
      requirement,
      status,
      evidenceTerms: hits.slice(0, 5),
    };
  });
}

function extractRoleEvidenceSections(bragDoc) {
  const sections = [];
  const matches = [...String(bragDoc ?? '').matchAll(/^###\s+(.+)$/gm)];
  for (let idx = 0; idx < matches.length; idx += 1) {
    const current = matches[idx];
    const next = matches[idx + 1];
    const title = current[1].trim();
    const body = String(bragDoc ?? '').slice(
      current.index + current[0].length,
      next?.index ?? String(bragDoc ?? '').length
    );
    sections.push({ title, body });
  }
  return sections;
}

function requirementNeedsQuantifiedOutcome(requirement) {
  return /\brenewal|retention|value realization|customer health|adoption|expansion|risk\b/i.test(requirement);
}

function hasQuantifiedOutcomeForRequirement(text, requirement) {
  const normalized = normalizeText(text);
  const requirementWords = normalizeText(requirement).split(/\s+/).filter(word => word.length >= 4);
  const mentionsRequirement = requirementWords.some(word => normalized.includes(word));
  const hasQuant = /(\$[\d,.]+[MBK]?|\d+%|\b\d+\s*(accounts?|customers?|clients?|opportunities|renewals|years?|ARR|NPS|CSAT)\b)/i.test(text);
  return mentionsRequirement && hasQuant;
}

/**
 * Gap keys already answered through the gap-review flow. Answers are saved
 * to the brag doc's "Recovered Evidence" section as "- <gap>: <answer>"
 * (applyGapAnswersToBragDoc), so those gaps are never asked again.
 */
function answeredGapKeys(bragDoc = '') {
  const text = String(bragDoc ?? '');
  const start = text.indexOf('## Recovered Evidence');
  if (start < 0) return new Set();
  const section = text.slice(start).split(/\n---\n|\n## (?!Recovered Evidence)/)[0];
  const keys = new Set();
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*-\s+(.+?):\s+\S/);
    if (m) keys.add(m[1].trim().toLowerCase());
  }
  return keys;
}

export function buildGapQuestionCandidates({ requirements = [], evidenceMap = [], bragDoc = '' } = {}) {
  const questions = [];
  for (const item of evidenceMap) {
    const req = requirements.find(requirement => requirement.requirement === item.requirement);
    if (req?.source !== 'jd' || item.status === 'supported') continue;
    questions.push({
      gap: item.requirement,
      kind: item.status === 'partial' ? 'partial-evidence' : 'missing-evidence',
      priority: GAP_QUESTION_PRIORITY.get(item.requirement) ?? (item.status === 'gap' ? 50 : 40),
      question: `Have you done work involving ${item.requirement}? If yes, which company, what did you do, and what result or scope can we state truthfully?`,
    });
  }

  const sections = extractRoleEvidenceSections(bragDoc).slice(0, 4);
  for (const requirement of requirements.filter(item => item.source === 'jd').slice(0, 8)) {
    if (!requirementNeedsQuantifiedOutcome(requirement.requirement)) continue;
    for (const section of sections) {
      const lower = normalizeText(section.body);
      const words = normalizeText(requirement.requirement).split(/\s+/).filter(word => word.length >= 4);
      if (!words.some(word => lower.includes(word))) continue;
      if (hasQuantifiedOutcomeForRequirement(section.body, requirement.requirement)) continue;
      questions.push({
        gap: `${section.title}: ${requirement.requirement}`,
        kind: 'weak-proof',
        priority: 35,
        question: `For ${section.title}, do you have a truthful quantified outcome tied to ${requirement.requirement} — for example retention, renewal, expansion, adoption, risk reduction, time saved, or portfolio scope?`,
      });
      break;
    }
  }

  const seen = answeredGapKeys(bragDoc);
  return questions
    .filter(item => {
      const key = item.gap.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.priority - a.priority || a.gap.localeCompare(b.gap))
    .slice(0, 5);
}

function evidenceStatus(evidenceMap, requirement) {
  return evidenceMap.find(item => item.requirement === requirement)?.status || 'gap';
}

export function buildResumeSectionPlan({ roleMode, requirements = [], evidenceMap = [] } = {}) {
  const topRequirements = requirements.slice(0, 8).map(item => item.requirement);
  const shared = {
    operatorThesis: 'Frame Brian as an operator who builds systems, aligns stakeholders, drives execution, closes gaps, and owns commercial outcomes.',
    improvementChecklist: RESUME_IMPROVEMENT_PRINCIPLES,
    topApplicantChecklist: TOP_APPLICANT_RESUME_PRINCIPLES,
    differentiationStandard: 'Each bullet should show a specific problem solved, the method or decision Brian used, and the measurable business result.',
    bulletConstruction: 'Every bullet should include at least two of: measurable impact, scope, method/system, stakeholder, and business outcome.',
    scanTest: 'Top half of page one must show seniority, ARR or portfolio scale, the role-relevant outcome signal, and domain credibility matched to the JD.',
    transferabilityStandard: 'Target role first, source background second. Translate prior experience into the JD function, buyer, outcomes, and operating model before surfacing domain detail.',
    competencyStandard: 'Use competencies that earn their place for the target JD. Remove empty categories, orphaned tags, duplicate lines, and source-domain inventories that do not improve fit.',
  };
  if (roleMode === 'pre-sales-solutions-architecture') {
    return {
      ...shared,
      roleMode,
      taglineDirective: 'Use a JD-mirrored pre-sales or client-solutions title, not a Customer Success title.',
      summaryThesis: 'Enterprise technical advisor and pre-sales solution architect who owns technical sales campaigns, architecture guidance, SME positioning, and solution fit.',
      toolsPlatformsDirective: 'Use one CORE_COMPETENCIES section with labeled groups: Security Platforms, Cloud & Infrastructure, GTM/CS Platforms, Security Domains. Do not duplicate the section elsewhere.',
      certificationDirective: 'Lead CERTIFICATIONS_LINE with Certified Ethical Hacker (CEH) for technical cybersecurity, endpoint, application control, Zero Trust, and sales engineering roles.',
      achievementFocus: topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
      emphasizeBullets: [
        'ExtraHop: architecture design decisions, discovery, demos, technical business cases, and solution design changes.',
        'Securonix: SIEM/log ingestion architecture, vulnerability-management integration, onboarding architecture, competitive displacement, and workflow design.',
      ],
      downrankVocabulary: ['renewal', 'retention', 'NRR', 'churn', 'account health', 'post-sale account management'],
    };
  }
  if (roleMode === 'tam' || roleMode === 'cse') {
    return {
      ...shared,
      roleMode,
      taglineDirective: 'Use technical advisory, customer engineering, and enterprise account language aligned to the JD.',
      summaryThesis: 'Technical customer advisor connecting architecture, onboarding, adoption, executive stakeholders, and measurable customer outcomes.',
      toolsPlatformsDirective: 'Show named security, cloud, identity, SIEM, NDR, and GTM platforms when supported.',
      certificationDirective: 'Order certifications by JD relevance, leading with CEH for cybersecurity-heavy technical roles.',
      achievementFocus: topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
      emphasizeBullets: ['Technical onboarding, integration design, use-case adoption, executive advisory, and measurable risk or retention outcomes.'],
      downrankVocabulary: [],
    };
  }
  if (roleMode === 'msp-compliance-delivery') {
    return {
      ...shared,
      roleMode,
      taglineDirective: 'Use managed services, cybersecurity delivery, execution leadership, compliance-aligned program delivery, or service delivery leadership language. Do not lead with retention and expansion ownership.',
      summaryThesis: 'Customer-facing cybersecurity delivery leader operating as the general manager of onboarding execution, corrective action coordination, escalation accountability, and cross-functional service delivery.',
      toolsPlatformsDirective: 'Use CORE_COMPETENCIES as a clean competency list: MSP service delivery, onboarding project management, corrective action plans, compliance-aligned engagement, technical project coordination, escalation protocols, dashboards, team accountability, and security domains. Avoid a duplicate platform inventory unless the JD is platform-specific.',
      certificationDirective: 'Lead CERTIFICATIONS_LINE with CEH for cybersecurity/compliance delivery roles, then list CCSM, API Security, AWS, and TSIA credentials as space allows.',
      achievementFocus: topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
      emphasizeBullets: [
        'Securonix: lifecycle model build, onboarding reduction, escalation protocols, compliance-aligned SOC workflows, and team/account operating cadence.',
        'Total Trial Services: CS function build, team standards, onboarding ownership, escalation frameworks, and retention outcomes.',
        'ExtraHop: onboarding/time-to-value, delivery roadmap, executive and technical alignment, adoption gap resolution, and complex re-engagement execution.',
        'McAfee and Proofpoint: compliance-adjacent DLP, IAM, email security, policy-enforcement, regulated-industry, and audit-readiness workflows where supported.',
      ],
      downrankVocabulary: ['Retention & Expansion Ownership', 'NRR as headline metric', 'pure QBR pipeline', 'sales-assist motion', 'commercial owner language'],
    };
  }
  if (roleMode === 'ai-customer-experience') {
    return {
      ...shared,
      roleMode,
      operatorThesis: 'Frame Brian as an enterprise AI-platform adoption and customer-experience operator by translating security SaaS, IAM, telemetry, onboarding, and Product/Engineering feedback proof into Maven-style customer outcomes.',
      taglineDirective: 'Use Customer Experience Manager, Strategic Enterprise AI Platform Adoption, consumption-based expansion, and quality-data feedback-loop language. Do not lead with cybersecurity or claim direct LLM, prompt tuning, training data, or conversational-AI delivery experience unless source-supported.',
      summaryThesis: 'Strategic CXM who can onboard complex enterprise workflows, drive adoption and contracted-volume consumption, present quality and usage data, and translate customer needs into Product and Engineering outcomes for AI-native customer-service platforms.',
      toolsPlatformsDirective: 'Use CORE_COMPETENCIES as a targeted AI CX list: Strategic Relationship Management, Enterprise AI Platform Adoption, Complex Onboarding & Implementation, Consumption-Based Expansion, Quality / Usage Data Reviews, Product & Engineering Feedback Loops, Multi-Department Workflow Integration, Fortune 100/500 Stakeholder Management, Human-Centric AI Adoption, and Enterprise SaaS Value Realization.',
      certificationDirective: 'Keep certifications compact; do not let cybersecurity credentials crowd out AI-platform adoption, onboarding, adoption/consumption, and customer-experience proof.',
      achievementFocus: [
        ...topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
        'McAfee largest cloud security onboarding: Fortune 500, highest portfolio NPS',
        'Securonix quality/usage-data loop: platform usage analysis, Product/Engineering feedback, 30% onboarding reduction',
        'Auth0 integration complexity: enterprise IAM workflows, production deployment, Product/Engineering escalation',
      ],
      emphasizeBullets: [
        'McAfee: elevate the largest cloud security onboarding, Fortune 500 complexity, multi-program rollout, and highest portfolio NPS as the strongest implementation analog.',
        'Securonix: lead with usage-data analysis, onboarding reduction, Product/Engineering feedback loops, recovery milestones, and multi-year platform expansion.',
        'Auth0/Okta: translate IAM authentication integration, deployment phases, engineering stakeholders, and production scale into enterprise workflow-integration proof.',
        'ExtraHop: use telemetry-driven adoption, CISO business cases, time-to-value, renewal/expansion, and executive QBRs. Do not use direct AI workflow automation claims.',
        'Proofpoint: use email-security adoption, threat-protection reviews, and behavioral-analysis adjacency only as a compact bridge, not as direct AI/LLM experience.',
      ],
      downrankVocabulary: ['cybersecurity as headline', 'NDR/SIEM acronym inventory', 'threat hunting as headline', 'direct LLM experience', 'prompt tuning ownership', 'training data ownership', 'customer-deployed AI workflow automation'],
    };
  }
  if (roleMode === 'startup-cs-builder') {
    return {
      ...shared,
      roleMode,
      operatorThesis: 'Frame Brian as a startup CS builder who can own ambiguous customer problems, design repeatable workflows, and connect cybersecurity users to Product, Engineering, Sales, and Marketing without needing a mature CS machine around him.',
      taglineDirective: 'Use Customer Success Manager language aligned to the JD, but add cybersecurity startup CS builder, process design, threat hunting, behavioral detection, and AI workflow automation signals. Do not lead with Director or people-manager positioning.',
      summaryThesis: 'Hands-on cybersecurity CSM and CS builder who has operated across NDR, SIEM, IAM, endpoint, identity, and cloud security while building onboarding, support, escalation, and customer-engagement systems from scratch.',
      toolsPlatformsDirective: 'Use CORE_COMPETENCIES as a targeted builder list: Process Design & Implementation, Scalable Onboarding Workflows, AI-Assisted Documentation, Strategic Business Reviews, Voice of Customer, Product & Engineering Feedback Loops, Sales Handoffs, Marketing Advocacy, Threat Hunting, Behavioral Detection, Endpoint / Identity / Cloud Telemetry, Credential Misuse, Lateral Movement, and Post-Access Activity.',
      certificationDirective: 'Order certifications by cybersecurity relevance while keeping the line compact; CEH can lead when threat hunting, endpoint, identity, or behavioral detection is central.',
      achievementFocus: [
        ...topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
        'Total Trial Services CS function build: 87 clients, 8 direct reports, 22% retention improvement',
      ],
      emphasizeBullets: [
        'Total Trial Services: first CS function build, onboarding consistency across 87 clients, satisfaction tracking, escalation handling, 8-person team, and 22% retention improvement.',
        'ExtraHop: NDR threat visibility, behavioral detection/use-case mapping, investigation workflows, AI workflow automation, onboarding/time-to-value, and CISO stakeholder alignment.',
        'Securonix: SIEM/UEBA onboarding reduction, lifecycle model building, escalation protocols, investigation workflows, competitive displacement, and Product/Engineering feedback loops.',
        'McAfee/Auth0/Proofpoint: cross-functional escalation ownership, regulated enterprise security context, identity/cloud/endpoint telemetry, and customer advocacy where relevant.',
      ],
      downrankVocabulary: ['Director-level people management as headline', 'generic strategic accounts', 'pure NRR/ARR framing', 'relationship manager language'],
    };
  }
  if (roleMode === 'startup-commercial-cs-builder') {
    return {
      ...shared,
      roleMode,
      operatorThesis: 'Frame Brian as a commercial CSM operator and startup CS builder who can own expansion, retention, churn-save, account planning, and playbook creation across a fast-moving book of business.',
      taglineDirective: 'Use Customer Success Manager language aligned to the JD, with commercial ownership, startup builder, AE partnership, and physical-security / IoT adjacency. Do not lead with cybersecurity tooling or claim direct physical-security experience.',
      summaryThesis: 'Commercial customer success operator who builds CS functions and playbooks from scratch, owns renewal and expansion outcomes, partners tightly with AEs, and translates technical/security customer needs into follow-through across Product, Engineering, and Sales.',
      toolsPlatformsDirective: 'Use CORE_COMPETENCIES as a commercial startup CSM list: Expansion & Retention Ownership, Churn Save, Book of Business Management, AE Partnership, Account Planning, Renewal Motions, Pipedrive / CRM Hygiene, QBRs, Proactive Outreach, Playbook Building, Voice of Customer, Product Feedback, Startup Operating Cadence, Physical Security / IoT Adjacency, Security Chiefs / IT / Ops Stakeholders.',
      certificationDirective: 'Keep certifications compact; do not let cybersecurity credentials crowd out expansion, retention, account-planning, and startup-builder proof.',
      achievementFocus: [
        ...topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
        'Total Trial Services CS function build: 87 clients, 8 direct reports, 22% retention improvement',
        'Securonix churn-save and onboarding proof: 100% renewal, 3 at-risk accounts retained, 30% onboarding reduction, 81% ARR expansion',
      ],
      emphasizeBullets: [
        'Total Trial Services: lead the startup-builder story with CS function build, 87 clients, 8 direct reports, onboarding consistency, satisfaction tracking, escalation handling, and 22% retention improvement.',
        'Securonix: show churn-save and process proof through 100% renewal, three at-risk accounts retained, onboarding reduction, lifecycle model building, and 81% ARR expansion.',
        'ExtraHop: show commercial CSM ownership through $23M portfolio scale, GRR/NRR, QBRs, renewal strategy, AE partnership, expansion planning, CRM discipline, and executive stakeholder alignment.',
        'Auth0/Proofpoint/McAfee: use only compact transferable proof around playbooks, adoption, cross-functional escalations, regulated stakeholders, and customer outcomes.',
      ],
      downrankVocabulary: ['threat hunting as headline', 'behavioral detection as headline', 'endpoint / identity / cloud telemetry lists', 'direct physical security experience claims', 'support rep framing', 'generic strategic account owner'],
    };
  }
  if (roleMode === 'leadership') {
    return {
      ...shared,
      roleMode,
      taglineDirective: 'Use director/senior leader positioning only when the JD title asks for it.',
      summaryThesis: 'Customer-facing technical leader with enterprise security domain depth, team operating cadence, stakeholder influence, and measurable business outcomes.',
      toolsPlatformsDirective: 'Balance leadership scope with named platforms and security domains.',
      certificationDirective: 'Order certifications by JD relevance, leading with CEH when cybersecurity technical credibility matters.',
      achievementFocus: topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
      emphasizeBullets: ['Team leadership, operating model, executive stakeholder management, retention, expansion, and technical credibility.'],
      downrankVocabulary: [],
    };
  }
  if (roleMode === 'strategic-cs-leadership') {
    return {
      ...shared,
      roleMode,
      taglineDirective: 'Use strategic customer success leadership language focused on enterprise SaaS, retention, adoption, executive engagement, and customer outcomes. Do not lead with cybersecurity specialization unless the JD is security-specific.',
      summaryThesis: 'Enterprise customer outcomes leader who builds scalable CS operating models, develops teams, strengthens executive relationships, and turns adoption and health signals into measurable business outcomes.',
      toolsPlatformsDirective: 'Use a clean customer-success competency list centered on executive stakeholder management, customer health, adoption, value realization, QBR/EBR leadership, lifecycle management, team leadership, cross-functional alignment, and CS platforms. Downrank vendor/security inventories unless the JD requires them.',
      certificationDirective: 'Order certifications by relevance, but keep the line compact when credentials are not central to the target role.',
      achievementFocus: topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
      emphasizeBullets: [
        'Team leadership, coaching, operating model creation, lifecycle frameworks, health scoring, QBR governance, customer planning, and cross-functional influence.',
        'Use healthcare, benefits, regulated-industry, or people-focused customer context only when source-supported and relevant to the JD.',
        'Frame technical history through customer outcomes, adoption, retention, executive alignment, and operational scale rather than platform architecture.',
      ],
      downrankVocabulary: ['NDR', 'SIEM', 'UEBA', 'EDR', 'IAM', 'SOC', 'threat detection', 'platform architecture', 'security platform lifecycle'],
    };
  }
  return {
    ...shared,
    roleMode: 'customer-success',
    taglineDirective: 'Use customer success, technical account leadership, or post-sale advisory language matched to the JD.',
    summaryThesis: 'Enterprise customer success and technical advisory leader focused on named-account portfolio ownership, NRR, renewals, expansion, adoption, risk management, executive reviews, demonstrations, stakeholder alignment, and measurable customer outcomes when those requirements appear in the JD.',
    toolsPlatformsDirective: 'Include named platforms and domains where supported, but keep CS outcomes central. For commercial CSM JDs, include NRR / GRR ownership, renewal execution, upsell / cross-sell discovery, executive business reviews, account health, risk action plans, escalations, and mentorship when requested.',
    certificationDirective: 'Order certifications by JD relevance while preserving only source-truth credentials.',
    achievementFocus: topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
    emphasizeBullets: [
      'Renewal recovery, NRR, upsell/cross-sell identification, adoption planning, executive stakeholder alignment, value realization, account health, and technical advisory.',
      'When the JD asks for presentations or demos, tie at least one recent-role bullet to CISO/executive business reviews, solution demonstrations, technical value narratives, or health checks.',
      'When the JD asks for mentorship, include one concise proof point around coaching, best-practice sharing, ramping team members, playbook development, or team operating standards if source-supported.',
    ],
    downrankVocabulary: [],
  };
}

export function buildResumePlanningContext(jdText, keywords, bragDoc) {
  const roleMode = classifyResumeRole(jdText);
  const jdSignals = extractJdSignals(jdText, keywords);
  const requirements = extractJobRequirements(jdText, keywords);
  const evidenceMap = buildEvidenceMap(requirements, bragDoc);
  const sectionPlan = buildResumeSectionPlan({ roleMode, requirements, evidenceMap });
  return { roleMode, jdSignals, requirements, evidenceMap, sectionPlan, jdText };
}

export function planningContextText(context) {
  if (!context) return '';
  return [
    'REQUIREMENT_EVIDENCE_MAP:',
    JSON.stringify(context.evidenceMap, null, 2),
    '',
    'JD_SIGNAL_ANALYSIS:',
    JSON.stringify(context.jdSignals || {}, null, 2),
    '',
    'SECTION_PLAN:',
    JSON.stringify(context.sectionPlan, null, 2),
  ].join('\n');
}

function resumePositioningInstructions(mode) {
  const shared = [
    'RESUME IMPROVEMENT CHECKLIST:',
    ...RESUME_IMPROVEMENT_PRINCIPLES.map((principle, index) => `${index + 1}. ${principle}`),
    'TOP-1% APPLICANT CHECKLIST:',
    ...TOP_APPLICANT_RESUME_PRINCIPLES.map((principle, index) => `${index + 1}. ${principle}`),
    'MANDATORY WRITING FRAME: Brian is an operator, not a relationship manager. Lead with systems built, decisions made, execution gaps closed, stakeholders aligned, and commercial outcomes owned.',
    'Every bullet must earn its place by showing at least two of: measurable impact, scope, method/system, stakeholder, and business outcome.',
    'Target role first, source background second. Translate Brian\'s experience into the JD\'s function, outcomes, stakeholders, and operating model before adding source-domain detail.',
    'Use source-domain jargon only when the JD values it. If the target JD is not security-specific, prefer transferable business language such as adoption, customer outcomes, execution, operating cadence, executive alignment, and measurable value.',
    'Use exact held titles only. Never inflate job titles to match the JD.',
    'Avoid support-first phrasing such as "served as point of contact", "provided support", "managed relationships", or "responsible for".',
    'Run the 7-second scan mentally before returning JSON: seniority, ARR/portfolio scale, a role-relevant outcome signal, and domain credibility matched to the JD must appear early.',
    'Make the finished resume a full 2 pages only: dense and complete, never sparse, never a third page.',
  ].join('\n');
  if (mode === 'pre-sales-solutions-architecture') {
    return [
      shared,
      'POSITIONING MODE: pre-sales solutions architecture.',
      'Open as an enterprise technical advisor, pre-sales solution architect, client solutions engineer, or sales engineer based on the JD title.',
      'Make TITLE_LINE role-specific, not CS-generic. Prefer language such as Senior Client Solutions Engineer, Pre-Sales Technical Advisory, Enterprise Cloud & Security Architecture when aligned to the JD.',
      'Use CORE_COMPETENCIES as the single skills/platform section with labeled groups where useful: Security Platforms, Cloud & Infrastructure, GTM/CS Platforms, Security Domains. Do not duplicate it as Tools & Platforms.',
      'Use METRICS_LINE to show strongest truthful enterprise scale, usually $55M ARR Portfolio (peak) for cybersecurity Sales Engineer roles.',
      'Use CERTIFICATIONS_LINE and lead with Certified Ethical Hacker (CEH) for technical cybersecurity, endpoint, application control, Zero Trust, and security architecture roles.',
      'For ExtraHop, lead with architecture design decisions, technical business cases, solution design changes, discovery, demos, and stakeholder advisory. Avoid pure renewal/adoption bullets.',
      'For Securonix, lead with SIEM/log ingestion architecture, vulnerability-management integration, onboarding architecture, competitive displacement, and security workflow design.',
      'Downrank renewals, retention, NRR, churn prevention, account health, and post-sale account management unless the JD explicitly asks for them.',
    ].join('\n');
  }
  if (mode === 'msp-compliance-delivery') {
    return [
      shared,
      'POSITIONING MODE: MSP / compliance service delivery leadership.',
      'Open as a cybersecurity delivery, managed services, compliance-aligned program delivery, or execution leadership candidate based on the JD title.',
      'Make TITLE_LINE signal delivery accountability and team execution. Avoid leading with Retention & Expansion Ownership or NRR.',
      'Use METRICS_LINE for scale, team leadership, portfolio ownership, CS function building, onboarding reduction, retention, or direct reports ahead of SaaS expansion metrics.',
      'Use CORE_COMPETENCIES as a clean competency list, not a duplicate Tools & Platforms inventory, unless the JD is platform-specific.',
      'Prioritize onboarding project management, corrective action plans, technical project coordination, technology rollouts, environment builds, dashboards, ticket/backlog visibility, escalation protocols, and team accountability.',
      'For Securonix and Total Trial Services, lead with lifecycle model building, onboarding reduction, escalation protocols, operating model, team accountability, and delivery infrastructure.',
      'For ExtraHop, lead with onboarding/time-to-value, delivery roadmap, technical/executive alignment, adoption gap resolution, and complex re-engagement execution before ARR expansion.',
      'For McAfee and Proofpoint, add compliance-adjacent framing only where supported: DLP, IAM, email security, policy enforcement, regulated industries, audit-readiness, SOC, SIEM, or risk workflows. Do not claim direct CMMC ownership unless the source material says so.',
      'Downrank pure QBR pipeline, expansion-assist, NRR, ARR growth, and commercial-owner language unless the JD makes upsell or renewal ownership dominant.',
    ].join('\n');
  }
  if (mode === 'ai-customer-experience') {
    return [
      shared,
      'POSITIONING MODE: AI-native customer experience manager.',
      'Open as a Strategic Customer Experience Manager or enterprise AI platform adoption operator aligned to the JD title.',
      'Make TITLE_LINE signal Strategic CXM, enterprise AI platform adoption, consumption-based expansion, and quality-data feedback loops.',
      'Make PROFESSIONAL_SUMMARY translate Brian\'s supported experience into Maven\'s operating model: complex onboarding, adoption/consumption, multi-department workflows, quality/usage data, Product/Engineering loops, and Fortune 100/500 executive stakeholders.',
      'Do not claim direct LLM, prompt tuning, training-data, conversational-AI implementation, AI-agent deployment, or customer-deployed AI workflow automation unless the source truth provides concrete proof.',
      'Use CORE_COMPETENCIES as an AI CX competency list, not a cybersecurity platform inventory: Strategic Relationship Management, Enterprise AI Platform Adoption, Onboarding & Implementation, Consumption-Based Expansion, Quality / Usage Data Reviews, Product & Engineering Feedback Loops, Multi-Department Workflow Integration, Fortune 100/500 Stakeholder Management, Human-Centric AI Adoption, and Enterprise SaaS Value Realization.',
      'Elevate McAfee\'s largest cloud-security onboarding and highest portfolio NPS because it is the closest enterprise implementation analog.',
      'Use Securonix for data-informed platform quality/adoption loops and Product/Engineering feedback; use Auth0 for integration complexity and production workflow deployment; use ExtraHop for telemetry-driven business cases and executive adoption.',
      'Downrank NDR/SIEM acronym lists, threat hunting, source-domain cybersecurity framing, and pure renewal/NRR language unless translated into Maven-style customer outcomes.',
    ].join('\n');
  }
  if (mode === 'startup-cs-builder') {
    return [
      shared,
      'POSITIONING MODE: startup CSM builder.',
      'Open as a hands-on Customer Success Manager for a cybersecurity startup, not as a Director, generic strategic-account owner, or TAM.',
      'Make TITLE_LINE signal startup CS builder, process design, AI-assisted workflow scale, and threat-hunting / behavioral-detection domain fluency.',
      'Make PROFESSIONAL_SUMMARY connect ExtraHop and Securonix security credibility to Total Trial Services CS-function-building proof. The Total Trial Services builder story is a differentiator, not a footnote.',
      'Use METRICS_LINE to balance cybersecurity scale with builder proof: $55M ARR Portfolio (Peak), $23M NDR Portfolio, 98-100% Retention, 87-Client CS Function Build, 22% Retention Lift, or 30% Onboarding Reduction as space allows.',
      'Use CORE_COMPETENCIES as a builder-focused list: Process Design & Implementation, Scalable Onboarding Workflows, AI-Assisted Documentation, Strategic Business Reviews, Voice of Customer, Product & Engineering Feedback Loops, Sales Handoffs, Marketing Advocacy, Threat Hunting, Behavioral Detection, Endpoint / Identity / Cloud Telemetry, Credential Misuse, Lateral Movement, and Post-Access Activity.',
      'Put one Total Trial Services achievement or bullet into the final resume when fields allow: 87 clients, 8 direct reports, 22% retention improvement, onboarding consistency, satisfaction tracking, and escalation handling.',
      'For ExtraHop, lead with NDR threat visibility, investigation workflows, behavioral detection/use-case mapping, AI workflow automation, onboarding/time-to-value, CISO stakeholder alignment, and cross-functional execution.',
      'For Securonix, lead with SIEM/UEBA onboarding reduction, lifecycle model building, escalation protocols, investigation workflows, and Product/Engineering feedback loops.',
      'Downrank pure director-level people leadership, broad portfolio administration, and NRR-heavy commercial phrasing unless tied directly to startup CS operating systems and customer value.',
    ].join('\n');
  }
  if (mode === 'startup-commercial-cs-builder') {
    return [
      shared,
      'POSITIONING MODE: commercial startup CSM builder.',
      'Open as a hands-on Customer Success Manager and commercial CS operator, not as a Director, TAM, support rep, or cybersecurity-only specialist.',
      'Make TITLE_LINE signal expansion, retention, churn save, startup CS playbook building, AE partnership, and physical-security / IoT adjacency.',
      'Make PROFESSIONAL_SUMMARY connect Total Trial Services CS-function-building proof to Securonix churn-save/process proof and ExtraHop enterprise renewal/expansion proof.',
      'Use METRICS_LINE to balance commercial and builder proof: $55M ARR Portfolio (Peak), $23M NDR Portfolio, 98-100% Retention, 120% NRR, 87-Client CS Function Build, 22% Retention Lift, 30% Onboarding Reduction, or 81% ARR Growth as space allows.',
      'Use CORE_COMPETENCIES as a commercial startup CSM list: Expansion & Retention Ownership, Churn Save, Book of Business Management, AE Partnership, Account Planning, Renewal Motions, Pipedrive / CRM Hygiene, QBRs, Proactive Outreach, Playbook Building, Voice of Customer, Product Feedback, Startup Operating Cadence, Physical Security / IoT Adjacency, Security Chiefs / IT / Ops Stakeholders.',
      'Put Total Trial Services in a key achievement or bullet: built the CS function across 87 clients and an 8-person team, improving retention 22% through onboarding consistency, satisfaction tracking, and escalation handling.',
      'Put Securonix churn-save or onboarding proof in the resume: 100% renewal, three at-risk accounts retained, 30% onboarding reduction, lifecycle model building, or 81% ARR expansion.',
      'For ExtraHop, lead with commercial ownership, executive alignment, QBR governance, renewal strategy, AE collaboration, expansion planning, adoption, and CRM/account hygiene. Do not invent AI deployed in customer SOC environments.',
      'Treat physical security / IoT as an adjacency and buyer/stakeholder bridge, not as direct prior domain experience.',
      'Downrank threat-hunting vocabulary, telemetry inventories, and cybersecurity tooling details unless they help explain transferable security-operations buyer credibility.',
    ].join('\n');
  }
  if (mode === 'strategic-cs-leadership') {
    return [
      shared,
      'POSITIONING MODE: strategic customer success leadership.',
      'Open as a strategic enterprise CS leader, customer outcomes executive, or Director of Customer Success aligned to the JD title.',
      'Lead with retention, adoption, customer health, executive engagement, value realization, customer planning, cross-functional influence, and people leadership.',
      'Use CORE_COMPETENCIES as a concise customer-success competency list. Prefer executive stakeholder management, customer health strategy, adoption and value realization, QBR/EBR leadership, lifecycle management, team leadership and coaching, customer journey optimization, operational excellence, Salesforce, and Gainsight.',
      'Downrank cybersecurity tooling, protocol names, architecture language, and security-platform inventories unless the JD itself is security-specific.',
      'Translate technical experience into business-outcome language: measurable outcomes, long-term adoption goals, customer planning, operating cadence, and executive partnership.',
      'Elevate people leadership, team development, lifecycle frameworks, segmentation, health scoring, and scalable operating models wherever supported.',
      'If the JD is healthcare, benefits, HR, or people-focused, use source-supported healthcare, regulated-industry, member, employee, or human-centered language without inventing direct domain experience.',
    ].join('\n');
  }
  return [
    shared,
    'POSITIONING MODE: customer success technical advisory.',
    'Use customer success, technical account leadership, adoption, renewal, retention, and executive stakeholder language when supported by the JD.',
    'For commercial CSM JDs, the above-fold sections must show named-account portfolio ownership, NRR/GRR, renewal execution, expansion, upsell/cross-sell discovery, ARR impact, account health, risk action plans, executive business reviews, demonstrations, escalation ownership, and mentorship when those requirements appear.',
    'Never copy exact target workload ranges from the JD, such as 30-40 named accounts, into candidate accomplishments or competency labels unless the source truth contains the same exact range. Use named-account portfolio management instead.',
    'Still preserve technical credibility with named security platforms, integrations, discovery, architecture, and measurable customer outcomes.',
  ].join('\n');
}

async function pass2Synthesis(jdText, keywords, bragDoc, fields, log, notify = () => {}, planningContext = null) {
  const positioningMode = planningContext?.roleMode || classifyResumeRole(jdText);
  const positioningInstructions = resumePositioningInstructions(positioningMode);
  const planningText = planningContextText(planningContext);
  const buildContent = (historySlice) =>
    `ROLE STRATEGY:\n${positioningInstructions}\n\n${planningText}\n\nCANDIDATE SOURCE OF TRUTH:\n${historySlice}\n\nJOB DESCRIPTION:\n${jdText.slice(0, CAP_JD)}\n\nKEYWORDS FROM PASS 1:\n${keywords}\n\nRETURN SHAPE:\n- Fill scalar fields: ${fields.filter(field => !/^JOB_\d+_/.test(field)).map(f => f).join(', ')}\n- Return ROLES with six chronological objects: { roleIndex, context, bullets[] }\n- bullets[] are ranked candidate bullets. The app will choose the final bullet count locally.\n- Low-match roles may return an empty bullets[] while keeping a concise context line.\n\nReturn strict JSON only.`;

  const lmContent   = buildContent(bragDoc.slice(0, CAP_BRAG));

  if (!localAiEnabled()) {
    throw new Error('Resume synthesis requires local LM Studio, which is disabled (CAREER_OPS_DISABLE_LM_STUDIO=1).');
  }

  const model = localResumeModel();
  const maxTokens = parseInt(process.env.LM_STUDIO_MAX_OUTPUT_TOKENS ?? '4096', 10);
  const timeoutMs = parseInt(process.env.LM_STUDIO_SYNTHESIS_TIMEOUT_MS ?? '180000', 10);
  notify('lm-synthesis', 'running', 'LM Studio', `Synthesizing resume · ${model} (up to ${Math.round(timeoutMs/1000)}s)`);
  try {
    const raw = await lmStudioChat(
      model,
      [
        { role: 'system', content: SYNTHESIS_SYSTEM_PROMPT },
        { role: 'user', content: lmContent },
      ],
      { maxTokens, timeoutMs }
    );
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    const scalarFields = fields.filter(field => !/^JOB_\d+_/.test(field));
    const filledScalars = scalarFields.filter(field => parsed[field] && String(parsed[field]).trim().length > 0).length;
    const roleCount = normalizeRoleCandidates(parsed).filter(role => role.context).length;
    const filled = filledScalars + roleCount;
    const coverage = filled / (scalarFields.length + ROLE_SLOT_COUNTS.length);
    if (coverage < 0.8) {
      log('lm-studio-pass2', `low coverage ${filled}/${scalarFields.length + ROLE_SLOT_COUNTS.length} sections — retrying locally`);
      notify('lm-synthesis', 'fallback', 'LM Studio', `Low coverage ${filled}/${scalarFields.length + ROLE_SLOT_COUNTS.length} sections → retrying`);
      return await localSynthesisRetry(lmContent, log, notify);
    }

    log('lm-studio-pass2', `done (${filled}/${scalarFields.length + ROLE_SLOT_COUNTS.length} sections)`);
    notify('lm-synthesis', 'done', 'LM Studio', `${filled}/${scalarFields.length + ROLE_SLOT_COUNTS.length} sections filled`);
    return parsed;
  } catch (err) {
    if (isLmStudioUnreachable(err)) throw lmStudioUnavailableError(err, model);
    log('lm-studio-pass2', `retrying locally (${err.message.slice(0, 80)})`);
    notify('lm-synthesis', 'fallback', 'LM Studio', `${err.message.slice(0, 60)} → retrying`);
    return await localSynthesisRetry(lmContent, log, notify);
  }
}

function isLmStudioUnreachable(err) {
  return err?.code === 'ECONNREFUSED' || err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message || '');
}

function lmStudioUnavailableError(err, model) {
  return new Error(`LM Studio is not reachable at ${LM_STUDIO_BASE} (${err.message}). Start the LM Studio server and load ${model}, then retry.`);
}

async function localSynthesisRetry(userContent, log, notify = () => {}) {
  const model = localResumeModel();
  notify('lm-synthesis', 'running', 'LM Studio', `Retrying resume synthesis · ${model}`);
  let rawText;
  try {
    const message = await localAiClient.messages.create({
      model,
      max_tokens: parseInt(process.env.LM_STUDIO_MAX_OUTPUT_TOKENS ?? '4096', 10),
      system: SYNTHESIS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });
    rawText = message.content[0]?.text ?? '';
  } catch (err) {
    if (isLmStudioUnreachable(err)) throw lmStudioUnavailableError(err, model);
    throw new Error(`LM Studio resume synthesis failed (${model}): ${err.message}`);
  }
  const cleaned = rawText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LM Studio resume synthesis returned invalid JSON (${model}): ${err.message}`);
  }
  log('lm-studio-pass2', 'done (retry)');
  notify('lm-synthesis', 'done', 'LM Studio', 'Synthesis complete');
  return parsed;
}

// ── Draft critique / repair ──────────────────────────────────────────────────

const PRE_SALES_CS_MISMATCH_RE = /\b(customer success leader|customer success manager|csm|post-sale|post sale|renewal|renewals|retention|nrr|churn|account health)\b/i;
const PRE_SALES_SIGNAL_RE = /\b(pre-sales|presales|solution architect|solutions architect|client solutions engineer|sales engineer|technical advisor|technical advisory|architecture|discovery|demo|poc|solution sizing|bom|data center|cloud|security architecture)\b/i;
const DELIVERY_SAAS_MISMATCH_RE = /\b(retention\s*&\s*expansion ownership|retention and expansion ownership|nrr|net revenue retention|arr growth|expansion-focused|commercial owner|pipeline generation|sales-assist|sales assist)\b/i;
const DELIVERY_SIGNAL_RE = /\b(managed services|msp|service delivery|delivery accountability|execution leadership|execution coordination|onboarding|corrective action|technology rollout|environment build|playbook|escalation accountability|dashboards|ticket queues|backlog|compliance-aligned|compliance program|audit-readiness|team accountability)\b/i;
const STARTUP_BUILDER_SIGNAL_RE = /\b(startup|build(?:er|ing)?|built|from scratch|from the ground up|process design|implementation|scalable onboarding|workflow|ai-assisted|ai-driven|workflow automation|voice of customer|product|engineering|sales handoff|marketing advocacy|strategic business review|security workshop)\b/i;
const STARTUP_BUILDER_DOMAIN_RE = /\b(threat hunting|behavioral detection|behavior-based|endpoint telemetry|identity telemetry|cloud telemetry|credential misuse|lateral movement|post-access|NDR|SIEM|UEBA|SOC|investigation workflow)\b/i;
const STARTUP_BUILDER_MISMATCH_RE = /\b(director-level|people manager|managed a team of|team of senior customer success|broad portfolio administrator|relationship manager)\b/i;
const COMMERCIAL_STARTUP_SIGNAL_RE = /\b(expansion|retention|churn save|renewal|book of business|account planning|AE partnership|AEs?|Pipedrive|QBR|customer records|account context|playbook|built|from scratch|startup|Voice of Customer)\b/i;
const COMMERCIAL_STARTUP_DOMAIN_RE = /\b(physical security|IoT|hardware-software|industrial tech|ops|facilities|security chiefs?|IT professionals?|AI-powered physical security)\b/i;
const DIRECT_PHYSICAL_SECURITY_CLAIM_RE = /\b(?:direct|deep|extensive|hands-on|proven)\s+(?:physical security|IoT|industrial tech)\s+(?:experience|background|expertise)\b/i;
const AI_CX_SIGNAL_RE = /\b(customer experience|cxm|AI platform adoption|enterprise AI|conversational AI|customer service|autonomous support|AI quality|quality data|usage data|consumption|contracted volume|human-centric AI|Product(?:\s*&\s*| and )Engineering|multi-department|workflow integration|Fortune\s*(?:100|500))\b/i;
const UNSUPPORTED_DIRECT_AI_CLAIM_RE = /\b(?:built|deployed|implemented|rolled out|created|launched|designed)\s+(?:an?\s+)?(?:AI workflow automation|AI agents?|AI copilots?|conversational AI|LLM|LLMs|generative AI|prompt tuning|training data workflows?)\b|\bdirect experience with\s+(?:AI workflow automation|AI agents?|AI copilots?|conversational AI|LLM|LLMs|generative AI|prompt tuning|training data workflows?)\b|\b(?:owned|led|ran)\s+(?:prompt tuning|training data workflows?)\b/i;
const STRATEGIC_CS_SIGNAL_RE = /\b(customer health|value realization|executive engagement|executive stakeholder|team leadership|coaching|customer planning|qbr|ebr|operating model|segmentation|cross-functional|adoption|customer outcomes)\b/i;
const OVERTECHNICAL_CS_RE = /\b(ndr|siem|ueba|edr|iam|soc|detection coverage|threat detection|platform architecture|security platform lifecycle|security stakeholders)\b/i;
const TRANSFERABLE_OUTCOME_SIGNAL_RE = /\b(customer outcomes?|business outcomes?|value realization|executive engagement|stakeholder alignment|operating model|operating cadence|adoption|retention|execution|team leadership|customer planning|risk reduction|growth opportunities)\b/i;
const SOURCE_DOMAIN_HEAVY_RE = /\b(ndr|npm|siem|ueba|edr|iam|soc|threat detection|security program maturity|deployment health|security architecture|security operations timelines|detection use-case adoption|hybrid environments)\b/i;
const COMMERCIAL_CS_JD_RE = /\b(nrr|net revenue retention|quota|commission|upsell|cross-sell|cross sell|renewals?|arr|annual recurring revenue|expansion)\b/i;
const COMMERCIAL_CS_RESUME_RE = /\b(nrr|net revenue retention|grr|gross revenue retention|quota|commission|upsell|cross-sell|cross sell|renewals?|arr|annual recurring revenue|expansion|commercial)\b/i;
const PORTFOLIO_CS_JD_RE = /\b(named accounts?|portfolio of\s+\d+|portfolio|existing customers?|book of business|global customer base)\b/i;
const PORTFOLIO_CS_RESUME_RE = /\b(named accounts?|portfolio|book of business|\$[\d,.]+[MBK]?\s*ARR|\b\d+\s+(?:accounts|customers|clients)\b)\b/i;
const EXECUTIVE_DEMO_CS_JD_RE = /\b(present|discuss|demonstrate|demo|ciso|executive leadership|business reviews?|quarterly business reviews?|qbr|ebr|health checks?|account health|assess risk|action plans?|escalations?)\b/i;
const EXECUTIVE_DEMO_CS_RESUME_RE = /\b(ciso|executive|business reviews?|qbr|ebr|demonstrat|demo|poc|pov|health checks?|account health|health scoring|risk|action plans?|escalation)\b/i;
const MENTORSHIP_CS_JD_RE = /\b(mentor|mentorship|best practices|ramp up|new team members?|developing customer success managers?|junior)\b/i;
const MENTORSHIP_CS_RESUME_RE = /\b(mentor|mentorship|coach|coaching|best practices|ramp(?:ed|ing)?|new team members?|team standards|direct reports)\b/i;
const AI_CYBER_CS_JD_RE = /\b(ai|cybersecurity|cyber threat|threat defense|security platform|network|cloud|email|ciso|information security)\b/i;
const AI_CYBER_CS_RESUME_RE = /\b(ai|cybersecurity|cyber threat|threat defense|security|ndr|siem|xdr|edr|iam|cloud|email|ciso)\b/i;
const UNSUPPORTED_TARGET_PORTFOLIO_RANGE_RE = /\b(?:\d+\s*[–-]\s*\d+|\d+\s+to\s+\d+)\s+(?:named\s+)?(?:accounts|customers)\b/i;
const GENERATED_SECURITY_STAKEHOLDER_ARTIFACT_RE = /,?\s*for enterprise security stakeholders through documented deployment criteria and measurable security outcomes/gi;
const UNSUPPORTED_AI_SOC_SCOPE_RE = /\b(?:deployed|implemented|rolled out)\s+AI workflow automation inside customer SOC environments\b/i;
const BANNED_PHRASE_RE = /\b(results-driven|proven track record|passionate about|passionate|dynamic|thought leader|world-class|best-in-class|synergy|leverage|empowered|responsible for|served as (?:a |the )?point of contact|managed relationships|provided support)\b|—/i;
const GERUND_OPENING_RE = /^\s*[A-Z][a-z]+ing\b/;

/**
 * Local models sometimes return a field as JSON (e.g. CORE_COMPETENCIES as
 * {"Label": ["a", "b"]}). Render it in the template's text format
 * ("Label: a, b | Label: c") instead of "[object Object]". Nothing is added
 * or dropped; it is only re-formatted.
 */
function fieldText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([label, inner]) => {
        const text = fieldText(inner);
        return text ? `${label}: ${text}` : label;
      })
      .join(' | ');
  }
  return String(value);
}

/** Drops a " | " metrics segment already stated in an earlier segment. */
export function dedupeMetricsLine(value) {
  const kept = [];
  for (const segment of String(value ?? '').split(/\s*\|\s*/).filter(Boolean)) {
    const norm = segment.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!kept.some(prior => prior.toLowerCase().includes(norm))) kept.push(segment.trim());
  }
  return kept.join(' | ');
}

export function sanitizeResumeLanguage(value) {
  return fieldText(value)
    .replace(/—/g, ',')
    .replace(/\bresults-driven\b/gi, 'outcome-focused')
    .replace(/\bproven track record\b/gi, 'history')
    .replace(/\bpassionate about\b/gi, 'focused on')
    .replace(/\bpassionate\b/gi, 'focused')
    .replace(/\bdynamic\b/gi, 'enterprise')
    .replace(/\bthought leader\b/gi, 'technical advisor')
    .replace(/\bworld-class\b/gi, 'enterprise-grade')
    .replace(/\bbest-in-class\b/gi, 'high-performing')
    .replace(/\bsynergy\b/gi, 'alignment')
    .replace(/\bleverage\b/gi, 'use')
    .replace(/\bempowered\b/gi, 'enabled')
    .replace(/\bResponsible for\b/gi, 'Owned')
    .replace(/\bserved as (?:a |the )?point of contact\b/gi, 'aligned stakeholders')
    .replace(/\bmanaged relationships\b/gi, 'aligned executive stakeholders')
    .replace(/\bprovided support\b/gi, 'resolved execution gaps')
    .replace(GENERATED_SECURITY_STAKEHOLDER_ARTIFACT_RE, '')
    .replace(/\s*\((?:\d+\s*[–-]\s*\d+|\d+\s+to\s+\d+)\s+(?:named\s+)?(?:accounts|customers)\)/gi, '')
    .replace(/\b(?:\d+\s*[–-]\s*\d+|\d+\s+to\s+\d+)\s+(?:named\s+)?(?:accounts|customers)\b/gi, 'named account portfolios')
    .replace(/\b(?:Deployed|Implemented|Rolled out) AI workflow automation inside customer SOC environments to reduce repetitive manual analyst tasks\b/gi, 'Mapped customer investigation workflows to reduce repetitive manual effort')
    .replace(/\bBuilt AI workflow automation(?: at ExtraHop)? to improve security operations efficiency and reduce repetitive manual effort\b/gi, 'Translated telemetry and usage data into customer business cases tied to investigation workflows and measurable outcomes')
    .replace(/\bBuilt AI workflow automation targeting repetitive security operations tasks\b/gi, 'Translated telemetry and usage data into CISO-ready business cases tied to adoption gaps and investigation workflows')
    .replace(/\bdirect experience with AI workflow automation\b/gi, 'experience with telemetry-driven workflow improvement')
    .replace(/\bprompt tuning\b/gi, 'AI quality review')
    .replace(/\btraining data workflows?\b/gi, 'quality-data workflows')
    .replace(/\bcustomer-deployed AI workflow automation\b/gi, 'telemetry-driven workflow improvement')
    .replace(/,\s*across enterprise customer environments,\s*by aligning stakeholders,\s*use cases,\s*and measurable security outcomes\.?$/i, '.')
    .replace(/,\s*across enterprise customer environments,\s*using stakeholder alignment,\s*use-case scoping,\s*and measurable security outcomes\.*$/i, '.')
    .replace(/,\s*for technical advisory,\s*security architecture,\s*and cybersecurity SaaS execution\.?$/i, '.')
    .replace(/,\s*by aligning stakeholders,\s*use cases,\s*and measurable security outcomes\.?$/i, '.')
    .replace(/,\s*across enterprise cybersecurity stakeholders using documented deployment criteria and measurable security outcomes\.?$/i, '.')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*\./g, '.')
    .replace(/\s+\./g, '.')
    .trim();
}

function sanitizeReplacementSet(replacements, fields = Object.keys(replacements || {})) {
  const sanitized = { ...replacements };
  for (const field of fields) {
    if (Object.hasOwn(sanitized, field)) sanitized[field] = sanitizeResumeLanguage(sanitized[field]);
    if (field === 'METRICS_LINE' && Object.hasOwn(sanitized, field)) sanitized[field] = dedupeMetricsLine(sanitized[field]);
  }
  return sanitized;
}

function bulletStarts(replacements) {
  return Object.entries(replacements || {})
    .filter(([field]) => /^JOB_\d+_BULLET_\d+$/i.test(field))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([field, value]) => ({
      field,
      first: String(value ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') || '',
      value: String(value ?? ''),
    }));
}

function roleField(roleIndex, kind, bulletIndex = null) {
  return bulletIndex == null
    ? `JOB_${roleIndex}_${kind}`
    : `JOB_${roleIndex}_${kind}_${bulletIndex}`;
}

function normalizeRoleCandidates(rawDraft = {}, fields = []) {
  if (Array.isArray(rawDraft.ROLES)) {
    return ROLE_SLOT_COUNTS.map((_, offset) => {
      const roleIndex = offset + 1;
      const role = rawDraft.ROLES.find(item => Number(item?.roleIndex) === roleIndex) ?? {};
      return {
        roleIndex,
        context: String(role.context ?? rawDraft[roleField(roleIndex, 'CONTEXT')] ?? '').trim(),
        bullets: (Array.isArray(role.bullets) ? role.bullets : [])
          .map(value => typeof value === 'string' ? value : value?.text)
          .map(value => String(value ?? '').trim())
          .filter(Boolean),
      };
    });
  }
  return ROLE_SLOT_COUNTS.map((count, offset) => {
    const roleIndex = offset + 1;
    return {
      roleIndex,
      context: String(rawDraft[roleField(roleIndex, 'CONTEXT')] ?? '').trim(),
      bullets: Array.from({ length: count }, (_, idx) => String(rawDraft[roleField(roleIndex, 'BULLET', idx + 1)] ?? '').trim())
        .filter(Boolean),
    };
  });
}

function bulletSelectionScore(text, roleIndex, planningContext) {
  const normalized = normalizeText(text);
  const requirementTerms = (planningContext?.requirements ?? [])
    .slice(0, 12)
    .flatMap(item => normalizeText(item.requirement).split(/\s+/))
    .filter(term => term.length >= 4);
  const overlap = requirementTerms.filter(term => normalized.includes(term)).length;
  const proof = PROOF_RE.test(text) ? 3 : 0;
  const domain = DOMAIN_RE.test(text) ? 2 : 0;
  const recency = Math.max(0, 7 - roleIndex) * 0.15;
  return overlap + proof + domain + recency;
}

export function selectDynamicRoleBullets(rawDraft, planningContext, {
  budget = DEFAULT_DYNAMIC_BULLET_BUDGET,
} = {}) {
  const roles = normalizeRoleCandidates(rawDraft);
  const candidates = roles.flatMap(role => role.bullets.map((text, index) => ({
    roleIndex: role.roleIndex,
    index,
    text,
    score: bulletSelectionScore(text, role.roleIndex, planningContext),
  })));
  const rolesWithCandidates = roles.filter(role => role.bullets.length);
  const preserveContinuity = budget >= rolesWithCandidates.length;
  const mandatory = preserveContinuity
    ? rolesWithCandidates.map(role => role.bullets
      .map((text, index) => ({
        roleIndex: role.roleIndex,
        index,
        text,
        score: bulletSelectionScore(text, role.roleIndex, planningContext),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0])
    : [];
  const mandatoryKeys = new Set(mandatory.map(item => `${item.roleIndex}:${item.index}`));
  const selected = [
    ...mandatory,
    ...candidates
      .filter(item => !mandatoryKeys.has(`${item.roleIndex}:${item.index}`))
      .sort((a, b) => b.score - a.score || a.roleIndex - b.roleIndex || a.index - b.index)
      .slice(0, Math.max(0, budget - mandatory.length)),
  ]
    .sort((a, b) => b.score - a.score || a.roleIndex - b.roleIndex || a.index - b.index)
    .slice(0, budget);
  return roles.map(role => ({
    ...role,
    bullets: selected
      .filter(item => item.roleIndex === role.roleIndex)
      .sort((a, b) => a.index - b.index)
      .map(item => item.text),
  }));
}

export function flattenDynamicResumeDraft(rawDraft, fields, planningContext, options = {}) {
  const roles = selectDynamicRoleBullets(rawDraft, planningContext, options);
  const flattened = Object.fromEntries(Object.entries(rawDraft).filter(([field]) => field !== 'ROLES'));
  for (const role of roles) {
    flattened[roleField(role.roleIndex, 'CONTEXT')] = role.context;
    const slots = ROLE_SLOT_COUNTS[role.roleIndex - 1];
    for (let idx = 1; idx <= slots; idx += 1) {
      flattened[roleField(role.roleIndex, 'BULLET', idx)] = role.bullets[idx - 1] ?? '';
    }
  }
  return Object.fromEntries(fields.map(field => [field, fieldText(flattened[field])]));
}

function activeResumeFields(replacements, fields) {
  return fields.filter(field => !/^JOB_\d+_BULLET_\d+$/i.test(field) || String(replacements[field] ?? '').trim());
}

export function critiqueResumeDraft(replacements, planningContext) {
  const issues = [];
  const roleMode = planningContext?.roleMode || 'customer-success';
  const title = String(replacements?.TITLE_LINE ?? '');
  const metrics = String(replacements?.METRICS_LINE ?? '');
  const summary = String(replacements?.PROFESSIONAL_SUMMARY ?? '');
  const tools = String(replacements?.CORE_COMPETENCIES ?? '');
  const securitySpecificTarget = isSecuritySpecificTarget(planningContext, planningContext?.jdText);

  for (const [field, value] of Object.entries(replacements || {})) {
    const text = String(value);
    if (BANNED_PHRASE_RE.test(text)) {
      issues.push({
        field,
        code: 'banned-or-support-framing',
        message: 'Resume text uses banned phrasing, em dash, or support-first framing.',
      });
    }
    GENERATED_SECURITY_STAKEHOLDER_ARTIFACT_RE.lastIndex = 0;
    if (GENERATED_SECURITY_STAKEHOLDER_ARTIFACT_RE.test(text)) {
      issues.push({
        field,
        code: 'generated-security-stakeholder-artifact',
        message: 'Resume text contains a deterministic filler clause that should never ship.',
      });
    }
    if (UNSUPPORTED_AI_SOC_SCOPE_RE.test(text)) {
      issues.push({
        field,
        code: 'unsupported-ai-soc-scope',
        message: 'Resume text claims AI workflow automation was deployed inside customer SOC environments without source support.',
      });
    }
    if (UNSUPPORTED_DIRECT_AI_CLAIM_RE.test(text)) {
      issues.push({
        field,
        code: 'unsupported-direct-ai-claim',
        message: 'Resume text claims direct AI, LLM, prompt-tuning, training-data, or customer-deployed AI workflow ownership without source support.',
      });
    }
    if (UNSUPPORTED_TARGET_PORTFOLIO_RANGE_RE.test(text)) {
      issues.push({
        field,
        code: 'unsupported-target-portfolio-range',
        message: 'Resume text appears to copy the JD target account range as candidate history or a competency label.',
      });
    }
  }

  const keyAchievements = Object.entries(replacements || {})
    .filter(([field]) => /^KEY_ACHIEVEMENT_\d+$/i.test(field))
    .map(([, value]) => String(value ?? ''))
    .join(' ');
  if (Object.hasOwn(replacements || {}, 'METRICS_LINE') && !TOP_THIRD_METRIC_RE.test(`${metrics} ${summary} ${keyAchievements}`)) {
    issues.push({
      field: 'METRICS_LINE',
      code: 'weak-above-fold-proof',
      message: 'Above-fold resume sections lack a hard metric, scale signal, portfolio proof, or quantified key achievement.',
    });
  }
  const businessSignal = businessModelSignalForRole(roleMode);
  if (Object.hasOwn(replacements || {}, 'PROFESSIONAL_SUMMARY') && !businessSignal.test(`${title} ${metrics} ${summary} ${tools} ${keyAchievements}`)) {
    issues.push({
      field: 'PROFESSIONAL_SUMMARY',
      code: 'missing-role-business-model-signal',
      message: 'Above-fold resume sections do not show the target role business model or success measures.',
    });
  }

  const starts = bulletStarts(replacements);
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i].first && starts[i].first === starts[i - 1].first) {
      issues.push({
        field: starts[i].field,
        code: 'repeated-bullet-opener',
        message: 'Consecutive bullets start with the same verb.',
      });
    }
  }
  for (let i = 2; i < starts.length; i += 1) {
    if ([starts[i - 2], starts[i - 1], starts[i]].every(item => GERUND_OPENING_RE.test(item.value))) {
      issues.push({
        field: starts[i].field,
        code: 'gerund-streak',
        message: 'Three consecutive bullets start with gerunds.',
      });
    }
  }

  if (roleMode === 'pre-sales-solutions-architecture') {
    if (PRE_SALES_CS_MISMATCH_RE.test(`${title} ${summary}`)) {
      issues.push({
        field: PRE_SALES_CS_MISMATCH_RE.test(title) ? 'TITLE_LINE' : 'PROFESSIONAL_SUMMARY',
        code: 'role-frame-mismatch',
        message: 'Pre-sales resume still opens with post-sale Customer Success framing.',
      });
    }
    if (!PRE_SALES_SIGNAL_RE.test(`${title} ${summary}`)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-pre-sales-positioning',
        message: 'Pre-sales resume lacks solution architecture, technical advisory, or campaign ownership language.',
      });
    }
    if (!/tools|platforms|security platforms|cloud|infrastructure|security domains/i.test(tools)) {
      issues.push({
        field: 'CORE_COMPETENCIES',
        code: 'weak-tools-platforms',
        message: 'Tools & Platforms content lacks labeled platform or domain structure.',
      });
    }
    for (const [field, value] of Object.entries(replacements || {})) {
      if (!/^JOB_\d+_BULLET_\d+$/i.test(field)) continue;
      if (PRE_SALES_CS_MISMATCH_RE.test(String(value)) && !PRE_SALES_SIGNAL_RE.test(String(value))) {
        issues.push({
          field,
          code: 'post-sale-bullet-in-pre-sales-resume',
          message: 'Pre-sales resume bullet overuses renewal/retention/account-health language without technical sales context.',
        });
      }
    }
  }
  if (roleMode === 'msp-compliance-delivery') {
    if (DELIVERY_SAAS_MISMATCH_RE.test(`${title} ${summary}`)) {
      issues.push({
        field: DELIVERY_SAAS_MISMATCH_RE.test(title) ? 'TITLE_LINE' : 'PROFESSIONAL_SUMMARY',
        code: 'delivery-frame-mismatch',
        message: 'Delivery-focused resume still opens with SaaS expansion or commercial-owner framing.',
      });
    }
    if (!DELIVERY_SIGNAL_RE.test(`${title} ${summary}`)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-delivery-positioning',
        message: 'Delivery-focused resume lacks execution coordination, onboarding, corrective action, service delivery, or compliance-aligned positioning.',
      });
    }
    if (!/onboarding|corrective action|service delivery|managed services|compliance|technical project|escalation|dashboard|team accountability|playbook/i.test(tools)) {
      issues.push({
        field: 'CORE_COMPETENCIES',
        code: 'weak-delivery-competencies',
        message: 'Core competencies lack service delivery, project coordination, compliance-aligned, or escalation/accountability language.',
      });
    }
    for (const [field, value] of Object.entries(replacements || {})) {
      if (!/^KEY_ACHIEVEMENT_\d+$/i.test(field) && !/^JOB_\d+_BULLET_\d+$/i.test(field)) continue;
      const text = String(value);
      if (DELIVERY_SAAS_MISMATCH_RE.test(text) && !DELIVERY_SIGNAL_RE.test(text)) {
        issues.push({
          field,
          code: 'commercial-heavy-delivery-bullet',
          message: 'Delivery-focused bullet leads with expansion/NRR language without execution, onboarding, escalation, or service-delivery context.',
        });
      }
    }
  }
  if (roleMode === 'startup-cs-builder') {
    const aboveFold = `${title} ${summary} ${tools}`;
    const fullText = Object.values(replacements || {}).join(' ');
    if (!STARTUP_BUILDER_SIGNAL_RE.test(aboveFold)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-startup-builder-positioning',
        message: 'Startup CSM resume lacks build-from-scratch, process design, AI workflow, Voice of Customer, or cross-functional builder framing.',
      });
    }
    if (!STARTUP_BUILDER_DOMAIN_RE.test(aboveFold)) {
      issues.push({
        field: STARTUP_BUILDER_DOMAIN_RE.test(summary) ? 'TITLE_LINE' : 'CORE_COMPETENCIES',
        code: 'missing-threat-hunting-domain',
        message: 'Startup cybersecurity CSM resume lacks threat hunting, behavioral detection, telemetry, NDR, SIEM, or investigation-workflow vocabulary.',
      });
    }
    if (!/\bTotal Trial Services\b|\b87 clients\b|\b22% retention\b|\b8 direct reports\b|\bCS function\b/i.test(fullText)) {
      issues.push({
        field: Object.hasOwn(replacements || {}, 'KEY_ACHIEVEMENT_4') ? 'KEY_ACHIEVEMENT_4' : 'PROFESSIONAL_SUMMARY',
        code: 'missing-total-trial-builder-proof',
        message: 'Startup builder resume does not surface the Total Trial Services CS-function-building proof point.',
      });
    }
    if (STARTUP_BUILDER_MISMATCH_RE.test(aboveFold) && !STARTUP_BUILDER_SIGNAL_RE.test(aboveFold)) {
      issues.push({
        field: STARTUP_BUILDER_MISMATCH_RE.test(title) ? 'TITLE_LINE' : 'PROFESSIONAL_SUMMARY',
        code: 'startup-builder-overmanager-framing',
        message: 'Startup CSM resume over-positions Brian as a people manager or generic relationship owner instead of a hands-on builder.',
      });
    }
    if (!/AI|ChatGPT|Claude|Gemini|workflow automation|AI-assisted/i.test(aboveFold)) {
      issues.push({
        field: 'CORE_COMPETENCIES',
        code: 'missing-ai-fluency',
        message: 'Startup CSM resume lacks the AI fluency signal requested by the JD.',
      });
    }
  }
  if (roleMode === 'startup-commercial-cs-builder') {
    const aboveFold = `${title} ${summary} ${tools}`;
    const fullText = Object.values(replacements || {}).join(' ');
    if (!COMMERCIAL_STARTUP_SIGNAL_RE.test(aboveFold)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-commercial-startup-positioning',
        message: 'Commercial startup CSM resume lacks expansion, retention, churn-save, account planning, AE partnership, CRM, or playbook-builder framing.',
      });
    }
    if (!COMMERCIAL_STARTUP_DOMAIN_RE.test(aboveFold)) {
      issues.push({
        field: 'CORE_COMPETENCIES',
        code: 'missing-physical-security-iot-bridge',
        message: 'Commercial startup CSM resume lacks a physical-security, IoT, ops, facilities, or security-chief adjacency bridge.',
      });
    }
    if (!/\bTotal Trial Services\b|\b87 clients\b|\b22% retention\b|\b8 direct reports\b|\bCS function\b/i.test(fullText)) {
      issues.push({
        field: Object.hasOwn(replacements || {}, 'KEY_ACHIEVEMENT_4') ? 'KEY_ACHIEVEMENT_4' : 'PROFESSIONAL_SUMMARY',
        code: 'missing-total-trial-builder-proof',
        message: 'Startup commercial CSM resume does not surface the Total Trial Services CS-function-building proof point.',
      });
    }
    if (!/\b100% renewal\b|\bthree at-risk\b|\b3 at-risk\b|\bchurn save\b|\b30% onboarding\b|\b81% ARR\b/i.test(fullText)) {
      issues.push({
        field: Object.hasOwn(replacements || {}, 'KEY_ACHIEVEMENT_3') ? 'KEY_ACHIEVEMENT_3' : 'PROFESSIONAL_SUMMARY',
        code: 'missing-securonix-churn-save-proof',
        message: 'Commercial CSM resume does not surface Securonix churn-save, renewal, onboarding, or expansion proof.',
      });
    }
    if (DIRECT_PHYSICAL_SECURITY_CLAIM_RE.test(fullText)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'unsupported-direct-physical-security-claim',
        message: 'Resume claims direct physical-security or IoT experience instead of positioning it as adjacency.',
      });
    }
    if (SOURCE_DOMAIN_HEAVY_RE.test(aboveFold) && !COMMERCIAL_STARTUP_SIGNAL_RE.test(aboveFold)) {
      issues.push({
        field: SOURCE_DOMAIN_HEAVY_RE.test(tools) ? 'CORE_COMPETENCIES' : 'PROFESSIONAL_SUMMARY',
        code: 'commercial-csm-overtechnical-framing',
        message: 'Commercial CSM resume over-indexes on cybersecurity tooling before expansion, retention, account planning, and startup-builder outcomes.',
      });
    }
  }
  if (roleMode === 'ai-customer-experience') {
    const jd = String(planningContext?.jdText ?? '');
    const aboveFold = `${title} ${metrics} ${summary} ${tools}`;
    const fullText = Object.values(replacements || {}).join(' ');
    if (!AI_CX_SIGNAL_RE.test(aboveFold)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-ai-cx-positioning',
        message: 'AI-native CXM resume lacks enterprise AI platform adoption, customer experience, quality/usage data, consumption, workflow integration, or Product/Engineering feedback-loop positioning above the fold.',
      });
    }
    if (SOURCE_DOMAIN_HEAVY_RE.test(aboveFold) && !AI_CX_SIGNAL_RE.test(aboveFold)) {
      issues.push({
        field: SOURCE_DOMAIN_HEAVY_RE.test(tools) ? 'CORE_COMPETENCIES' : 'PROFESSIONAL_SUMMARY',
        code: 'ai-cx-source-domain-overfit',
        message: 'AI-native CXM resume over-indexes on cybersecurity source-domain language before translating it into AI platform adoption and customer-experience outcomes.',
      });
    }
    if (/\b(onboarding|implementation|multi-department|enterprise workflows?)\b/i.test(jd)
      && !/\bMcAfee\b|\blargest cloud security onboarding\b|\bFortune\s*500\b|\bhighest NPS\b/i.test(fullText)) {
      issues.push({
        field: Object.hasOwn(replacements || {}, 'KEY_ACHIEVEMENT_3') ? 'KEY_ACHIEVEMENT_3' : 'PROFESSIONAL_SUMMARY',
        code: 'missing-mcafee-onboarding-analog',
        message: 'AI-native CXM resume does not elevate McAfee largest cloud-security onboarding, Fortune 500 complexity, or highest-NPS implementation proof.',
      });
    }
    if (/\b(usage|quality|response|product|engineering|continuous improvement)\b/i.test(jd)
      && !/\busage data\b|\bquality data\b|\bProduct(?:\s*&\s*| and )Engineering\b|\bfeedback loop\b|\bfield observations\b|\bprioritized product\b/i.test(fullText)) {
      issues.push({
        field: Object.hasOwn(replacements || {}, 'KEY_ACHIEVEMENT_2') ? 'KEY_ACHIEVEMENT_2' : 'PROFESSIONAL_SUMMARY',
        code: 'missing-ai-quality-data-loop',
        message: 'AI-native CXM resume does not show the data-informed quality/adoption loop with Product and Engineering requested by the JD.',
      });
    }
    if (/\b(consumption|contracted volumes?|scale usage|expand into new teams|expansion)\b/i.test(jd)
      && !/\bconsumption\b|\bcontracted volume\b|\bscale usage\b|\bexpansion\b|\b120% NRR\b|\b81% ARR\b|\b30%\+ ARR\b/i.test(fullText)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-consumption-expansion-frame',
        message: 'AI-native CXM resume lacks consumption-based adoption, expansion, contracted-volume, or scale-usage framing.',
      });
    }
    if (/\b(integrates?|fragmented systems|knowledge|personalization|workflow|multi-department)\b/i.test(jd)
      && !/\bAuth0\b|\bIAM\b|\bauthentication\b|\bintegration\b|\bdeployment phases\b|\bproduction scale\b|\bworkflow integration\b/i.test(fullText)) {
      issues.push({
        field: Object.hasOwn(replacements || {}, 'KEY_ACHIEVEMENT_4') ? 'KEY_ACHIEVEMENT_4' : 'PROFESSIONAL_SUMMARY',
        code: 'missing-workflow-integration-proof',
        message: 'AI-native CXM resume lacks Auth0/IAM-style enterprise workflow integration proof for fragmented-system deployment complexity.',
      });
    }
  }
  if (roleMode === 'strategic-cs-leadership') {
    if (!STRATEGIC_CS_SIGNAL_RE.test(`${title} ${summary} ${tools}`)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-strategic-cs-positioning',
        message: 'Strategic CS leadership resume lacks customer health, value realization, executive engagement, operating model, or people-leadership framing.',
      });
    }
    if (OVERTECHNICAL_CS_RE.test(`${title} ${summary} ${tools}`)) {
      issues.push({
        field: OVERTECHNICAL_CS_RE.test(tools) ? 'CORE_COMPETENCIES' : 'PROFESSIONAL_SUMMARY',
        code: 'overtechnical-strategic-cs-framing',
        message: 'Strategic CS leadership resume over-indexes on cybersecurity tooling or architecture language for a non-security JD.',
      });
    }
    for (const [field, value] of Object.entries(replacements || {})) {
      if (!/^JOB_\d+_BULLET_\d+$/i.test(field)) continue;
      if (OVERTECHNICAL_CS_RE.test(String(value)) && !STRATEGIC_CS_SIGNAL_RE.test(String(value))) {
        issues.push({
          field,
          code: 'overtechnical-strategic-cs-bullet',
          message: 'Bullet emphasizes technical security detail without translating it into customer outcomes, executive engagement, health, adoption, or team operations.',
        });
      }
    }
  }
  if (roleMode === 'customer-success') {
    const jd = String(planningContext?.jdText ?? '');
    const aboveFold = `${title} ${metrics} ${summary} ${tools}`;
    const fullText = Object.values(replacements || {}).join(' ');
    if (PORTFOLIO_CS_JD_RE.test(jd) && !PORTFOLIO_CS_RESUME_RE.test(aboveFold)) {
      issues.push({
        field: 'METRICS_LINE',
        code: 'missing-named-account-portfolio-frame',
        message: 'Commercial CSM resume lacks named-account portfolio, book-of-business, ARR, or account-count scale above the fold.',
      });
    }
    if (COMMERCIAL_CS_JD_RE.test(jd) && !COMMERCIAL_CS_RESUME_RE.test(aboveFold)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-commercial-cs-ownership',
        message: 'Commercial CSM resume lacks NRR, renewal, expansion, upsell/cross-sell, ARR, quota, or commercial ownership framing above the fold.',
      });
    }
    if (EXECUTIVE_DEMO_CS_JD_RE.test(jd) && !EXECUTIVE_DEMO_CS_RESUME_RE.test(fullText)) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-executive-demo-health-cadence',
        message: 'Customer Success resume lacks executive reviews, demonstrations, health checks, account-health/risk action plans, or escalation ownership requested by the JD.',
      });
    }
    if (MENTORSHIP_CS_JD_RE.test(jd) && !MENTORSHIP_CS_RESUME_RE.test(fullText)) {
      issues.push({
        field: Object.hasOwn(replacements || {}, 'CORE_COMPETENCIES') ? 'CORE_COMPETENCIES' : 'PROFESSIONAL_SUMMARY',
        code: 'missing-csm-mentorship',
        message: 'Customer Success resume lacks mentorship, best-practice sharing, new-team-member ramp, playbook, or team-standard proof requested by the JD.',
      });
    }
    if (AI_CYBER_CS_JD_RE.test(jd) && securitySpecificTarget && !AI_CYBER_CS_RESUME_RE.test(aboveFold)) {
      issues.push({
        field: 'TITLE_LINE',
        code: 'missing-ai-cybersecurity-frame',
        message: 'Cybersecurity CSM resume lacks AI, cybersecurity, threat-defense, security platform, or CISO domain framing above the fold.',
      });
    }
  }
  if (!securitySpecificTarget) {
    if (SOURCE_DOMAIN_HEAVY_RE.test(`${title} ${summary} ${tools}`) && !TRANSFERABLE_OUTCOME_SIGNAL_RE.test(`${title} ${summary} ${tools}`)) {
      issues.push({
        field: SOURCE_DOMAIN_HEAVY_RE.test(tools) ? 'CORE_COMPETENCIES' : 'PROFESSIONAL_SUMMARY',
        code: 'source-domain-overfit',
        message: 'Resume over-indexes on source-domain jargon instead of translating experience into the target JD outcomes.',
      });
    }
    for (const [field, value] of Object.entries(replacements || {})) {
      if (!/^JOB_\d+_BULLET_\d+$/i.test(field)) continue;
      if (SOURCE_DOMAIN_HEAVY_RE.test(String(value)) && !TRANSFERABLE_OUTCOME_SIGNAL_RE.test(String(value))) {
        issues.push({
          field,
          code: 'source-domain-heavy-bullet',
          message: 'Bullet carries source-domain detail without enough transferable outcome language for the target JD.',
        });
      }
    }
  }

  const topRequirements = planningContext?.requirements?.slice(0, 5) || [];
  for (const requirement of topRequirements) {
    const mapped = planningContext?.evidenceMap?.find(item => item.requirement === requirement.requirement);
    if (mapped?.status === 'gap') continue;
    const words = normalizeText(requirement.requirement).split(/\s+/).filter(word => word.length >= 4);
    const resumeText = normalizeText(Object.values(replacements || {}).join(' '));
    if (words.length && !words.some(word => resumeText.includes(word))) {
      issues.push({
        field: 'PROFESSIONAL_SUMMARY',
        code: 'missing-supported-requirement',
        message: `Supported JD requirement is missing from resume framing: ${requirement.requirement}`,
      });
    }
  }

  return issues;
}

function deterministicCritiqueRepair(replacements, planningContext, issues) {
  if (!issues.length) return replacements;
  const repaired = { ...replacements };
  for (const issue of issues) {
    const field = issue.field;
    if (!field || !Object.hasOwn(repaired, field)) continue;
    if (['banned-or-support-framing', 'generated-security-stakeholder-artifact', 'unsupported-ai-soc-scope', 'unsupported-direct-ai-claim', 'unsupported-target-portfolio-range'].includes(issue.code)) {
      repaired[field] = sanitizeResumeLanguage(repaired[field]);
    }
  }
  if (Object.hasOwn(repaired, 'METRICS_LINE') && issues.some(issue => issue.code === 'weak-above-fold-proof')) {
    repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '$55M ARR Portfolio (Peak)');
    repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '98-100% Retention');
  }
  if (Object.hasOwn(repaired, 'PROFESSIONAL_SUMMARY') && issues.some(issue => issue.code === 'missing-role-business-model-signal')) {
    const current = String(repaired.PROFESSIONAL_SUMMARY || '').trim();
    const roleSignal = planningContext?.roleMode === 'pre-sales-solutions-architecture'
      ? 'Connects discovery, solution architecture, technical business cases, and stakeholder proof to enterprise sales execution.'
      : planningContext?.roleMode === 'msp-compliance-delivery'
        ? 'Connects onboarding execution, escalation accountability, service delivery cadence, and compliance-aligned outcomes for managed services customers.'
        : planningContext?.roleMode === 'startup-cs-builder'
          ? 'Builds startup CS workflows, onboarding systems, Voice of Customer loops, and AI-assisted customer motions from ambiguous customer needs.'
          : planningContext?.roleMode === 'startup-commercial-cs-builder'
            ? 'Owns expansion, retention, churn-save, AE partnership, account planning, and startup playbook creation across a fast-moving book of business.'
            : planningContext?.roleMode === 'strategic-cs-leadership'
              ? 'Connects customer health, value realization, team operating models, executive engagement, and adoption outcomes across enterprise SaaS accounts.'
              : 'Connects retention, renewals, expansion, adoption, account health, executive reviews, and value realization across named-account portfolios.';
    if (!businessModelSignalForRole(planningContext?.roleMode).test(current)) {
      repaired.PROFESSIONAL_SUMMARY = [current, roleSignal]
        .filter(Boolean)
        .join(' ')
        .split(/(?<=\.)\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .join(' ');
    }
  }
  if (planningContext?.roleMode === 'pre-sales-solutions-architecture') {
    if (issues.some(issue => issue.field === 'TITLE_LINE')) {
      repaired.TITLE_LINE = 'Senior Client Solutions Engineer | Pre-Sales Technical Advisory | Enterprise Cloud & Security Architecture';
    }
    if (issues.some(issue => issue.field === 'PROFESSIONAL_SUMMARY')) {
      const summary = String(repaired.PROFESSIONAL_SUMMARY || '').replace(/\bEnterprise Customer Success leader\b/i, 'Enterprise technical advisor and pre-sales solution architect');
      repaired.PROFESSIONAL_SUMMARY = PRE_SALES_SIGNAL_RE.test(summary)
        ? summary
        : `Enterprise technical advisor and pre-sales solution architect aligning security architecture, cloud infrastructure, discovery, and executive stakeholders to complex buying decisions. ${summary}`.trim();
    }
    if (issues.some(issue => issue.field === 'CORE_COMPETENCIES')) {
      const current = String(repaired.CORE_COMPETENCIES || '').trim();
      repaired.CORE_COMPETENCIES = current && /security platforms|cloud|infrastructure|security domains/i.test(current)
        ? current
        : 'Security Platforms: ExtraHop, Securonix, SIEM, NDR, IAM, XDR | Cloud & Infrastructure: hybrid cloud, data center, network visibility | GTM/CS Platforms: Salesforce, Gainsight | Security Domains: threat detection, log ingestion, vulnerability workflows, executive advisory';
    }
  }
  if (planningContext?.roleMode === 'msp-compliance-delivery') {
    if (issues.some(issue => issue.field === 'TITLE_LINE')) {
      repaired.TITLE_LINE = 'Director of Customer Success | Cybersecurity & Managed Services | Execution Leadership | Compliance-Aligned Delivery';
    }
    if (issues.some(issue => issue.field === 'PROFESSIONAL_SUMMARY')) {
      const current = String(repaired.PROFESSIONAL_SUMMARY || '').trim();
      repaired.PROFESSIONAL_SUMMARY = DELIVERY_SIGNAL_RE.test(current)
        ? current
        : `Customer-facing cybersecurity delivery leader aligning onboarding execution, corrective action coordination, escalation accountability, and cross-functional service teams across regulated enterprise environments. ${current}`.trim();
    }
    if (issues.some(issue => issue.field === 'CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = 'MSP Service Delivery Coordination | Onboarding Project Management | Corrective Action Plan Management | Technical Project Coordination | Compliance-Aligned Engagement Frameworks | Escalation Protocols | Customer Health Instrumentation | Dashboard-Driven Prioritization | Team Accountability | QBR and KPI Communication | Security Operations | SIEM/SOC Workflows | DLP and IAM Policy Enforcement | Executive Stakeholder Alignment';
    }
  }
  if (planningContext?.roleMode === 'ai-customer-experience') {
    if (issues.some(issue => issue.field === 'TITLE_LINE')) {
      repaired.TITLE_LINE = 'Senior Customer Experience Manager | Enterprise AI Platform Adoption | Strategic Account Leadership';
    }
    if (issues.some(issue => ['PROFESSIONAL_SUMMARY', 'METRICS_LINE'].includes(issue.field) || issue.code === 'missing-ai-cx-positioning')) {
      repaired.PROFESSIONAL_SUMMARY = 'Strategic Customer Experience Manager with 22+ years leading enterprise SaaS onboarding, adoption, expansion, and executive stakeholder alignment across complex technical platforms. Translates telemetry, usage data, integration constraints, and quality signals into Product and Engineering feedback loops that improve customer outcomes. Brings Maven-relevant proof from McAfee\'s largest cloud-security onboarding, Securonix usage-data reviews, Auth0 workflow integrations, and ExtraHop CISO business cases without overstating direct LLM ownership.';
    }
    if (issues.some(issue => issue.field === 'CORE_COMPETENCIES' || issue.code === 'missing-ai-cx-positioning')) {
      repaired.CORE_COMPETENCIES = 'Strategic Relationship Management | Enterprise AI Platform Adoption | Onboarding & Implementation Leadership | Consumption-Based Expansion | Quality / Usage Data Reviews | Product & Engineering Feedback Loops | Multi-Department Workflow Integration | Fortune 100/500 Stakeholder Management | Human-Centric AI Adoption | Executive QBRs & Business Outcome Reporting | Churn Prevention & At-Risk Recovery | CS Playbook & Lifecycle Model Building | Enterprise SaaS Value Realization';
    }
    if (issues.some(issue => issue.code === 'missing-mcafee-onboarding-analog')) {
      const target = Object.hasOwn(repaired, 'KEY_ACHIEVEMENT_3')
        ? 'KEY_ACHIEVEMENT_3'
        : Object.keys(repaired).find(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
      if (target) {
        repaired[target] = 'Led McAfee\'s largest cloud-security onboarding for Fortune 500 customers, coordinating complex rollout work and achieving the highest NPS score across the portfolio.';
      }
    }
    if (issues.some(issue => issue.code === 'missing-ai-quality-data-loop')) {
      const target = Object.hasOwn(repaired, 'KEY_ACHIEVEMENT_2')
        ? 'KEY_ACHIEVEMENT_2'
        : Object.keys(repaired).find(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
      if (target) {
        repaired[target] = 'Converted Securonix usage data and field observations into Product and Engineering feedback loops while cutting onboarding time 30% and improving customer confidence.';
      }
    }
    if (issues.some(issue => issue.code === 'missing-workflow-integration-proof')) {
      const target = Object.hasOwn(repaired, 'KEY_ACHIEVEMENT_4')
        ? 'KEY_ACHIEVEMENT_4'
        : Object.keys(repaired).find(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
      if (target) {
        repaired[target] = 'Guided Auth0 enterprise IAM workflow integrations across 14 accounts, aligning security and engineering stakeholders through deployment phases to production-scale value.';
      }
    }
  }
  if (planningContext?.roleMode === 'startup-cs-builder') {
    if (issues.some(issue => issue.field === 'TITLE_LINE')) {
      repaired.TITLE_LINE = 'Customer Success Manager | Cybersecurity Startup CS Builder | Process Design, AI Workflow Scale & Threat Hunting';
    }
    if (issues.some(issue => issue.field === 'PROFESSIONAL_SUMMARY')) {
      repaired.PROFESSIONAL_SUMMARY = 'Hands-on cybersecurity CSM and CS builder with 22+ years across NDR, SIEM, IAM, endpoint, identity, and cloud security environments. Builds onboarding workflows, support processes, escalation paths, and Voice of Customer loops that turn threat-hunting platforms into measurable customer value. Founded the CS motion at Total Trial Services across 87 clients and improved retention 22%, while carrying ExtraHop and Securonix proof in behavioral detection, investigation workflows, and security telemetry.';
    }
    if (issues.some(issue => issue.field === 'CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = 'Startup CS Function Building | Process Design & Implementation | Scalable Onboarding Workflows | AI-Assisted Documentation & Workflow Automation | Strategic Business Reviews | Security Workshops | Voice of Customer | Product & Engineering Feedback Loops | Sales Handoffs & Expansion Partnership | Marketing Advocacy & Case Studies | Threat Hunting | Behavioral Detection | Endpoint / Identity / Cloud Telemetry | Credential Misuse | Lateral Movement | Post-Access Activity | ExtraHop NDR/NPM | Securonix SIEM/UEBA | Auth0/Okta IAM';
    }
    if (issues.some(issue => issue.code === 'missing-total-trial-builder-proof')) {
      const achievementField = Object.hasOwn(repaired, 'KEY_ACHIEVEMENT_4')
        ? 'KEY_ACHIEVEMENT_4'
        : Object.keys(repaired).find(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
      if (achievementField) {
        repaired[achievementField] = 'Built the CS function at Total Trial Services across 87 clients and an 8-person team, improving retention 22% through onboarding consistency and escalation handling.';
      }
    }
  }
  if (planningContext?.roleMode === 'startup-commercial-cs-builder') {
    if (issues.some(issue => issue.field === 'TITLE_LINE')) {
      repaired.TITLE_LINE = 'Customer Success Manager | Startup CS Builder | Expansion, Retention & Churn Save | Physical Security / IoT Adjacency';
    }
    if (issues.some(issue => issue.field === 'PROFESSIONAL_SUMMARY')) {
      repaired.PROFESSIONAL_SUMMARY = 'Commercial Customer Success Manager with 22+ years building CS operating systems, owning retention and expansion outcomes, and translating technical customer needs into measurable adoption. Built the CS function at Total Trial Services across 87 clients and an 8-person team, improving retention 22% through onboarding consistency, satisfaction tracking, and escalation handling. Brings Securonix churn-save proof and ExtraHop enterprise renewal discipline to AI-powered physical security, IoT, IT, ops, and security-chief stakeholders.';
    }
    if (issues.some(issue => issue.field === 'CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = 'Commercial CSM Ownership | Expansion & Retention Strategy | Churn Save | Book of Business Management | AE Partnership | Account Planning | Renewal Motions | Pipedrive / CRM Hygiene | QBRs & Proactive Outreach | Startup CS Playbook Building | Voice of Customer | Product Feedback Loops | Cross-Functional Execution | Physical Security / IoT Adjacency | Security Chiefs / IT / Ops Stakeholders';
    }
    if (issues.some(issue => issue.code === 'missing-total-trial-builder-proof')) {
      const achievementField = Object.hasOwn(repaired, 'KEY_ACHIEVEMENT_4')
        ? 'KEY_ACHIEVEMENT_4'
        : Object.keys(repaired).find(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
      if (achievementField) {
        repaired[achievementField] = 'Built the CS function at Total Trial Services across 87 clients and an 8-person team, improving retention 22% through onboarding consistency and escalation handling.';
      }
    }
    if (issues.some(issue => issue.code === 'missing-securonix-churn-save-proof')) {
      const achievementField = Object.hasOwn(repaired, 'KEY_ACHIEVEMENT_3')
        ? 'KEY_ACHIEVEMENT_3'
        : Object.keys(repaired).find(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
      if (achievementField) {
        repaired[achievementField] = 'Retained three at-risk Securonix accounts through churn-save escalation, sustained 100% renewal performance, cut onboarding 30%, and supported 81% ARR expansion.';
      }
    }
  }
  if (planningContext?.roleMode === 'customer-success') {
    const jd = String(planningContext?.jdText ?? '');
    const securityTarget = isSecuritySpecificTarget(planningContext, jd);
    if (issues.some(issue => issue.code === 'missing-ai-cybersecurity-frame') && Object.hasOwn(repaired, 'TITLE_LINE')) {
      repaired.TITLE_LINE = securityTarget
        ? 'Enterprise Customer Success Manager | AI & Cybersecurity SaaS | NRR, Renewals & Expansion'
        : 'Enterprise Customer Success Manager | Named Accounts | NRR, Renewals & Expansion';
    }
    if (issues.some(issue => ['missing-commercial-cs-ownership', 'missing-executive-demo-health-cadence'].includes(issue.code))
      && Object.hasOwn(repaired, 'PROFESSIONAL_SUMMARY')) {
      repaired.PROFESSIONAL_SUMMARY = securityTarget
        ? 'Enterprise cybersecurity Customer Success operator owning named-account portfolios, NRR, renewal execution, expansion discovery, and executive adoption outcomes across complex security environments. Presents technical value narratives, solution demonstrations, and deployment health findings to CISO, security, and business stakeholders through QBRs, risk reviews, and escalation plans. Builds repeatable success motions that turn account health into renewals, upsell and cross-sell opportunities, advocacy, and durable ARR growth.'
        : 'Enterprise Customer Success operator owning named-account portfolios, NRR, renewal execution, expansion discovery, and executive adoption outcomes across complex SaaS environments. Presents value narratives, solution demonstrations, and account-health findings to executive and business stakeholders through QBRs, risk reviews, and escalation plans. Builds repeatable success motions that turn customer health into renewals, upsell and cross-sell opportunities, advocacy, and durable ARR growth.';
    }
    if (issues.some(issue => issue.code === 'missing-named-account-portfolio-frame') && Object.hasOwn(repaired, 'METRICS_LINE')) {
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '$55M ARR Portfolio (Peak)');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '120% NRR');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '98-100% Retention');
    }
    if (issues.some(issue => [
      'missing-commercial-cs-ownership',
      'missing-executive-demo-health-cadence',
      'missing-csm-mentorship',
    ].includes(issue.code)) && Object.hasOwn(repaired, 'CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = upsertCompetencyCategories(repaired.CORE_COMPETENCIES, {
        'Commercial CS': ['Named Account Portfolio Management', 'NRR / GRR Ownership', 'Renewal Execution', 'Upsell / Cross-Sell Discovery', 'ARR Growth', 'Executive QBRs'],
        'Customer Health': ['Deployment Health Checks', 'Account Health Risk Management', 'Risk Action Plans', 'Escalation Management', 'Value Realization'],
        'Technical Advisory': securityTarget
          ? ['CISO Presentations', 'Solution Demonstrations', 'Cyber Threat Defense Use Cases', 'NDR / SIEM / XDR / IAM Advisory']
          : ['Executive Presentations', 'Solution Demonstrations', 'Business Outcome Narratives'],
        'Team Enablement': ['CSM Mentorship', 'Best-Practice Sharing', 'New Team Member Ramp', 'CS Playbook Development'],
      });
    }
  }
  if (planningContext?.roleMode === 'strategic-cs-leadership') {
    if (issues.some(issue => issue.field === 'TITLE_LINE')) {
      repaired.TITLE_LINE = 'Director, Customer Success | Strategic Enterprise SaaS Accounts | Customer Retention, Adoption & Executive Engagement';
    }
    if (issues.some(issue => issue.field === 'PROFESSIONAL_SUMMARY')) {
      const current = String(repaired.PROFESSIONAL_SUMMARY || '').trim();
      repaired.PROFESSIONAL_SUMMARY = STRATEGIC_CS_SIGNAL_RE.test(current) && !OVERTECHNICAL_CS_RE.test(current)
        ? current
        : 'Customer Success leader with 20+ years guiding strategic enterprise relationships across SaaS environments, including portfolios up to $55M ARR with consistent 98-100% retention outcomes. Builds customer success operating models, develops teams, and partners with executive stakeholders to improve adoption, customer health, retention, and long-term business value. Known for helping enterprise customers translate platform adoption into measurable business outcomes, long-term partnership value, and executive alignment.';
    }
    if (issues.some(issue => issue.field === 'CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = 'Strategic Account Leadership | Executive Stakeholder Engagement | Customer Health & Retention Strategy | Value Realization Planning | QBR / EBR Governance | Lifecycle Engagement Models | Expansion & Renewal Strategy | Customer Journey Optimization | Team Coaching & Development | Customer Segmentation | Cross-Functional Leadership | Operational Excellence | Customer Planning | Churn Risk Mitigation | Salesforce | Gainsight';
    }
    for (const field of Object.keys(repaired)) {
      repaired[field] = softenStrategicCsLanguage(repaired[field]);
    }
  }
  if (!isSecuritySpecificTarget(planningContext, planningContext?.jdText) && issues.some(issue => /^source-domain-/.test(issue.code))) {
    for (const field of Object.keys(repaired)) {
      repaired[field] = softenTransferableLanguage(repaired[field]);
    }
    if (issues.some(issue => issue.field === 'CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = removeEmptyCompetencyCategories(repaired.CORE_COMPETENCIES);
    }
  }
  return repaired;
}

async function repairDraftFromCritique(replacements, planningContext, log, notify = () => {}) {
  const issues = critiqueResumeDraft(replacements, planningContext);
  if (!issues.length) {
    log('draft-critique', 'passed');
    notify('draft-critique', 'done', 'Local', 'Resume framing passed');
    return replacements;
  }

  log('draft-critique', `repairing ${issues.length} issues`);
  notify('draft-critique', 'repairing', 'Local', `Repairing ${issues.length} framing issues`);
  let repaired = deterministicCritiqueRepair(replacements, planningContext, issues);
  const remainingIssues = critiqueResumeDraft(repaired, planningContext);
  if (!remainingIssues.length) {
    log('draft-critique', 'repaired locally');
    notify('draft-critique', 'done', 'Local', `${issues.length} framing issues repaired locally`);
    return repaired;
  }

  if (!localAiEnabled()) {
    notify('draft-critique', 'done', 'Local', `${issues.length} framing issues repaired locally`);
    return repaired;
  }

  try {
    const client = localAiClient;
    const model = localResumeModel();
    const failedFields = [...new Set(remainingIssues.map(issue => issue.field))].filter(Boolean);
    const prompt = withHumanizer(`Repair only the listed resume fields so they match the role strategy and critique. Preserve only facts supported by the existing text, section plan, evidence map, or candidate history already present in the field values. Do not invent employers, dates, certifications, product names, or exact metrics. Return strict JSON with only these fields: ${failedFields.join(', ')}.\n\nROLE MODE:\n${planningContext?.roleMode}\n\nSECTION PLAN:\n${JSON.stringify(planningContext?.sectionPlan ?? {}, null, 2)}\n\nEVIDENCE MAP:\n${JSON.stringify(planningContext?.evidenceMap ?? [], null, 2)}\n\nCRITIQUE ISSUES:\n${JSON.stringify(remainingIssues, null, 2)}\n\nFIELDS:\n${JSON.stringify(Object.fromEntries(failedFields.map(field => [field, repaired[field] ?? replacements[field] ?? ''])), null, 2)}`);

    const message = await client.messages.create({
      model,
      max_tokens: 1600,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    repaired = { ...repaired, ...JSON.parse(cleaned) };
    repaired = sanitizeReplacementSet(repaired, failedFields);
    notify('draft-critique', 'done', 'LM Studio', `${issues.length} framing issues repaired`);
    return repaired;
  } catch (err) {
    log('draft-critique', `local repair kept after LM Studio error (${err.message.slice(0, 60)})`);
    notify('draft-critique', 'done', 'Local', `${issues.length} framing issues repaired locally`);
    return repaired;
  }
}

// ── Quality gate ──────────────────────────────────────────────────────────────

const GENERIC_BULLET_RE = /\b(managed|owned|supported|advised|maintained|partnered|worked|helped|assisted|handled|responsible for|drove adoption|improved engagement|ensured|collaborated)\b/i;
const PROOF_RE = /(\$[\d,.]+[MBK]?|\d+%|\d+\+?x|\b\d+\s*(accounts?|customers?|clients?|direct reports|opportunities|expansions|renewals|years?|ARR|NPS|CSAT)\b|\bFortune\s*\d+\b|\benterprise\b|\bCISO\b|\bVP\b)/i;
const TOP_THIRD_METRIC_RE = /(\$[\d,.]+[MBK]?|\d+%|\b\d+\s*(accounts?|customers?|clients?|direct reports|opportunities|expansions|renewals|ARR|NRR|GRR|NPS|CSAT)\b|\b\d+[\s-]*(client|account|customer)\b|\bARR\b|\bNRR\b|\bGRR\b|\bportfolios?\b)/i;
const DOMAIN_RE = /\b(NDR|NPM|SIEM|UEBA|EDR|IAM|DLP|CNAPP|CWPP|XDR|SaaS|security|cybersecurity|cloud|identity|endpoint|network|email|renewal|retention|expansion|onboarding|QBR|time-to-value|adoption|managed services|MSP|service delivery|compliance|audit-readiness|corrective action|technology rollout|environment build|ticket queue|backlog|playbook|escalation)\b/i;
const MECHANISM_RE = /\b(by|through|using|via|with|across|for|while|including|tied to|resulting in|enabling|reducing|retaining|expanding|accelerating|recovering|introducing|building|stabilizing)\b/i;
const COMMON_COPYABLE_CLAIM_RE = /\b(?:improved|drove|managed|supported|owned|handled|worked on|helped with)\s+(?:adoption|engagement|customer outcomes?|relationships?|accounts?|portfolios?|renewals?|retention|success)\b/i;
const HARD_TO_COPY_RE = /\b(playbooks?|operating models?|workflows?|governance|frameworks?|criteria|architecture|discovery|health scoring|lifecycle models?|escalation paths?|escalation protocols?|roadmaps?|QBR governance|success planning|risk action plans?|implementation plans?|deployment criteria|technical business cases?|onboarding models?|customer motions?|process(?:es)?|systems?)\b/i;

function businessModelSignalForRole(roleMode = 'customer-success') {
  if (roleMode === 'pre-sales-solutions-architecture') return /\b(pre-sales|presales|technical sales|discovery|demo|POC|RFP|RFI|solution|architecture|technical business case|win rate)\b/i;
  if (roleMode === 'msp-compliance-delivery') return /\b(service delivery|managed services|MSP|onboarding|corrective action|compliance|audit-readiness|escalation|ticket|backlog|technology rollout|team accountability)\b/i;
  if (roleMode === 'startup-cs-builder') return /\b(startup|builder|process design|workflow|onboarding|voice of customer|product|engineering|AI-assisted|AI-driven|SBR|security workshop)\b/i;
  if (roleMode === 'startup-commercial-cs-builder') return /\b(expansion|retention|churn save|book of business|AE partnership|account planning|renewal|Pipedrive|playbook|startup|physical security|IoT)\b/i;
  if (roleMode === 'ai-customer-experience') return /\b(customer experience|AI platform|onboarding|adoption|consumption|quality|usage data|Product|Engineering|workflow integration|Fortune\s*(?:100|500)|human-centric AI)\b/i;
  if (roleMode === 'strategic-cs-leadership') return /\b(customer health|value realization|executive engagement|team leadership|coaching|operating model|segmentation|customer outcomes|adoption|retention)\b/i;
  return /\b(retention|renewal|NRR|GRR|ARR|expansion|adoption|account health|QBR|EBR|value realization|named accounts?|book of business)\b/i;
}

function wordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function hasWeakGenericShape(value) {
  const text = String(value ?? '').trim();
  return GENERIC_BULLET_RE.test(text) && !(PROOF_RE.test(text) && DOMAIN_RE.test(text) && MECHANISM_RE.test(text));
}

function hasCopyableClaimShape(value) {
  const text = String(value ?? '').trim();
  return COMMON_COPYABLE_CLAIM_RE.test(text) && !HARD_TO_COPY_RE.test(text);
}

function bulletRoleNumber(field) {
  return Number(field.match(/^JOB_(\d+)_BULLET_\d+$/i)?.[1] ?? 0);
}

function bulletTargets(field) {
  const roleNumber = bulletRoleNumber(field);
  if (!roleNumber) return null;
  if (roleNumber >= 5) {
    return { minWords: 15, idealWords: '15-28', minChars: 140, maxChars: 210, kind: 'older/compressed' };
  }
  return { minWords: 18, idealWords: '22-34', minChars: 175, maxChars: 240, kind: 'recent/relevant' };
}

function qualityIssueFields(issues = []) {
  return [...new Set(issues
    .map(issue => String(issue).match(/^([A-Z0-9_]+):/)?.[1])
    .filter(Boolean))];
}

export function validateResumeQuality(replacements, fields) {
  const issues = [];
  const missing = fields.filter((field) => !String(replacements[field] ?? '').trim());
  for (const field of missing) issues.push(`${field}: missing replacement`);

  for (const field of fields) {
    const value = String(replacements[field] ?? '').trim();
    if (!value) continue;

    if (/\[object Object\]/.test(value)) {
      issues.push(`${field}: contains a serialized object instead of text`);
    }
    const words = wordCount(value);
    if (/^PROFESSIONAL_SUMMARY$/i.test(field) && words < 45) {
      issues.push(`${field}: summary is too thin (${words} words, expected 45+)`);
    }
    if (/^PROFESSIONAL_SUMMARY$/i.test(field)) {
      const sentences = value.split(/[.!?]+/).map(part => part.trim()).filter(Boolean);
      if (sentences.length > 3) {
        issues.push(`${field}: summary has too many sentences (${sentences.length}, expected 3 max)`);
      }
    }
    if (/^KEY_ACHIEVEMENT_\d+$/i.test(field) && words < 14) {
      issues.push(`${field}: achievement is too short (${words} words, expected 14+)`);
    }
    if (/^KEY_ACHIEVEMENT_\d+$/i.test(field) && !TOP_THIRD_METRIC_RE.test(value)) {
      issues.push(`${field}: achievement lacks a measurable result, scale signal, or portfolio proof`);
    }
    if (/^JOB_\d+_CONTEXT$/i.test(field) && words < 12) {
      issues.push(`${field}: context is too short (${words} words, expected 12+)`);
    }
    if (BANNED_PHRASE_RE.test(value)) {
      issues.push(`${field}: contains banned phrase, em dash, or support-first framing`);
    }
    GENERATED_SECURITY_STAKEHOLDER_ARTIFACT_RE.lastIndex = 0;
    if (GENERATED_SECURITY_STAKEHOLDER_ARTIFACT_RE.test(value)) {
      issues.push(`${field}: contains generated security-stakeholder filler artifact`);
    }
    if (UNSUPPORTED_AI_SOC_SCOPE_RE.test(value)) {
      issues.push(`${field}: contains unsupported AI customer-SOC deployment claim`);
    }
    if (UNSUPPORTED_DIRECT_AI_CLAIM_RE.test(value)) {
      issues.push(`${field}: contains unsupported direct AI/LLM ownership claim`);
    }
    if (UNSUPPORTED_TARGET_PORTFOLIO_RANGE_RE.test(value)) {
      issues.push(`${field}: contains unsupported target account-range copy from JD`);
    }
    if (/^JOB_\d+_BULLET_\d+$/i.test(field)) {
      const targets = bulletTargets(field);
      const chars = value.length;
      if (words < 15) issues.push(`${field}: bullet is too short (${words} words, expected 15+ even when compressed)`);
      if (targets && words < targets.minWords) {
        issues.push(`${field}: ${targets.kind} bullet is too short (${words} words, target ${targets.idealWords})`);
      }
      if (targets && chars < targets.minChars) {
        issues.push(`${field}: ${targets.kind} bullet is underfilled (${chars} characters, target ${targets.minChars}-${targets.maxChars})`);
      }
      if (!PROOF_RE.test(value)) issues.push(`${field}: bullet lacks metric, enterprise scope, or stakeholder proof`);
      if (!DOMAIN_RE.test(value)) issues.push(`${field}: bullet lacks relevant domain or CS/security language`);
      if (hasWeakGenericShape(value)) issues.push(`${field}: bullet reads like generic activity rather than differentiated impact`);
      if (hasCopyableClaimShape(value)) issues.push(`${field}: bullet makes a copyable claim without a specific system, workflow, playbook, or customer motion`);
    }
  }

  if (issues.length) {
    const err = new Error(`Resume quality gate failed:\n${issues.slice(0, 20).join('\n')}`);
    err.issues = issues;
    throw err;
  }
  return true;
}

function strengthenBulletFallback(field, value, roleMode = 'customer-success') {
  let text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return text;
  text = sanitizeResumeLanguage(text);
  text = text.replace(/\.$/, '');

  const additions = [];
  if (!PROOF_RE.test(text)) additions.push('across enterprise customer environments');
  if (!DOMAIN_RE.test(text)) {
    additions.push(roleMode === 'strategic-cs-leadership'
      ? 'with customer health, adoption, and enterprise SaaS context'
      : roleMode === 'startup-commercial-cs-builder'
        ? 'with account planning, renewal, and commercial CSM context'
        : roleMode === 'ai-customer-experience'
          ? 'with enterprise AI platform adoption, onboarding, and customer-experience context'
          : 'with security architecture and cybersecurity SaaS context');
  }
  if (!MECHANISM_RE.test(text) || hasWeakGenericShape(text)) {
    additions.push(roleMode === 'strategic-cs-leadership'
      ? 'using executive alignment, customer planning, and measurable business outcomes'
      : roleMode === 'startup-commercial-cs-builder'
        ? 'using AE partnership, account planning, and measurable retention or expansion outcomes'
        : roleMode === 'ai-customer-experience'
          ? 'through stakeholder alignment, usage-data review, workflow integration, and measurable customer outcomes'
          : 'through stakeholder alignment, use-case scoping, and measurable security outcomes');
  }

  if (additions.length) text = `${text}, ${additions.join(', ')}`;

  const targets = bulletTargets(field);
  if (targets && wordCount(text) < targets.minWords) {
    text = `${text}, with executive-ready operating rhythm and clear ownership`;
  }
  if (targets && text.length < targets.minChars) {
    text = `${text}, tying daily execution to durable adoption, risk reduction, and ${['strategic-cs-leadership', 'ai-customer-experience'].includes(roleMode) ? 'customer value' : 'security value'}`;
  }

  return `${text}.`;
}

function forceBulletQuality(value, issueTexts = [], roleMode = 'customer-success') {
  let text = String(value ?? '').trim().replace(/\.$/, '');
  const combinedIssues = issueTexts.join(' ');
  if (/lacks metric, enterprise scope, or stakeholder proof|generic activity|copyable claim/i.test(combinedIssues)) {
    const hasEnterpriseProof = /\benterprise|CISO|VP|\$[\d,.]+|\d+%|\b\d+\s*(accounts?|clients?|customers?)\b/i.test(text);
    const hasOutcome = /\bmeasurable|outcome|retention|adoption|risk reduction|time-to-value|value|renewal|expansion|onboarding\b/i.test(text);
    const hasMechanism = /\bthrough|using|by|with|via|tied to|resulting in\b/i.test(text);
    const needsHardToCopy = /copyable claim/i.test(combinedIssues) && !HARD_TO_COPY_RE.test(text);
    const needsClause = !hasEnterpriseProof || !hasOutcome || !hasMechanism || needsHardToCopy || hasWeakGenericShape(text);
    if (needsClause) {
      const clause = roleMode === 'strategic-cs-leadership'
        ? 'across enterprise stakeholders using customer planning, operating cadence, executive alignment, and measurable business outcomes'
        : roleMode === 'startup-commercial-cs-builder'
          ? 'across customer stakeholders using account planning workflows, renewal discipline, and measurable retention or expansion outcomes'
          : roleMode === 'ai-customer-experience'
            ? 'across enterprise stakeholders using usage-data reviews, workflow-integration governance, and measurable customer outcomes'
            : 'across enterprise security stakeholders using documented deployment criteria, workflow governance, and measurable customer outcomes';
      if (!text.toLowerCase().includes(clause.toLowerCase())) text = `${text}, ${clause}`;
    }
  }
  return `${sanitizeResumeLanguage(text)}.`;
}

function strengthenContextFallback(value, roleMode = 'customer-success') {
  let text = sanitizeResumeLanguage(String(value ?? '').trim().replace(/\s+/g, ' '));
  if (!text) return text;
  text = text.replace(/[.;]\s*$/, '');
  if (wordCount(text) >= 12) return text;
  const suffix = roleMode === 'strategic-cs-leadership'
    ? 'across strategic enterprise accounts'
    : 'across enterprise customer accounts';
  return `${text} ${suffix}`.replace(/\s+/g, ' ').trim();
}

function strengthenAchievementFallback(value) {
  let text = sanitizeResumeLanguage(String(value ?? '').trim().replace(/\s+/g, ' '));
  if (!text) return text;
  text = text.replace(/\.$/, '');
  if (!TOP_THIRD_METRIC_RE.test(text)) {
    text = `${text} across enterprise portfolios`;
  }
  if (wordCount(text) < 14) {
    text = `${text}, tying execution to measurable adoption, retention, or customer value`;
  }
  return `${text}.`;
}

function appendUniqueTerms(value, terms = []) {
  const existing = String(value ?? '').trim();
  const lower = existing.toLowerCase();
  const additions = terms
    .map(term => String(term ?? '').trim())
    .filter(Boolean)
    .filter(term => !lower.includes(term.toLowerCase()));
  return [existing, ...additions].filter(Boolean).join(' | ');
}

const COMPETENCY_ORPHAN_TERMS = [
  'Application Allowlisting',
  'POC Conversion & Success Metrics',
  'Sales Cycle Win Rate Contribution',
  'CIS Controls',
  'Malware & Ransomware Prevention',
];

function splitCompetencyItems(value) {
  return String(value ?? '')
    .split(/\s*,\s*|\s*;\s*/)
    .map(item => item.trim())
    .filter(Boolean);
}

function addCompetencyItems(body, additions = []) {
  const items = splitCompetencyItems(body);
  const lower = items.join(' ').toLowerCase();
  for (const item of additions) {
    if (!lower.includes(item.toLowerCase())) items.push(item);
  }
  return items.join(', ');
}

function cleanCompetencyOrphans(value) {
  const text = String(value ?? '').trim();
  if (!text) return text;
  const parts = text.split(/\s+\|\s+/).map(part => part.trim()).filter(Boolean);
  return parts
    .filter(part => {
      if (part.includes(':')) return true;
      return !COMPETENCY_ORPHAN_TERMS.some(term => term.toLowerCase() === part.toLowerCase());
    })
    .join(' | ');
}

function upsertCompetencyCategories(value, additionsByCategory = {}) {
  const cleaned = cleanCompetencyOrphans(value);
  const rawParts = cleaned.split(/\s+\|\s+/).map(part => part.trim()).filter(Boolean);
  const parts = [];
  const categoryIndexes = new Map();
  const categoryKey = (category) => {
    const normalized = category.toLowerCase();
    return ['gtm/cs platforms', 'gtm & pre-sales', 'gtm and pre-sales'].includes(normalized)
      ? 'gtm'
      : normalized;
  };

  for (const part of rawParts) {
    const match = part.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      parts.push(part);
      continue;
    }
    const category = match[1].trim();
    const key = categoryKey(category);
    if (categoryIndexes.has(key)) {
      const existingIndex = categoryIndexes.get(key);
      const [, existingCategory, existingBody] = parts[existingIndex].match(/^([^:]+):\s*(.*)$/) || [];
      parts[existingIndex] = `${existingCategory}: ${addCompetencyItems(existingBody, splitCompetencyItems(match[2]))}`;
    } else {
      categoryIndexes.set(key, parts.length);
      parts.push(`${category}: ${match[2].trim()}`);
    }
  }

  for (const [category, additions] of Object.entries(additionsByCategory)) {
    const normalized = categoryKey(category);
    const index = categoryIndexes.get(normalized);
    if (index === undefined) {
      parts.push(`${category}: ${addCompetencyItems('', additions)}`);
      categoryIndexes.set(normalized, parts.length - 1);
      continue;
    }
    const [, existingCategory, body] = parts[index].match(/^([^:]+):\s*(.*)$/) || [];
    parts[index] = `${existingCategory || category}: ${addCompetencyItems(body, additions)}`;
  }

  return parts.join(' | ');
}

function removeEmptyCompetencyCategories(value) {
  return String(value ?? '')
    .split(/\s+\|\s+/)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !/^[^:]+:\s*$/.test(part))
    .join(' | ');
}

function softenStrategicCsLanguage(value) {
  return sanitizeResumeLanguage(value)
    .replace(/\bdetection use-case adoption\b/gi, 'platform adoption and measurable operational outcomes')
    .replace(/\bsecurity program maturity\b/gi, 'strategic business objectives and operational priorities')
    .replace(/\bdeployment health\b/gi, 'customer engagement and lifecycle progress')
    .replace(/\bexpansion readiness before commercial cycles opened\b/gi, 'proactive visibility into retention risk and growth opportunities')
    .replace(/\bsecurity stakeholders\b/gi, 'executive stakeholders')
    .replace(/\bacross complex hybrid environments\b/gi, 'across complex enterprise organizations')
    .replace(/\bthreat detection gaps\b/gi, 'customer needs and operational priorities')
    .replace(/\bSOC teams\b/gi, 'customer teams')
    .replace(/\bsecurity operations timelines\b/gi, 'customer operating timelines')
    .replace(/\bsecurity architecture milestones\b/gi, 'customer success milestones')
    .replace(/\bCISO\b/gi, 'executive')
    .replace(/\bBuilt QBR governance across strategic enterprise accounts, surfacing adoption health signals and expansion signals for customer executives and internal sales leadership in structured quarterly reviews that tightened renewal forecasting and reduced late-stage surprises\.?/gi, 'Built structured QBR governance across strategic accounts, improving executive visibility into adoption health, renewal risk, and expansion opportunities while tightening forecast accuracy.');
}

function softenTransferableLanguage(value) {
  return sanitizeResumeLanguage(value)
    .replace(/\bdetection use-case adoption\b/gi, 'platform adoption and measurable operational outcomes')
    .replace(/\bsecurity program maturity\b/gi, 'strategic business objectives and operational priorities')
    .replace(/\bdeployment health\b/gi, 'customer engagement and lifecycle progress')
    .replace(/\bsecurity stakeholders\b/gi, 'executive stakeholders')
    .replace(/\bacross complex hybrid environments\b/gi, 'across complex enterprise organizations')
    .replace(/\bthreat detection gaps\b/gi, 'customer needs and operational priorities')
    .replace(/\bSOC teams\b/gi, 'customer teams')
    .replace(/\bsecurity operations timelines\b/gi, 'customer operating timelines')
    .replace(/\bsecurity architecture milestones\b/gi, 'customer success milestones');
}

function stripRedundantContextPrefix(value) {
  return String(value ?? '')
    .replace(/^(Customer Success Engineer \(Strategic Accounts\)|Strategic Customer Success Manager|Enterprise Customer Success Manager|Senior Customer Success Manager|Director of Customer Success|Customer Success Manager)\s*\|\s*(ExtraHop|Securonix|McAfee|Auth0\s*\/?\s*Okta|Total Trial Services(?:,\s*LLC)?|Proofpoint)\s*\|\s*[^|]+\|\s*/i, '')
    .trim();
}

export function applyRoleSectionIntegrityRepairs(replacements, fields) {
  const repaired = { ...replacements };
  for (const field of fields.filter(field => /^JOB_\d+_CONTEXT$/i.test(field))) {
    repaired[field] = stripRedundantContextPrefix(repaired[field]);
  }

  if (fields.includes('JOB_6_CONTEXT') && /\bTrend Micro\b|\bDynatrace\b|\bKeynote\b/i.test(repaired.JOB_6_CONTEXT || '')) {
    repaired.JOB_6_CONTEXT = '$18M ARR portfolio | 18 enterprise accounts | Email security, advanced threat protection, and security awareness';
  }
  if (fields.includes('JOB_6_BULLET_1') && /\bTrend Micro\b|\bDynatrace\b|\bKeynote\b|\bCEH\b/i.test(repaired.JOB_6_BULLET_1 || '')) {
    repaired.JOB_6_BULLET_1 = 'Managed an $18M ARR enterprise portfolio across 18 accounts, sustaining 98% retention through structured executive engagement, onboarding governance, and success planning initiatives.';
  }
  if (fields.includes('JOB_6_BULLET_2') && /\bTrend Micro\b|\bDynatrace\b|\bKeynote\b|\bCEH\b/i.test(repaired.JOB_6_BULLET_2 || '')) {
    repaired.JOB_6_BULLET_2 = 'Built $1.65M+ in expansion pipeline by mapping email security, threat protection, and security awareness gaps to platform capabilities during structured reviews with enterprise security stakeholders.';
  }

  if (fields.includes('CORE_COMPETENCIES')) {
    repaired.CORE_COMPETENCIES = removeEmptyCompetencyCategories(upsertCompetencyCategories(repaired.CORE_COMPETENCIES, {}));
  }

  return repaired;
}

function defaultCertificationLine() {
  return 'Certified Ethical Hacker (CEH) | CCSM Level II | API Security Fundamentals (APISec University) | AWS Cloud Practitioner Essentials | Certified Support Professional Manager (TSIA)';
}

function ensureMetricTerm(value, term, { after = null } = {}) {
  const parts = String(value ?? '').split(/\s+\|\s+/).map(part => part.trim()).filter(Boolean);
  if (!parts.some(part => part.toLowerCase() === term.toLowerCase())) {
    const afterIndex = after
      ? parts.findIndex(part => after.test(part))
      : -1;
    if (afterIndex >= 0) parts.splice(afterIndex + 1, 0, term);
    else parts.push(term);
  }
  return parts.join(' | ');
}

function jdHas(jdText, pattern) {
  return pattern.test(String(jdText ?? ''));
}

function isSecuritySpecificTarget(planningContext = null, jdText = '') {
  const roleMode = planningContext?.roleMode || classifyResumeRole(jdText);
  if (['pre-sales-solutions-architecture', 'tam', 'cse', 'msp-compliance-delivery', 'startup-cs-builder'].includes(roleMode)) return true;
  return jdHas(jdText, /\b(cybersecurity|security architecture|endpoint|application control|allowlist|allowlisting|zero trust|siem|soc|ndr|edr|iam|xdr|mitre|nist|cis|cmmc)\b/i);
}

export function applyDeterministicStrategicRepairs(replacements, fields, { jdText = '', planningContext = null } = {}) {
  const repaired = { ...replacements };
  const jd = String(jdText ?? '');
  const roleMode = planningContext?.roleMode || classifyResumeRole(jd);
  const technicalCyber = jdHas(jd, /\b(sales engineer|solution engineer|pre-sales|presales|cybersecurity|endpoint|application control|allowlist|allowlisting|zero trust|security architecture|MITRE|NIST|CIS)\b/i);

  if (fields.includes('CERTIFICATIONS_LINE')) {
    repaired.CERTIFICATIONS_LINE = defaultCertificationLine();
  }

  if (fields.includes('METRICS_LINE')) {
    const keyAchievements = fields
      .filter(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field))
      .map(field => String(repaired[field] || ''))
      .join(' ');
    if (!TOP_THIRD_METRIC_RE.test(`${repaired.METRICS_LINE || ''} ${repaired.PROFESSIONAL_SUMMARY || ''} ${keyAchievements}`)) {
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '$55M ARR Portfolio (Peak)');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '98-100% Retention');
    }
  }

  if (technicalCyber && fields.includes('METRICS_LINE')) {
    repaired.METRICS_LINE = String(repaired.METRICS_LINE || '')
      .replace(/\$23M ARR Portfolio/i, '$55M ARR Portfolio (Peak)')
      .replace(/\$23M ARR portfolio/i, '$55M ARR Portfolio (Peak)')
      .replace(/\$55M ARR Portfolio \(peak\)/i, '$55M ARR Portfolio (Peak)')
      .replace(/98[–-]120% Retention Across Strategic Accounts/i, '98% GRR');
    if (!/\$55M ARR Portfolio/i.test(repaired.METRICS_LINE || '')) {
      repaired.METRICS_LINE = appendUniqueTerms(repaired.METRICS_LINE, ['$55M ARR Portfolio (Peak)']);
    }
    repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '120% NRR', { after: /\$55M ARR Portfolio/i });
  }

  if (roleMode === 'pre-sales-solutions-architecture' && fields.includes('TITLE_LINE')) {
    if (jdHas(jd, /\bapplication control|allowlist|allowlisting\b/i)) {
      repaired.TITLE_LINE = 'Senior Sales Engineer | Application Control & Allowlisting | Endpoint Security | Pre-Sales Architecture | Enterprise Cybersecurity';
    }
  }

  if (roleMode === 'startup-cs-builder') {
    if (fields.includes('TITLE_LINE') && !/startup|builder|process|threat hunting|behavioral/i.test(repaired.TITLE_LINE || '')) {
      repaired.TITLE_LINE = 'Customer Success Manager | Cybersecurity Startup CS Builder | Process Design, AI Workflow Scale & Threat Hunting';
    }
    if (fields.includes('METRICS_LINE')) {
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '87-Client CS Function Build');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '22% Retention Lift');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '30% Onboarding Reduction');
    }
    if (fields.includes('PROFESSIONAL_SUMMARY')) {
      const summary = String(repaired.PROFESSIONAL_SUMMARY || '');
      if (!/Total Trial Services|87 clients|22% retention|CS function/i.test(summary)) {
        const parts = summary.split(/(?<=\.)\s+/).filter(Boolean);
        const builderSentence = 'Built the CS motion at Total Trial Services across 87 clients and an 8-person team, improving retention 22% through onboarding consistency, satisfaction tracking, and escalation handling.';
        repaired.PROFESSIONAL_SUMMARY = [parts[0], parts[1], builderSentence]
          .filter(Boolean)
          .slice(0, 3)
          .join(' ');
      }
    }
    if (fields.includes('CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = upsertCompetencyCategories(repaired.CORE_COMPETENCIES, {
        'CS Builder': ['Process Design & Implementation', 'Scalable Onboarding Workflows', 'Strategic Business Reviews', 'Voice of Customer', 'Product & Engineering Feedback Loops', 'Sales Handoffs', 'Marketing Advocacy'],
        'AI & Workflow Automation': ['AI-Assisted Documentation', 'AI Workflow Automation', 'Support Documentation', 'Customer Communication Scaling'],
        'Security Domains': ['Threat Hunting', 'Behavioral Detection', 'Endpoint / Identity / Cloud Telemetry', 'Credential Misuse', 'Lateral Movement', 'Post-Access Activity'],
      });
    }
    const achievementFields = fields.filter(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
    const achievements = achievementFields.map(field => String(repaired[field] || '')).join(' ');
    if (achievementFields.length && !/Total Trial Services|87 clients|22% retention|CS function/i.test(achievements)) {
      const target = achievementFields.at(-1);
      repaired[target] = 'Built the CS function at Total Trial Services across 87 clients and an 8-person team, improving retention 22% through onboarding consistency and escalation handling.';
    }
  }

  if (roleMode === 'startup-commercial-cs-builder') {
    if (fields.includes('TITLE_LINE') && !/expansion|retention|churn|startup|physical security|IoT/i.test(repaired.TITLE_LINE || '')) {
      repaired.TITLE_LINE = 'Customer Success Manager | Startup CS Builder | Expansion, Retention & Churn Save | Physical Security / IoT Adjacency';
    }
    if (fields.includes('METRICS_LINE')) {
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '87-Client CS Function Build');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '22% Retention Lift');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '30% Onboarding Reduction');
    }
    if (fields.includes('PROFESSIONAL_SUMMARY')) {
      const summary = String(repaired.PROFESSIONAL_SUMMARY || '');
      const needsBuilder = !/Total Trial Services|87 clients|22% retention|CS function/i.test(summary);
      const needsCommercial = !/expansion|retention|churn save|renewal|account planning|AE/i.test(summary);
      const needsBridge = !/physical security|IoT|ops|facilities|security-chief|security chief/i.test(summary);
      if (needsBuilder || needsCommercial || needsBridge) {
        repaired.PROFESSIONAL_SUMMARY = 'Commercial Customer Success Manager with 22+ years building CS operating systems, owning retention and expansion outcomes, and translating technical customer needs into measurable adoption. Built the CS function at Total Trial Services across 87 clients and an 8-person team, improving retention 22% through onboarding consistency, satisfaction tracking, and escalation handling. Brings Securonix churn-save proof and ExtraHop enterprise renewal discipline to AI-powered physical security, IoT, IT, ops, and security-chief stakeholders.';
      }
    }
    if (fields.includes('CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = upsertCompetencyCategories(repaired.CORE_COMPETENCIES, {
        'Commercial CS': ['Expansion & Retention Ownership', 'Churn Save', 'Book of Business Management', 'AE Partnership', 'Account Planning', 'Renewal Motions', 'Pipedrive / CRM Hygiene'],
        'Startup Builder': ['CS Playbook Building', 'Proactive Outreach', 'QBRs', 'Voice of Customer', 'Product Feedback Loops', 'Cross-Functional Execution'],
        'Buyer Bridge': ['Physical Security / IoT Adjacency', 'Security Chiefs', 'IT Stakeholders', 'Ops / Facilities Leaders'],
      });
    }
    const achievementFields = fields.filter(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
    const achievements = achievementFields.map(field => String(repaired[field] || '')).join(' ');
    if (achievementFields.length && !/Total Trial Services|87 clients|22% retention|CS function/i.test(achievements)) {
      const target = achievementFields.at(-1);
      repaired[target] = 'Built the CS function at Total Trial Services across 87 clients and an 8-person team, improving retention 22% through onboarding consistency and escalation handling.';
    }
    if (achievementFields.length && !/100% renewal|three at-risk|3 at-risk|churn save|30% onboarding|81% ARR/i.test(achievementFields.map(field => String(repaired[field] || '')).join(' '))) {
      const target = achievementFields[Math.max(0, achievementFields.length - 2)];
      repaired[target] = 'Retained three at-risk Securonix accounts through churn-save escalation, sustained 100% renewal performance, cut onboarding 30%, and supported 81% ARR expansion.';
    }
  }

  if (roleMode === 'ai-customer-experience') {
    if (fields.includes('TITLE_LINE') && !/customer experience|AI platform|CXM/i.test(repaired.TITLE_LINE || '')) {
      repaired.TITLE_LINE = 'Senior Customer Experience Manager | Enterprise AI Platform Adoption | Strategic Account Leadership';
    }
    if (fields.includes('METRICS_LINE')) {
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '$55M ARR Portfolio (Peak)');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, 'Fortune 500 Onboarding');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '30% Onboarding Reduction');
    }
    if (fields.includes('PROFESSIONAL_SUMMARY')) {
      const summary = String(repaired.PROFESSIONAL_SUMMARY || '');
      if (!AI_CX_SIGNAL_RE.test(summary) || UNSUPPORTED_DIRECT_AI_CLAIM_RE.test(summary)) {
        repaired.PROFESSIONAL_SUMMARY = 'Strategic Customer Experience Manager with 22+ years leading enterprise SaaS onboarding, adoption, expansion, and executive stakeholder alignment across complex technical platforms. Translates telemetry, usage data, integration constraints, and quality signals into Product and Engineering feedback loops that improve customer outcomes. Brings Maven-relevant proof from McAfee\'s largest cloud-security onboarding, Securonix usage-data reviews, Auth0 workflow integrations, and ExtraHop CISO business cases without overstating direct LLM ownership.';
      }
    }
    if (fields.includes('CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = upsertCompetencyCategories(repaired.CORE_COMPETENCIES, {
        'AI Customer Experience': ['Enterprise AI Platform Adoption', 'Human-Centric AI Adoption', 'Quality / Usage Data Reviews', 'Consumption-Based Expansion'],
        'Implementation': ['Onboarding & Implementation Leadership', 'Multi-Department Workflow Integration', 'Enterprise SaaS Value Realization'],
        'Cross-Functional': ['Product & Engineering Feedback Loops', 'Strategic Relationship Management', 'Fortune 100/500 Stakeholder Management', 'Executive QBRs'],
      });
    }
    const achievementFields = fields.filter(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
    const achievements = achievementFields.map(field => String(repaired[field] || '')).join(' ');
    if (achievementFields.length && !/McAfee|largest cloud-security onboarding|Fortune\s*500|highest NPS/i.test(achievements)) {
      const target = achievementFields[2] || achievementFields.at(-1);
      repaired[target] = 'Led McAfee\'s largest cloud-security onboarding for Fortune 500 customers, coordinating complex rollout work and achieving the highest NPS score across the portfolio.';
    }
    if (achievementFields.length && !/usage data|Product(?:\s*&\s*| and )Engineering|field observations|30% onboarding/i.test(achievementFields.map(field => String(repaired[field] || '')).join(' '))) {
      const target = achievementFields[1] || achievementFields[0];
      repaired[target] = 'Converted Securonix usage data and field observations into Product and Engineering feedback loops while cutting onboarding time 30% and improving customer confidence.';
    }
    if (achievementFields.length && !/Auth0|IAM|integration|workflow integrations|production-scale/i.test(achievementFields.map(field => String(repaired[field] || '')).join(' '))) {
      const target = achievementFields.at(-1);
      repaired[target] = 'Guided Auth0 enterprise IAM workflow integrations across 14 accounts, aligning security and engineering stakeholders through deployment phases to production-scale value.';
    }
  }

  if (roleMode === 'customer-success') {
    const securityTarget = isSecuritySpecificTarget(planningContext, jd);
    if (COMMERCIAL_CS_JD_RE.test(jd) && fields.includes('METRICS_LINE')) {
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '$55M ARR Portfolio (Peak)');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '120% NRR');
      repaired.METRICS_LINE = ensureMetricTerm(repaired.METRICS_LINE, '98-100% Retention');
    }
    if (fields.includes('TITLE_LINE') && AI_CYBER_CS_JD_RE.test(jd) && securityTarget && !AI_CYBER_CS_RESUME_RE.test(repaired.TITLE_LINE || '')) {
      repaired.TITLE_LINE = 'Enterprise Customer Success Manager | AI & Cybersecurity SaaS | NRR, Renewals & Expansion';
    }
    if (fields.includes('PROFESSIONAL_SUMMARY')) {
      const summary = String(repaired.PROFESSIONAL_SUMMARY || '');
      const needsCommercial = COMMERCIAL_CS_JD_RE.test(jd) && !COMMERCIAL_CS_RESUME_RE.test(summary);
      const needsCadence = EXECUTIVE_DEMO_CS_JD_RE.test(jd) && !EXECUTIVE_DEMO_CS_RESUME_RE.test(summary);
      const needsPortfolio = PORTFOLIO_CS_JD_RE.test(jd) && !PORTFOLIO_CS_RESUME_RE.test(`${repaired.METRICS_LINE || ''} ${summary}`);
      if (needsCommercial || needsCadence || needsPortfolio) {
        repaired.PROFESSIONAL_SUMMARY = securityTarget
          ? 'Enterprise cybersecurity Customer Success operator owning named-account portfolios, NRR, renewal execution, expansion discovery, and executive adoption outcomes across complex security environments. Presents technical value narratives, solution demonstrations, and deployment health findings to CISO, security, and business stakeholders through QBRs, risk reviews, and escalation plans. Builds repeatable success motions that turn account health into renewals, upsell and cross-sell opportunities, advocacy, and durable ARR growth.'
          : 'Enterprise Customer Success operator owning named-account portfolios, NRR, renewal execution, expansion discovery, and executive adoption outcomes across complex SaaS environments. Presents value narratives, solution demonstrations, and account-health findings to executive and business stakeholders through QBRs, risk reviews, and escalation plans. Builds repeatable success motions that turn customer health into renewals, upsell and cross-sell opportunities, advocacy, and durable ARR growth.';
      }
    }
    if (fields.includes('CORE_COMPETENCIES')) {
      const additions = {};
      if (COMMERCIAL_CS_JD_RE.test(jd) || PORTFOLIO_CS_JD_RE.test(jd)) {
        additions['Commercial CS'] = ['Named Account Portfolio Management', 'NRR / GRR Ownership', 'Renewal Execution', 'Upsell / Cross-Sell Discovery', 'ARR Growth', 'Executive QBRs'];
      }
      if (EXECUTIVE_DEMO_CS_JD_RE.test(jd)) {
        additions['Customer Health'] = ['Deployment Health Checks', 'Account Health Risk Management', 'Risk Action Plans', 'Escalation Management', 'Value Realization'];
        additions['Technical Advisory'] = securityTarget
          ? ['CISO Presentations', 'Solution Demonstrations', 'Cyber Threat Defense Use Cases', 'NDR / SIEM / XDR / IAM Advisory']
          : ['Executive Presentations', 'Solution Demonstrations', 'Business Outcome Narratives'];
      }
      if (MENTORSHIP_CS_JD_RE.test(jd)) {
        additions['Team Enablement'] = ['CSM Mentorship', 'Best-Practice Sharing', 'New Team Member Ramp', 'CS Playbook Development'];
      }
      if (Object.keys(additions).length) {
        repaired.CORE_COMPETENCIES = upsertCompetencyCategories(repaired.CORE_COMPETENCIES, additions);
      }
    }
    if (MENTORSHIP_CS_JD_RE.test(jd)) {
      const fullText = fields.map(field => String(repaired[field] || '')).join(' ');
      if (!MENTORSHIP_CS_RESUME_RE.test(fullText)) {
        const achievementFields = fields.filter(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
        const target = achievementFields.at(-1);
        if (target) {
          repaired[target] = 'Built repeatable CS playbooks and team operating standards across enterprise portfolios, improving ramp, onboarding consistency, escalation handling, and renewal execution.';
        }
      }
    }
  }

  if (fields.includes('PROFESSIONAL_SUMMARY') && technicalCyber) {
    const summary = String(repaired.PROFESSIONAL_SUMMARY || '').trim();
    const sentence = 'Maps endpoint protection, application control, allowlisting, and Zero Trust requirements into practical deployment strategy for security operations, IT, and executive stakeholders.';
    if (jdHas(jd, /\bapplication control|allowlist|allowlisting|zero trust\b/i) && !/allowlist|allowlisting/i.test(summary)) {
      const parts = summary.split(/(?<=\.)\s+/).filter(Boolean);
      repaired.PROFESSIONAL_SUMMARY = [parts[0], sentence, ...parts.slice(1)]
        .filter(Boolean)
        .slice(0, 3)
        .join(' ');
    }
  }

  if (fields.includes('CORE_COMPETENCIES')) {
    repaired.CORE_COMPETENCIES = upsertCompetencyCategories(repaired.CORE_COMPETENCIES, {
      'Security Domains': [
        ...(jdHas(jd, /\ballowlist|allowlisting\b/i) ? ['Application Allowlisting'] : []),
        ...(jdHas(jd, /\bCIS\b/i) ? ['CIS Controls'] : []),
        ...(jdHas(jd, /\bmalware|ransomware\b/i) ? ['Malware & Ransomware Prevention'] : []),
      ],
      'GTM/CS Platforms': [
        ...(jdHas(jd, /\bPOC|proof-of-concept|proof of concept\b/i) ? ['POC Conversion & Success Metrics'] : []),
        ...(jdHas(jd, /\bwin rate|win rates|sales team enablement\b/i) ? ['Sales Cycle Win Rate Contribution'] : []),
      ],
    });
  }

  if (roleMode === 'strategic-cs-leadership') {
    for (const field of fields) {
      if (Object.hasOwn(repaired, field)) repaired[field] = softenStrategicCsLanguage(repaired[field]);
    }
    if (fields.includes('CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = removeEmptyCompetencyCategories(repaired.CORE_COMPETENCIES);
    }
  }
  if (!isSecuritySpecificTarget(planningContext, jd)) {
    for (const field of fields) {
      if (Object.hasOwn(repaired, field)) repaired[field] = softenTransferableLanguage(repaired[field]);
    }
    if (fields.includes('CORE_COMPETENCIES')) {
      repaired.CORE_COMPETENCIES = removeEmptyCompetencyCategories(repaired.CORE_COMPETENCIES);
    }
  }

  if (roleMode === 'pre-sales-solutions-architecture' && jdHas(jd, /\bPOC|proof-of-concept|proof of concept\b/i)) {
    const achievementFields = fields.filter(field => /^KEY_ACHIEVEMENT_\d+$/i.test(field));
    const achievements = achievementFields.map(field => String(repaired[field] || '')).join(' ');
    if (achievementFields.length && !/\bPOC|proof-of-concept|proof of concept\b/i.test(achievements)) {
      const target = achievementFields[achievementFields.length - 1];
      repaired[target] = 'Led POC-style technical evaluations across enterprise NDR and SIEM engagements, defining success criteria with security engineering and IT stakeholders.';
    }
  }

  return applyRoleSectionIntegrityRepairs(repaired, fields);
}

export function applyDeterministicQualityRepairs(replacements, fields, issues = [], roleMode = 'customer-success') {
  const failedFields = qualityIssueFields(issues)
    .filter(field => fields.includes(field));
  if (!failedFields.length) return replacements;

  const repaired = { ...replacements };
  for (const field of failedFields) {
    if (/^JOB_\d+_BULLET_\d+$/i.test(field)) {
      const fieldIssues = issues.filter(issue => String(issue).startsWith(`${field}:`));
      repaired[field] = forceBulletQuality(
        strengthenBulletFallback(field, repaired[field], roleMode),
        fieldIssues,
        roleMode,
      );
    } else if (/^JOB_\d+_CONTEXT$/i.test(field)) {
      repaired[field] = strengthenContextFallback(repaired[field], roleMode);
    } else if (/^KEY_ACHIEVEMENT_\d+$/i.test(field)) {
      repaired[field] = strengthenAchievementFallback(repaired[field]);
    } else {
      repaired[field] = sanitizeResumeLanguage(repaired[field]);
    }
  }
  return repaired;
}

export function rescueQualityUntilStable(replacements, fields, roleMode = 'customer-success', maxAttempts = 3) {
  let repaired = sanitizeReplacementSet(replacements, fields);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      validateResumeQuality(repaired, fields);
      return repaired;
    } catch (err) {
      const next = sanitizeReplacementSet(
        applyDeterministicQualityRepairs(repaired, fields, err.issues ?? [], roleMode),
        fields,
      );
      if (JSON.stringify(next) === JSON.stringify(repaired)) throw err;
      repaired = next;
    }
  }
  validateResumeQuality(repaired, fields);
  return repaired;
}

const MIN_SUMMARY_WORDS = 45; // validateResumeQuality floor; the synthesis prompt targets 60-85 words / 3 sentences

/**
 * One targeted local repair for a PROFESSIONAL_SUMMARY below the quality
 * floor (small local models sometimes return 2 short sentences). Exactly one
 * LM Studio call, never a loop. The rewrite is accepted only if it meets the
 * word/sentence rules, has no banned phrasing, and every factual token
 * (numbers, names, titles, credentials) is found in the candidate evidence,
 * JD, or existing resume fields. Otherwise the original is kept and the
 * normal quality gate decides.
 */
export async function repairThinSummary(replacements, { candidateTruth = '', jdText = '', log = () => {}, notify = () => {} } = {}) {
  const current = String(replacements?.PROFESSIONAL_SUMMARY ?? '').trim();
  if (!current || wordCount(current) >= MIN_SUMMARY_WORDS || !localAiEnabled()) return replacements;

  const otherFields = Object.fromEntries(Object.entries(replacements).filter(([field]) => field !== 'PROFESSIONAL_SUMMARY'));
  const currentSentences = current.split(/[.!?]+/).map(part => part.trim()).filter(Boolean);
  // Small local models follow "add one 18-28 word sentence" far more reliably
  // than a total word target, so extend a 1-2 sentence summary by one
  // sentence; rewrite only when it already has 3 sentences.
  const addSentence = currentSentences.length < 3;
  const evidence = `JOB DESCRIPTION:
${String(jdText).slice(0, 2500)}

CANDIDATE SOURCE TRUTH:
${String(candidateTruth).slice(0, 5000)}

CURRENT RESUME FIELDS:
${JSON.stringify({ PROFESSIONAL_SUMMARY: current, ...otherFields }).slice(0, 4000)}`;
  const rules = 'Use ONLY facts stated in the CANDIDATE SOURCE TRUTH or CURRENT RESUME FIELDS below. Do not add employers, titles, years of experience, certifications, products, or metrics that are not stated there. No em dashes.';
  const prompt = withHumanizer(addSentence
    ? `Write ONE additional sentence of 18-28 words to append to this resume summary. It must add new supported proof (scope, outcomes, or JD-relevant strengths) without repeating the existing sentences. ${rules} Return strict JSON only: {"SENTENCE": "..."}\n\nSUMMARY:\n${current}\n\n${evidence}`
    : `Rewrite PROFESSIONAL_SUMMARY as exactly 3 sentences, each 18-28 words. ${rules} Mirror the job description's language where the evidence supports it. Return strict JSON only: {"PROFESSIONAL_SUMMARY": "..."}\n\n${evidence}`);

  notify('summary-repair', 'running', 'LM Studio', `Summary is ${wordCount(current)} words; one local ${addSentence ? 'extension' : 'rewrite'}`);
  let candidate = '';
  try {
    const message = await localAiClient.messages.create({ max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
    const parsed = JSON.parse(stripJsonFence(message.content[0]?.text));
    const generated = sanitizeResumeLanguage(String((addSentence ? parsed?.SENTENCE : parsed?.PROFESSIONAL_SUMMARY) ?? '').trim());
    candidate = addSentence && generated ? `${current.replace(/\s*$/, '')} ${generated}`.trim() : generated;
  } catch (err) {
    log('summary-repair', `kept original (LM Studio error: ${err.message.slice(0, 80)})`);
    return replacements;
  }

  const sentences = candidate.split(/[.!?]+/).map(part => part.trim()).filter(Boolean);
  const unsupported = findUnsupportedFactualClaims(candidate, [candidateTruth, jdText, ...Object.values(replacements).map(String)]);
  const problems = [
    wordCount(candidate) < MIN_SUMMARY_WORDS ? `${wordCount(candidate)} words` : '',
    sentences.length > 3 ? `${sentences.length} sentences` : '',
    BANNED_PHRASE_RE.test(candidate) ? 'banned phrasing' : '',
    unsupported.length ? `unsupported: ${unsupported.slice(0, 5).join(', ')}` : '',
  ].filter(Boolean);
  if (problems.length) {
    log('summary-repair', `kept original (rewrite rejected: ${problems.join('; ')})`);
    notify('summary-repair', 'done', 'Local', 'Summary rewrite rejected; original kept');
    return replacements;
  }
  log('summary-repair', `done (${wordCount(current)} -> ${wordCount(candidate)} words)`);
  notify('summary-repair', 'done', 'LM Studio', `Summary expanded to ${wordCount(candidate)} words`);
  return { ...replacements, PROFESSIONAL_SUMMARY: candidate };
}

async function repairQualityIssues(replacements, fields, issues, log, notify = () => {}, roleMode = 'customer-success') {
  const failedFields = qualityIssueFields(issues)
    .filter(field => fields.includes(field));
  if (!failedFields.length) return replacements;

  let repaired = applyDeterministicQualityRepairs(replacements, fields, issues, roleMode);
  try {
    validateResumeQuality(repaired, fields);
    log('quality-repair', `repaired locally (${failedFields.length} fields)`);
    notify('quality-repair', 'done', 'Local', `${failedFields.length} bullets repaired locally`);
    return repaired;
  } catch {
    // Escalate only when deterministic repair is not enough.
  }

  if (!localAiEnabled()) {
    log('quality-repair', `fallback (${failedFields.length} fields)`);
    notify('quality-repair', 'done', 'Local', `${failedFields.length} bullets repaired`);
    return repaired;
  }

  try {
    const client = localAiClient;
    const model = localResumeModel();
    const prompt = withHumanizer(`Repair only the listed resume fields so they pass the quality gate while preserving only facts already present in each field. Keep bullets concise and impact-oriented. Every job bullet must include enterprise/stakeholder proof, JD-relevant domain or customer-outcome language, and a concrete mechanism. Remove banned phrases, em dashes, "Responsible for", "provided support", and support-first framing. Do not invent employers, dates, certifications, product names, or exact metrics. Return strict JSON mapping field names to repaired text only.\n\nFAILED ISSUES:\n${issues.join('\n')}\n\nFIELDS:\n${JSON.stringify(Object.fromEntries(failedFields.map(field => [field, repaired[field]])))}`);

    notify('quality-repair', 'running', 'LM Studio', `Repairing ${failedFields.length} bullets · ${model}`);
    const message = await client.messages.create({
      model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    repaired = { ...repaired, ...JSON.parse(cleaned) };
    repaired = sanitizeReplacementSet(repaired, failedFields);
    repaired = applyDeterministicQualityRepairs(repaired, fields, issues, roleMode);
    repaired = rescueQualityUntilStable(repaired, fields, roleMode);
    log('quality-repair', `done (${failedFields.length} fields)`);
    notify('quality-repair', 'done', 'LM Studio', `${failedFields.length} bullets repaired`);
    return repaired;
  } catch (err) {
    log('quality-repair', `fallback after LM Studio error (${err.message.slice(0, 60)})`);
    notify('quality-repair', 'done', 'Local', `${failedFields.length} bullets repaired locally`);
    return repaired;
  }
}

async function finalStrategicReviewAndRepair(replacements, fields, { jdText = '', candidateTruth = '', planningContext = null, log, notify = () => {} } = {}) {
  let repaired = applyDeterministicStrategicRepairs(replacements, fields, { jdText, planningContext });
  if (!localAiEnabled()) {
    log?.('final-review', 'local deterministic repair');
    notify('final-review', 'done', 'Local', 'Strategic review applied locally');
    return repaired;
  }

  try {
    const client = localAiClient;
    const model = localResumeModel();
    const prompt = withHumanizer(`Act as the final hiring-manager resume reviewer before DOCX creation. Compare the finished resume fields against the JD and return only strategic field repairs that would make the resume top 1% for this exact role.

MANDATORY REVIEW CHECKS:
- Apply the five resume improvement principles: measurable results, JD tailoring, strong above-fold proof, clear impact bullets, and clutter removal.
- Apply the top-1% applicant principles: evidence density, judgment over activity, role-business-model fit, hard-to-copy accomplishments, and final hiring-manager rejection lens.
- Reject or repair bullets that a generic strong applicant could copy by changing the company name; preserve only accomplishments with specific systems, workflows, playbooks, decisions, governance, customer motions, or measurable operating proof.
- The finished DOCX must be a full, dense 2-page resume only. Add substantive, source-supported detail if the content is sparse. Do not create a third page.
- No duplicate Tools & Platforms section. CORE_COMPETENCIES is the single skills/platform section.
- TITLE_LINE must mirror the JD's function and strongest domain language.
- METRICS_LINE must use Brian's strongest truthful enterprise scale when relevant, including $55M ARR Portfolio (peak) for enterprise cybersecurity Sales Engineer roles.
- For strategic Customer Success leadership JDs, the resume must lead with executive engagement, customer health, adoption, value realization, customer planning, operating models, cross-functional influence, and people leadership rather than cybersecurity tooling.
- For startup CSM builder JDs, the resume must lead with hands-on process design, scalable onboarding/support workflows, AI-assisted documentation or workflow scale only when source-supported, cross-functional Product/Engineering/Sales/Marketing coordination, Voice of Customer, onsite SBR/workshop readiness, and Total Trial Services CS-function-building proof. Do not bury the 87-client / 8-direct-report / 22% retention improvement story when the JD asks to build from the ground up.
- For AI-native Customer Experience Manager JDs, the resume must read like enterprise AI platform adoption and customer-experience leadership: onboarding/implementation, adoption and consumption, quality/usage-data reviews, Product/Engineering feedback loops, multi-department workflow integration, Fortune 100/500 stakeholder proof, McAfee largest-cloud-security onboarding, Securonix usage-data proof, Auth0 integration complexity, and ExtraHop telemetry business cases. Do not claim direct LLM, prompt-tuning, training-data, conversational-AI, AI-agent, or customer-deployed AI workflow ownership unless the source truth provides concrete proof.
- PROFESSIONAL_SUMMARY must include the top supported JD domain terms when they are central to the role, such as application control, allowlisting, endpoint security, Zero Trust, POC, RFP/RFI, MITRE, NIST, CIS, Active Directory, Windows, APIs, integrations, and cloud platforms.
- For threat-hunting platform JDs, PROFESSIONAL_SUMMARY and CORE_COMPETENCIES must include supported/adjacent language for threat hunting, behavioral detection, endpoint / identity / cloud telemetry, credential misuse, lateral movement, post-access activity, NDR, SIEM, UEBA, and investigation workflows without inventing direct Nebulock experience.
- CORE_COMPETENCIES must naturally include missing supported JD keywords, especially application allowlisting, CIS Controls, POC conversion/success metrics, sales cycle win-rate contribution, malware/ransomware prevention, RFP/RFI, Active Directory, Windows, APIs, integrations, and cloud platforms when relevant.
- For non-security strategic CS leadership JDs, CORE_COMPETENCIES should become a concise CS leadership list and should downrank vendor/security inventories unless the JD explicitly values them.
- KEY_ACHIEVEMENTS must include a POC / technical evaluation / technical sales campaign achievement when the JD heavily emphasizes POC leadership and the candidate history supports technical evaluations, sales engineering, deployment validation, demos, discovery, or architecture advisory.
- ExtraHop and Securonix bullets must read as pre-sales technical advisory / solution architecture for Sales Engineer JDs, not post-sale CS management.
- CERTIFICATIONS_LINE must lead with Certified Ethical Hacker (CEH) for technical cybersecurity, endpoint, application control, Zero Trust, or security architecture roles.
- Preserve exact held titles. Do not invent employers, dates, exact metrics, certifications, tools, or experience not supported by the source truth. If a JD term is adjacent but not directly supported, use honest proximity language.

Return strict JSON mapping only existing field names to repaired text. Omit fields that do not need changes. No explanation.

ROLE MODE:
${planningContext?.roleMode || ''}

SECTION PLAN:
${JSON.stringify(planningContext?.sectionPlan ?? {}, null, 2)}

JOB DESCRIPTION:
${String(jdText || '').slice(0, 5000)}

CANDIDATE SOURCE TRUTH:
${String(candidateTruth || '').slice(0, 6500)}

CURRENT RESUME FIELDS:
${JSON.stringify(Object.fromEntries(fields.map(field => [field, repaired[field] ?? ''])), null, 2)}`);

    notify('final-review', 'running', 'LM Studio', `Final strategic review · ${model}`);
    const message = await client.messages.create({
      model,
      max_tokens: 2200,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    const allowed = Object.fromEntries(
      Object.entries(parsed)
        .filter(([field, value]) => fields.includes(field) && typeof value === 'string' && value.trim())
    );
    repaired = sanitizeReplacementSet({ ...repaired, ...allowed }, fields);
    repaired = applyDeterministicStrategicRepairs(repaired, fields, { jdText, planningContext });
    log?.('final-review', `done (${Object.keys(allowed).length} fields)`);
    notify('final-review', 'done', 'LM Studio', `${Object.keys(allowed).length} strategic fields repaired`);
    return repaired;
  } catch (err) {
    log?.('final-review', `local repair after LM Studio error (${err.message.slice(0, 80)})`);
    notify('final-review', 'done', 'Local', 'Strategic review applied locally');
    return repaired;
  }
}

export function buildResumeDebugStats(replacements, fields, { pageCount = null } = {}) {
  const bulletFields = fields.filter((field) => /^JOB_\d+_BULLET_\d+$/i.test(field));
  const bullets = bulletFields.map((field) => String(replacements[field] ?? '').trim()).filter(Boolean);
  const wordCounts = bullets.map(wordCount);
  const charCounts = bullets.map((bullet) => bullet.length);
  const avg = (values) => values.length
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
    : 0;
  const weakBulletCount = bullets.filter((bullet) =>
    wordCount(bullet) < 15 ||
    !PROOF_RE.test(bullet) ||
    !DOMAIN_RE.test(bullet) ||
    hasWeakGenericShape(bullet)
  ).length;
  const estimatedDensity = charCounts.reduce((sum, value) => sum + value, 0);

  return {
    bulletCount: bullets.length,
    avgBulletWordCount: avg(wordCounts),
    avgBulletCharacterCount: avg(charCounts),
    weakBulletCount,
    pageCount,
    estimatedDensity,
  };
}

export function isPdfExportEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.RESUME_PDF_EXPORT ?? '0'));
}

function isPageValidationEnabled() {
  return !/^(0|false|no)$/i.test(String(process.env.RESUME_PAGE_VALIDATION ?? '1'));
}

export function classifyResumeLayout({ pageCount, pages = [] } = {}) {
  const lastPage = pages.at(-1) ?? null;
  const secondPage = pages[1] ?? null;
  const secondPageFillRatio = secondPage?.fillRatio ?? null;
  const renderedWords = pages.reduce((sum, page) => sum + Number(page?.wordCount || 0), 0);
  if (!pageCount) return { status: 'unknown', pageCount, secondPageFillRatio, lastPage, renderedWords };
  if (pageCount > 2) return { status: 'overflow', pageCount, secondPageFillRatio, lastPage, renderedWords };
  if (pageCount < 2) return { status: 'underfilled', pageCount, secondPageFillRatio, lastPage, renderedWords };
  if ((secondPageFillRatio ?? 0) < MIN_FULL_SECOND_PAGE_RATIO) {
    return { status: 'underfilled', pageCount, secondPageFillRatio, lastPage, renderedWords };
  }
  if (renderedWords > MAX_RENDERED_RESUME_WORDS) {
    return { status: 'overflow', pageCount, secondPageFillRatio, lastPage, renderedWords };
  }
  return { status: 'fit', pageCount, secondPageFillRatio, lastPage, renderedWords };
}

async function getRenderedLayout(docxPath) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-page-check-'));
  try {
    const pdfPath = await docxToPdf(docxPath, tempDir);
    const [pageCount, pages] = await Promise.all([
      getPdfPageCount(pdfPath),
      getPdfPageMetrics(pdfPath),
    ]);
    return { pageCount, pages, ...classifyResumeLayout({ pageCount, pages }) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function selectPageFitFields(fields, layoutStatus) {
  if (layoutStatus === 'underfilled') return fields;
  const lowPriority = fields.filter(field =>
    /^JOB_[1-9]_/.test(field) ||
    field === 'CORE_COMPETENCIES'
  );
  return lowPriority.length >= 6 ? lowPriority : fields;
}

function clipAtWord(value, maxChars) {
  const text = String(value ?? '').trim();
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars + 1).replace(/\s+\S*$/, '').replace(/[,:;]+$/, '');
  return `${clipped}.`;
}

function overflowBudgets(attempt = 1) {
  if (attempt >= 3) {
    return {
      competencies: 430,
      summary: 430,
      achievement: 185,
      context: 125,
      recentBullet: 190,
      recentLowPriorityBullet: 180,
      olderBullet: 150,
    };
  }
  if (attempt === 2) {
    return {
      competencies: 480,
      summary: 470,
      achievement: 205,
      context: 135,
      recentBullet: 205,
      recentLowPriorityBullet: 185,
      olderBullet: 160,
    };
  }
  return {
    competencies: 520,
    summary: 520,
    achievement: 220,
    context: 145,
    recentBullet: 220,
    recentLowPriorityBullet: 185,
    olderBullet: 170,
  };
}

export function compactOverflowFields(replacements, fields, attempt = 1) {
  const budgets = overflowBudgets(attempt);
  const repaired = { ...replacements };
  for (const field of fields) {
    const value = String(repaired[field] ?? '');
    let next = value
      .replace(GENERATED_SECURITY_STAKEHOLDER_ARTIFACT_RE, '')
      .replace(/,\s*across enterprise cybersecurity stakeholders using documented deployment criteria and measurable security outcomes\.?/gi, '.')
      .replace(/,\s*using stakeholder alignment, use-case scoping, and measurable security outcomes\.?/gi, '.')
      .replace(/\s+then handed the risk signal process to the broader CS team as a repeatable playbook/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const redundancyReduced = next;
    if (field === 'CORE_COMPETENCIES') next = clipAtWord(next, budgets.competencies);
    else if (field === 'PROFESSIONAL_SUMMARY') next = clipAtWord(next, budgets.summary);
    else if (/^KEY_ACHIEVEMENT_\d+$/.test(field)) next = clipAtWord(next, budgets.achievement);
    else if (/^JOB_[1-9]_CONTEXT$/.test(field)) next = clipAtWord(next, budgets.context);
    else if (/^JOB_[5-9]_BULLET_/.test(field)) next = clipAtWord(next, budgets.olderBullet);
    else if (/^JOB_[3-9]_BULLET_[3-9]$/.test(field)) next = clipAtWord(next, budgets.recentLowPriorityBullet);
    else if (/^JOB_[1-9]_BULLET_/.test(field)) next = clipAtWord(next, budgets.recentBullet);

    try {
      validateResumeQuality({ [field]: next }, [field]);
      repaired[field] = next;
    } catch {
      try {
        validateResumeQuality({ [field]: redundancyReduced }, [field]);
        repaired[field] = redundancyReduced;
      } catch {
        if (/^JOB_\d+_BULLET_\d+$/i.test(field)) {
          try {
            const rescued = forceBulletQuality(strengthenBulletFallback(field, next), [
              `${field}: bullet lacks metric, enterprise scope, or stakeholder proof`,
              `${field}: bullet reads like generic activity rather than differentiated impact`,
            ]);
            validateResumeQuality({ [field]: rescued }, [field]);
            repaired[field] = rescued;
          } catch {
            repaired[field] = value;
          }
        } else {
          repaired[field] = value;
        }
      }
    }
  }
  return repaired;
}

async function repairForLayout(replacements, fields, layout, { jdText = '', candidateTruth = '', planningContext = null, log, notify = () => {} } = {}) {
  if (!localAiEnabled() || !layout?.pageCount || layout.status === 'fit') return replacements;
  try {
    const client = localAiClient;
    const model = localResumeModel();
    const direction = layout.status === 'overflow'
      ? 'shorten enough to fit exactly 2 full pages'
      : 'add substantive source-supported detail until page 2 is materially full';
    const editableFields = selectPageFitFields(fields, layout.status);
    const prompt = withHumanizer(`Repair these resume fields to ${direction}. The rendered DOCX is currently ${layout.pageCount} page(s). Page 2 fill ratio is ${layout.secondPageFillRatio ?? 'unknown'} and rendered word count is ${layout.renderedWords ?? 'unknown'}. The final resume must be exactly 2 full pages with page 2 fill ratio at least ${MIN_FULL_SECOND_PAGE_RATIO} and Word-safe density at or below ${MAX_RENDERED_RESUME_WORDS} rendered words.

RULES:
- Preserve role strategy, strongest JD alignment, exact held titles, and source-truth constraints.
- For 3+ pages, remove redundancy first: duplicated sub-header text, repeated keyword lists, padded clauses, and low-value filler. Keep differentiated evidence and metrics.
- For underfilled resumes, add only real source-supported detail.
- Only edit the listed editable fields. Do not rewrite the whole resume.
- Keep CORE_COMPETENCIES category-structured and non-duplicative.
- Return strict JSON mapping existing field names to revised text only. No explanation.

ROLE MODE:
${planningContext?.roleMode || ''}

JOB DESCRIPTION:
${String(jdText || '').slice(0, 4000)}

CANDIDATE SOURCE TRUTH:
${String(candidateTruth || '').slice(0, 6000)}

EDITABLE FIELDS:
${JSON.stringify(Object.fromEntries(editableFields.map(field => [field, replacements[field] ?? ''])), null, 2)}`);
    notify('page-fit', 'running', 'LM Studio', `Repairing ${layout.status} resume to full 2 pages · ${model}`);
    const message = await client.messages.create({
      model,
      max_tokens: 2600,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    const allowed = Object.fromEntries(
      Object.entries(parsed)
        .filter(([field, value]) => editableFields.includes(field) && typeof value === 'string' && value.trim())
    );
    let repaired = sanitizeReplacementSet({ ...replacements, ...allowed }, fields);
    repaired = applyDeterministicStrategicRepairs(repaired, fields, { jdText, planningContext });
    log?.('page-fit', `done (${Object.keys(allowed).length} fields)`);
    notify('page-fit', 'done', 'LM Studio', `${layout.status} layout repaired toward full 2 pages`);
    return repaired;
  } catch (err) {
    log?.('page-fit', `skipped after LM Studio error (${err.message.slice(0, 80)})`);
    notify('page-fit', 'done', 'Local', 'Page-fit repair unavailable');
    return replacements;
  }
}

async function fitResumeToTwoPages({
  replacements,
  fields,
  docxPath,
  templatePath,
  jdText = '',
  candidateTruth = '',
  planningContext = null,
  log,
  notify = () => {},
}) {
  let fitted = replacements;
  let unreplaced = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let layout = await getRenderedLayout(docxPath);
    if (layout.status === 'fit') return { replacements: fitted, unreplaced, pageCount: layout.pageCount, layout };
    if (!layout.pageCount) throw new Error('Rendered page count unavailable; final output must be exactly 2 full pages');

    if (attempt === 1 && layout.status === 'overflow') {
      tightenDocxLayout(docxPath);
      layout = await getRenderedLayout(docxPath);
      log?.('page-fit', `tightened layout before content repair (${layout.pageCount} page(s), page2 fill=${layout.secondPageFillRatio ?? 'n/a'}, words=${layout.renderedWords ?? 'n/a'})`);
      if (layout.status === 'fit') return { replacements: fitted, unreplaced, pageCount: layout.pageCount, layout };
    }

    if (layout.status === 'overflow' && attempt > 1) {
      // A content repair overshot. Shrink deterministically instead of asking
      // the model to shorten again (small local models oscillate).
      const trimmed = await trimOverflowLocally({ replacements: fitted, fields, docxPath, templatePath, planningContext, log });
      if (trimmed) return trimmed;
    }
    if (layout.status === 'overflow') fitted = compactOverflowFields(fitted, fields, attempt);
    fitted = await repairForLayout(fitted, fields, layout, {
      jdText,
      candidateTruth,
      planningContext,
      log,
      notify,
    });
    fitted = sanitizeReplacementSet(fitted, fields);

    try {
      validateResumeQuality(fitted, fields);
    } catch (err) {
      fitted = await repairQualityIssues(fitted, fields, err.issues ?? [], log, notify, planningContext?.roleMode);
      fitted = sanitizeReplacementSet(fitted, fields);
      if (layout.status === 'overflow') fitted = compactOverflowFields(fitted, fields, attempt);
      try {
        validateResumeQuality(fitted, fields);
      } catch (repairErr) {
        fitted = applyDeterministicQualityRepairs(fitted, fields, repairErr.issues ?? []);
        fitted = sanitizeReplacementSet(fitted, fields);
        validateResumeQuality(fitted, fields);
      }
    }

    ({ unreplaced } = patchDocx(templatePath, fitted, docxPath));
    log?.('page-fit', `attempt ${attempt} repatched after ${layout.status} render (${layout.pageCount} page(s), page2 fill=${layout.secondPageFillRatio ?? 'n/a'}, words=${layout.renderedWords ?? 'n/a'})`);
  }

  const finalCheck = await getRenderedLayout(docxPath);
  if (finalCheck.status === 'fit') {
    return { replacements: fitted, unreplaced, pageCount: finalCheck.pageCount, layout: finalCheck };
  }
  throw new Error(`Rendered resume layout is ${finalCheck.status} (${finalCheck.pageCount ?? 'unknown'} page(s), page 2 fill ${finalCheck.secondPageFillRatio ?? 'unknown'}, ${finalCheck.renderedWords ?? 'unknown'} words); final output must be exactly 2 full pages with Word-safe density`);
}

/**
 * Bounded deterministic overflow fix: drop the lowest-priority selected
 * bullet, tighten, re-render, until the layout fits. Stops (returns null)
 * as soon as the layout is no longer overflowing without fitting, or no
 * removable bullets remain. Same strict 2-full-page acceptance.
 */
async function trimOverflowLocally({ replacements, fields, docxPath, templatePath, planningContext, log }) {
  const trimmed = { ...replacements };
  const maxDrops = selectedBulletEntries(trimmed).length;
  for (let drops = 0; drops < maxDrops; drops += 1) {
    const drop = lowestPrioritySelectedBullet(trimmed, planningContext);
    if (!drop) return null;
    trimmed[drop.field] = '';
    const { unreplaced } = patchDocx(templatePath, trimmed, docxPath);
    tightenDocxLayout(docxPath);
    const layout = await getRenderedLayout(docxPath);
    log?.('page-fit', `trimmed ${drop.field} locally (${layout.status}, ${layout.pageCount ?? 'unknown'} page(s), page2 fill=${layout.secondPageFillRatio ?? 'n/a'}, words=${layout.renderedWords ?? 'n/a'})`);
    if (layout.status === 'fit') return { replacements: trimmed, unreplaced, pageCount: layout.pageCount, layout };
    if (layout.status !== 'overflow') return null;
  }
  return null;
}

function selectedBulletEntries(replacements) {
  return Object.entries(replacements)
    .filter(([field, value]) => /^JOB_\d+_BULLET_\d+$/i.test(field) && String(value ?? '').trim())
    .map(([field, text]) => ({
      field,
      text,
      roleIndex: Number(field.match(/^JOB_(\d+)_/)?.[1] ?? 99),
    }));
}

function protectedBulletReason(item, planningContext) {
  const mode = planningContext?.roleMode || '';
  const text = String(item?.text ?? '');
  if (['startup-cs-builder', 'startup-commercial-cs-builder'].includes(mode)
    && /\b(Total Trial Services|87 clients|22% retention|CS function|8-person|8 direct reports)\b/i.test(text)) {
    return 'startup-builder-proof';
  }
  if (mode === 'startup-commercial-cs-builder'
    && /\b(100% renewal|three at-risk|3 at-risk|churn save|30% onboarding|81% ARR)\b/i.test(text)) {
    return 'commercial-churn-save-proof';
  }
  if (mode === 'customer-success') {
    const jd = String(planningContext?.jdText ?? '');
    if (COMMERCIAL_CS_JD_RE.test(jd) && COMMERCIAL_CS_RESUME_RE.test(text)) {
      return 'commercial-cs-proof';
    }
    if (EXECUTIVE_DEMO_CS_JD_RE.test(jd) && EXECUTIVE_DEMO_CS_RESUME_RE.test(text)) {
      return 'executive-demo-health-proof';
    }
    if (MENTORSHIP_CS_JD_RE.test(jd) && MENTORSHIP_CS_RESUME_RE.test(text)) {
      return 'csm-mentorship-proof';
    }
  }
  return null;
}

export function lowestPrioritySelectedBullet(replacements, planningContext) {
  const scored = selectedBulletEntries(replacements)
    .map(item => ({
      ...item,
      protectedReason: protectedBulletReason(item, planningContext),
      score: bulletSelectionScore(item.text, item.roleIndex, planningContext),
    }));
  const removable = scored.filter(item => !item.protectedReason);
  return (removable.length ? removable : scored)
    .sort((a, b) => a.score - b.score || b.roleIndex - a.roleIndex)
    .at(0);
}

export function chooseDynamicPageFitAction(layout, attempt = 0) {
  if (layout?.status === 'fit') return 'accept';
  if (layout?.status === 'overflow' && attempt === 0) return 'tighten';
  if (layout?.status === 'overflow') return 'drop-bullet';
  return 'content-repair';
}

async function fitDynamicResumeLocally({
  replacements,
  fields,
  docxPath,
  templatePath,
  planningContext,
  jdText = '',
  candidateTruth = '',
  log,
  notify = () => {},
}) {
  let fitted = { ...replacements };
  let unreplaced = [];
  for (let attempt = 0; attempt <= ROLE_SLOT_COUNTS.reduce((sum, value) => sum + value, 0); attempt += 1) {
    let layout = await getRenderedLayout(docxPath);
    let action = chooseDynamicPageFitAction(layout, attempt);
    if (action === 'accept') return { replacements: fitted, unreplaced, pageCount: layout.pageCount, layout };

    if (action === 'tighten') {
      tightenDocxLayout(docxPath);
      layout = await getRenderedLayout(docxPath);
      log?.('page-fit', `tightened dynamic resume before bullet removal (${layout.pageCount ?? 'unknown'} page(s), page2 fill=${layout.secondPageFillRatio ?? 'n/a'}, words=${layout.renderedWords ?? 'n/a'})`);
      action = chooseDynamicPageFitAction(layout, attempt + 1);
      if (action === 'accept') return { replacements: fitted, unreplaced, pageCount: layout.pageCount, layout };
    }

    if (action === 'content-repair') {
      log?.('page-fit', `dynamic resume needs content repair (${layout.status}, ${layout.pageCount ?? 'unknown'} page(s), page2 fill=${layout.secondPageFillRatio ?? 'n/a'}, words=${layout.renderedWords ?? 'n/a'})`);
      return fitResumeToTwoPages({
        replacements: fitted,
        fields,
        docxPath,
        templatePath,
        jdText,
        candidateTruth,
        planningContext,
        log,
        notify,
      });
    }

    const drop = lowestPrioritySelectedBullet(fitted, planningContext);
    if (!drop) {
      throw new Error(`Rendered resume layout is overflow (${layout.pageCount} page(s)); no removable bullets remain`);
    }
    fitted[drop.field] = '';
    ({ unreplaced } = patchDocx(templatePath, fitted, docxPath));
    tightenDocxLayout(docxPath);
    log?.('page-fit', `dropped ${drop.field} locally (score=${drop.score})`);
  }
  throw new Error('Unable to fit resume locally after removing all optional bullets');
}

function supportedRequirementCoverage(replacements, planningContext) {
  const resumeText = normalizeText(Object.values(replacements || {}).join(' '));
  return (planningContext?.requirements ?? [])
    .filter(item => planningContext?.evidenceMap?.find(evidence => evidence.requirement === item.requirement)?.status !== 'gap')
    .map(item => {
      const words = normalizeText(item.requirement).split(/\s+/).filter(word => word.length >= 4);
      return {
        requirement: item.requirement,
        covered: words.some(word => resumeText.includes(word)),
      };
    });
}

export function compareSupportedRequirementCoverage(before, after, planningContext) {
  const prior = new Map(supportedRequirementCoverage(before, planningContext).map(item => [item.requirement, item.covered]));
  return supportedRequirementCoverage(after, planningContext)
    .filter(item => prior.get(item.requirement) && !item.covered)
    .map(item => item.requirement);
}

async function maybeExportPdf(docxPath, outputDir, replacements, fields, log, emit, knownLayout = null) {
  if (!isPdfExportEnabled() && !isPageValidationEnabled()) {
    debugPipeline(log, 'page-density', {
      ...buildResumeDebugStats(replacements, fields),
      validationStatus: 'pass',
    });
    return {
      pdfUrl: null,
      pageCount: null,
      pageValidation: { ...PDF_VALIDATION_DISABLED },
    };
  }

  emit('pdf', 'started');
  try {
    const pdfPath = isPdfExportEnabled() ? await docxToPdf(docxPath, outputDir) : null;
    const layout = pdfPath
      ? (() => Promise.all([getPdfPageCount(pdfPath), getPdfPageMetrics(pdfPath)])
          .then(([pageCount, pages]) => ({ pageCount, pages, ...classifyResumeLayout({ pageCount, pages }) })))()
      : knownLayout
        ? Promise.resolve(knownLayout)
        : getRenderedLayout(docxPath);
    const resolvedLayout = await layout;
    const { pageCount } = resolvedLayout;
    const pageValidation = pageCount
      ? {
          status: resolvedLayout.status === 'fit' ? 'passed' : 'warning',
          message: resolvedLayout.status === 'fit'
            ? `Rendered resume is 2 full pages (page 2 fill ${resolvedLayout.secondPageFillRatio}, ${resolvedLayout.renderedWords ?? 'unknown'} words)`
            : `Rendered resume layout is ${resolvedLayout.status} (${pageCount} page(s), page 2 fill ${resolvedLayout.secondPageFillRatio ?? 'unknown'}, ${resolvedLayout.renderedWords ?? 'unknown'} words); target is 2 full pages with Word-safe density`,
        }
      : {
          status: 'skipped',
          message: 'PDF page count unavailable',
        };
    debugPipeline(log, 'page-density', {
      ...buildResumeDebugStats(replacements, fields, { pageCount }),
      validationStatus: 'pass',
    });
    emit('pdf', 'done', pageCount ? { message: `${pageCount} PDF pages` } : { message: pageValidation.message });
    return {
      pdfUrl: pdfPath ? `/output/${path.basename(pdfPath)}` : null,
      pageCount,
      pageValidation,
    };
  } catch (err) {
    log('pdf', `skipped (${err.message.slice(0, 100)})`);
    debugPipeline(log, 'page-density', {
      ...buildResumeDebugStats(replacements, fields),
      validationStatus: 'pass',
    });
    emit('pdf', 'skipped', { message: 'PDF export unavailable; DOCX generated' });
    return {
      pdfUrl: null,
      pageCount: null,
      pageValidation: { ...PDF_VALIDATION_DISABLED },
    };
  }
}

function debugPipeline(log, label, stats) {
  if (process.env.RESUME_DEBUG_PIPELINE !== '1') return;
  const message = [
    `average bullet word count=${stats.avgBulletWordCount}`,
    `average bullet character count=${stats.avgBulletCharacterCount}`,
    `weak bullet count=${stats.weakBulletCount}`,
    `validation=${stats.validationStatus ?? 'pending'}`,
    stats.pageCount ? `page count=${stats.pageCount}` : `estimated density=${stats.estimatedDensity}`,
  ].join(' | ');
  log(`resume-debug-${label}`, message);
  process.stderr.write(`[resume-debug:${label}] ${message}\n`);
}

function debugPlanning(log, label, payload) {
  if (process.env.RESUME_DEBUG_PIPELINE !== '1') return;
  const message = JSON.stringify(payload);
  log(`resume-debug-${label}`, message);
  process.stderr.write(`[resume-debug:${label}] ${message}\n`);
}

// ── Optional polish pass ──────────────────────────────────────────────────────

function polishRoleDirective(planningContext) {
  const roleMode = planningContext?.roleMode;
  if (roleMode === 'msp-compliance-delivery') {
    return 'ROLE-SPECIFIC POLISH: This is an MSP/compliance/service-delivery leadership resume. Prioritize execution coordination, onboarding project management, corrective action plans, escalation accountability, service operating cadence, dashboards, team accountability, and compliance-aligned delivery. Downrank pure NRR, ARR growth, QBR pipeline, expansion-assist, and commercial-owner framing unless the bullet also shows execution or delivery coordination. Do not claim direct CMMC ownership unless already present in the text.';
  }
  if (roleMode === 'pre-sales-solutions-architecture') {
    return 'ROLE-SPECIFIC POLISH: This is a pre-sales/solutions architecture resume. Prioritize discovery, demos, technical business cases, architecture/design decisions, solution fit, stakeholder advisory, and platform fluency. Downrank renewal, retention, NRR, churn, and account-health phrasing unless tied directly to technical sales execution.';
  }
  if (roleMode === 'startup-cs-builder') {
    return 'ROLE-SPECIFIC POLISH: This is a startup CSM builder resume. Prioritize process design, scalable onboarding workflows, AI-assisted documentation, Voice of Customer, Product/Engineering/Sales/Marketing coordination, onsite SBR/security workshop readiness, threat hunting, behavioral detection, security telemetry, and Total Trial Services CS-function-building proof. Downrank director-heavy and pure NRR framing unless tied to building a repeatable CS operating system.';
  }
  if (roleMode === 'startup-commercial-cs-builder') {
    return 'ROLE-SPECIFIC POLISH: This is a commercial startup CSM resume. Prioritize expansion, retention, churn save, book-of-business ownership, AE partnership, renewal strategy, account planning, Pipedrive/CRM hygiene, proactive outreach, QBRs, playbook building, and Total Trial Services CS-function-building proof. Treat physical security / IoT as adjacency; do not claim direct domain experience or invent AI deployed in customer SOC environments.';
  }
  if (roleMode === 'ai-customer-experience') {
    return 'ROLE-SPECIFIC POLISH: This is an AI-native Customer Experience Manager resume. Prioritize enterprise onboarding, adoption and consumption, quality/usage data reviews, Product/Engineering feedback loops, multi-department workflow integration, Fortune 100/500 stakeholders, McAfee onboarding proof, Securonix usage-data proof, Auth0 integration complexity, and ExtraHop telemetry business cases. Do not claim direct LLM, prompt-tuning, training-data, conversational-AI, or customer-deployed AI workflow ownership unless already present with concrete source support.';
  }
  return 'ROLE-SPECIFIC POLISH: Preserve the detected role frame from the section plan and do not drift into a different function.';
}

async function polishBullets(replacements, log, notify = () => {}, planningContext = null) {
  if (!localAiEnabled()) {
    notify('claude-polish', 'skipped', 'LM Studio', 'Polish skipped — LM Studio disabled');
    return replacements;
  }

  const bulletEntries = Object.entries(replacements)
    .filter(([k, value]) => (k.toLowerCase().includes('achievement') || k.toLowerCase().includes('bullet')) && String(value ?? '').trim());
  if (!bulletEntries.length) {
    notify('claude-polish', 'skipped', 'LM Studio', 'No bullets to polish');
    return replacements;
  }

  const client = localAiClient;
  const model = localResumeModel();
  notify('claude-polish', 'running', 'LM Studio', `Polishing ${bulletEntries.length} bullets · ${model}`);
  const prompt = withHumanizer(`Rewrite these resume bullets to meet a top-1% executive resume bar while preserving only real facts already present in the text. Do not trim them into generic one-liners or resume shorthand. Frame Brian as an operator who builds systems, aligns stakeholders, drives execution, closes gaps, and owns role-specific outcomes, not as a relationship manager or support contact. ${polishRoleDirective(planningContext)} Each JOB bullet should be 22-34 words and include at least two of: measurable impact, scope, method/system, stakeholder, and business outcome. Each bullet should also show judgment or a hard-to-copy customer motion: a decision, tradeoff, prioritization, workflow, playbook, governance model, escalation path, or operating system Brian built. For JOB_1 through JOB_4 bullets, target 175-240 characters. For older or compressed JOB_5+ bullets, target 140-210 characters. Each KEY_ACHIEVEMENT should be 18-28 words. Avoid generic verbs without proof, repeated openers, three consecutive gerunds, em dashes, "Responsible for", and banned phrases such as results-driven, proven track record, passionate, dynamic, thought leader, world-class, best-in-class, synergy, leverage as jargon, or empowered. Do not over-compress useful detail. Return a JSON object with the same keys and refined values. No explanation.\n\n${JSON.stringify(Object.fromEntries(bulletEntries))}`);

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    let polished;
    try {
      polished = JSON.parse(cleaned);
    } catch {
      polished = {};
      for (const m of cleaned.matchAll(/"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)) {
        polished[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
      if (!Object.keys(polished).length) throw new Error('no parseable pairs');
    }
    log('claude-polish', 'done');
    notify('claude-polish', 'done', 'LM Studio', `${Object.keys(polished).length} bullets polished`);
    return { ...replacements, ...polished };
  } catch (err) {
    log('claude-polish', `skipped (${err.message.slice(0, 60)})`);
    notify('claude-polish', 'skipped', 'LM Studio', `Polish skipped — ${err.message.slice(0, 50)}`);
    return replacements;
  }
}

// ── Shared setup helper ───────────────────────────────────────────────────────

export function extractReportJobDescription(reportText = '') {
  const text = String(reportText ?? '');
  const match = text.match(/##\s+Job Description\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  return (match?.[1] ?? text).trim();
}

export function scoreJobDescriptionText(text = '', { title = '' } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return -100;
  const normalized = normalizeText(raw);
  const titleWords = normalizeText(title).split(/\s+/).filter(word => word.length >= 4);
  const markerHits = [
    'what you ll do',
    'what you will do',
    'responsibilities',
    'requirements',
    'qualifications',
    'what you ll bring',
    'what you will bring',
    'skills',
    'about the job',
    'compensation',
    'salary',
  ].filter(marker => normalized.includes(marker)).length;
  const roleHits = titleWords.filter(word => normalized.includes(word)).length;
  const actionHits = [
    'manage',
    'lead',
    'build',
    'develop',
    'partner',
    'drive',
    'monitor',
    'improve',
    'ensure',
    'experience',
  ].filter(word => normalized.includes(word)).length;
  const noiseHits = [
    'skip to main content',
    'privacy policy',
    'website terms',
    'footer',
    'book a demo',
    'download the app',
    'employee login',
  ].filter(marker => normalized.includes(marker)).length;
  return (Math.min(raw.length, 6000) / 1000)
    + (markerHits * 4)
    + (roleHits * 2)
    + actionHits
    - (noiseHits * 3);
}

export function selectBestJobDescription(job = {}, reportText = '') {
  const candidates = [
    { source: 'report', text: extractReportJobDescription(reportText) },
    { source: 'full_description', text: job.full_description || '' },
    { source: 'description_preview', text: job.description_preview || '' },
  ]
    .map(candidate => ({ ...candidate, score: scoreJobDescriptionText(candidate.text, { title: job.title }) }))
    .filter(candidate => candidate.text.trim());
  if (!candidates.length) return { source: 'none', text: '', score: -100 };
  return candidates.sort((a, b) => b.score - a.score)[0];
}

export function assessJobDescription(job = {}, reportText = '') {
  const selected = selectBestJobDescription(job, reportText);
  return {
    ...selected,
    usable: selected.score >= 8,
    reason: selected.score >= 8
      ? 'role-specific job description detected'
      : 'saved description appears incomplete, generic, or dominated by site-navigation text',
  };
}

export function assessStoredJobDescription(jobId) {
  const job = loadJobById(jobId);
  return assessJobDescription(job, loadJdFromReports(jobId));
}

function buildJdText(job, jobId) {
  const reportText = loadJdFromReports(jobId);
  const best = assessJobDescription(job, reportText);
  const header = [
    `Company: ${job.company}`,
    `Role: ${job.title}`,
    `Location: ${job.location || ''}`,
    '',
  ].join('\n');
  return `${header}${best.text}`;
}

function outputPaths(job) {
  const datePart = new Date().toISOString().slice(0, 10);
  const companySafe = (job.company || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const outputDir = path.resolve(APP_ROOT, 'output');
  return { outputDir, docxFilename: `resume-${companySafe}-${datePart}.docx` };
}

// ── analyzeGaps ───────────────────────────────────────────────────────────────

export async function analyzeGaps(jobId) {
  const job = loadJobById(jobId);
  const bragDoc = loadBragDoc();
  const linkedInText = await loadLinkedInText();
  const jdText = buildJdText(job, jobId);
  const templatePath = resolveTemplatePath();
  const candidateTruth = buildCandidateTruthContext({ bragDoc, linkedInText, templatePath });
  const prompt = `You are a resume gap analyzer. Given the job description and candidate source-of-truth files below, list the skills, certifications, or experience required by the job that are NOT demonstrated in the candidate history. Treat ${MASTER_BRAG_NAME}, ${PROFILE_PDF_NAME}, and ${TEMPLATE_NAME} as the main sources of truth. Return a JSON array of short strings only — no explanation.\n\nJOB DESCRIPTION:\n${jdText.slice(0, 3000)}\n\nCANDIDATE SOURCE OF TRUTH:\n${candidateTruth.slice(0, 5000)}`;

  try {
    if (!localAiEnabled()) throw new Error('LM Studio disabled');
    const model = getLmStudioAnalysisModel();
    const raw = await lmStudioChat(model, [{ role: 'user', content: prompt }]);
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback: extract required skills and flag common gaps
    const reqSection = jdText.match(/require[sd]?[:\s]+([\s\S]{0,800})/i)?.[1] ?? '';
    return reqSection
      .split(/[,\n•\-]/)
      .map(s => s.trim())
      .filter(s => s.length > 4 && s.length < 60)
      .slice(0, 10);
  }
}

function stripJsonFence(raw) {
  return String(raw ?? '').replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
}

export async function generateGapQuestions(jobId) {
  const job = loadJobById(jobId);
  const bragDoc = loadBragDoc();
  const jdText = buildJdText(job, jobId);
  const keywords = localKeywordExtract(jdText);
  const context = buildResumePlanningContext(jdText, keywords, bragDoc);
  const candidates = buildGapQuestionCandidates({
    requirements: context.requirements,
    evidenceMap: context.evidenceMap,
    bragDoc,
  });
  if (!candidates.length) return [];
  const gaps = candidates.map(item => item.gap);
  const fallback = candidates.map(({ gap, question }) => ({ gap, question }));
  const prompt = `Return JSON only. Turn these resume evidence gaps into concise candidate questions.
Role: ${job.title}
Gaps: ${JSON.stringify(gaps)}
Output: [{"gap":"...","question":"Ask if they did it, where, what they did, and any truthful result/scope."}]
Max 5.`;

  try {
    if (localAiEnabled()) {
      const raw = await lmStudioChat(getLmStudioAnalysisModel(), [{ role: 'user', content: prompt }], { maxTokens: 350 });
      const parsed = JSON.parse(stripJsonFence(raw));
      // Keep each candidate's own gap key (answers are saved and later
      // matched by it); take only the model's question wording.
      return candidates.map((candidate, index) => ({
        gap: candidate.gap,
        question: typeof parsed?.[index]?.question === 'string' && parsed[index].question.trim()
          ? parsed[index].question.trim()
          : candidate.question,
      }));
    }
  } catch {}

  return fallback;
}

function mergeRecoveredEvidence(bragDoc, additions = []) {
  const unique = [...new Set(additions.map(item => String(item ?? '').trim()).filter(Boolean))];
  if (!unique.length) return bragDoc;
  const bullets = unique.map(item => `- ${item}`).join('\n');
  const heading = '## Recovered Evidence';
  if (bragDoc.includes(heading)) {
    const [before, after = ''] = bragDoc.split(heading);
    const nextSection = after.search(/\n---\n|\n## /);
    if (nextSection >= 0) {
      const sectionBody = after.slice(0, nextSection);
      const remainder = after.slice(nextSection);
      const existing = new Set(sectionBody.split('\n').map(line => line.trim()));
      const newBullets = unique.filter(item => !existing.has(`- ${item}`)).map(item => `- ${item}`);
      if (!newBullets.length) return bragDoc;
      return `${before}${heading}${sectionBody.replace(/\s*$/, '')}\n${newBullets.join('\n')}\n${remainder}`;
    }
  }
  return `${bragDoc.trim()}\n\n---\n\n${heading}\n\n${bullets}\n`;
}

export async function applyGapAnswersToBragDoc(jobId, answers = []) {
  const confirmed = answers
    .map(item => ({ gap: String(item?.gap ?? '').trim(), answer: String(item?.answer ?? '').trim() }))
    .filter(item => item.gap && item.answer && !/^(no|n\/a|none|not really)$/i.test(item.answer));
  if (!confirmed.length) return { updated: false, additions: [] };

  const bragDoc = loadBragDoc();
  const additions = confirmed.map(item => `${item.gap}: ${item.answer}`);

  const updatedDoc = mergeRecoveredEvidence(bragDoc, additions);
  if (updatedDoc !== bragDoc) saveBragDoc(updatedDoc);
  return { updated: updatedDoc !== bragDoc, additions };
}

// ── Draft / Finish ───────────────────────────────────────────────────────────

export async function generateResumeDraft(jobId, io, injectedSkills) {
  const runId = `${jobId}-${Date.now()}`;
  const { log } = createLogger(runId);

  try {
    const emit = (stage, status, extra = {}) => {
      io.emit('progress', { jobId, stage, status, ...extra });
      log(stage, status);
    };

    const job = loadJobById(jobId);
    const jdText = buildJdText(job, jobId);
    const bragDoc = loadBragDoc();
    const templatePath = resolveTemplatePath();
    const linkedInTextPromise = loadLinkedInText();
    const fields = listTemplateFields(templatePath);
    const skillsHint = injectedSkills
      ? `\nINJECTED SKILLS TO HIGHLIGHT: ${injectedSkills}`
      : '';

    await ensureLocalModelContext({ log });
    emit('keyword-analysis', 'started');
    const keywords = await pass1KeywordAnalysis(jdText, log);
    emit('keyword-analysis', 'done');
    const linkedInText = await linkedInTextPromise;
    const candidateTruth = buildCandidateTruthContext({ bragDoc, linkedInText, templatePath });

    emit('planning', 'started');
    const planningContext = buildResumePlanningContext(jdText + skillsHint, keywords, candidateTruth);
    debugPlanning(log, 'planning', planningContext);
    emit('planning', 'done', { message: planningContext.roleMode });

    emit('ai', 'started');
    const rawDraft = await pass2Synthesis(
      jdText + skillsHint,
      keywords,
      candidateTruth,
      fields,
      log,
      undefined,
      planningContext,
    );
    const replacements = flattenDynamicResumeDraft(rawDraft, fields, planningContext);
    emit('ai', 'done');

    return { jobId, io, job, jdText, templatePath, fields, replacements, rawDraft, keywords, planningContext, candidateTruth, log };
  } catch (err) {
    log('error', redactSecrets(err?.stack || err?.message || String(err)));
    throw err;
  }
}

export async function generateResumeFinish(state) {
  const { jobId, io, job, templatePath, fields, planningContext, log } = state;

  try {
    let { replacements } = state;
    let knownLayout = null;

    const emit = (stage, status, extra = {}) => {
      io.emit('progress', { jobId, stage, status, ...extra });
      log(stage, status);
    };

    log('summary-words', `after synthesis: ${wordCount(replacements.PROFESSIONAL_SUMMARY ?? '')}`);
    emit('draft-critique', 'started');
    replacements = await repairDraftFromCritique(
      replacements,
      planningContext,
      log,
      (stage, status, _source, message) => emit(stage, status, message ? { message } : {})
    );
    emit('draft-critique', 'done');

    emit('polish', 'started');
    replacements = await polishBullets(replacements, log, undefined, planningContext);
    replacements = sanitizeReplacementSet(replacements, fields);
    emit('polish', 'done');
    log('summary-words', `after polish: ${wordCount(replacements.PROFESSIONAL_SUMMARY ?? '')}`);

    emit('final-review', 'started');
    let currentFields = activeResumeFields(replacements, fields);
    replacements = await finalStrategicReviewAndRepair(
      replacements,
      currentFields,
      {
        jdText: state.jdText || '',
        candidateTruth: state.candidateTruth || '',
        planningContext,
        log,
        notify: (stage, status, _source, message) => emit(stage, status, message ? { message } : {}),
      }
    );
    replacements = sanitizeReplacementSet(replacements, fields);
    emit('final-review', 'done');
    log('summary-words', `after final review: ${wordCount(replacements.PROFESSIONAL_SUMMARY ?? '')}`);

    replacements = await repairThinSummary(replacements, {
      candidateTruth: state.candidateTruth,
      jdText: state.jdText,
      log,
      notify: (stage, status, _source, message) => emit(stage, status, message ? { message } : {}),
    });
    emit('validation', 'started');
    try {
      currentFields = activeResumeFields(replacements, fields);
      validateResumeQuality(replacements, currentFields);
      debugPipeline(log, 'validation', {
        ...buildResumeDebugStats(replacements, fields),
        validationStatus: 'pass',
      });
    } catch (err) {
      debugPipeline(log, 'validation-initial', {
        ...buildResumeDebugStats(replacements, fields),
        validationStatus: 'fail',
      });
      emit('validation', 'repairing', { message: 'Repairing weak bullets before DOCX build' });
        replacements = await repairQualityIssues(
          replacements,
          currentFields,
          err.issues ?? [],
          log,
          (stage, status, _source, message) => emit(stage, status, message ? { message } : {}),
          planningContext?.roleMode,
        );
        replacements = sanitizeReplacementSet(replacements, fields);
        try {
        currentFields = activeResumeFields(replacements, fields);
        validateResumeQuality(replacements, currentFields);
        debugPipeline(log, 'validation-repaired', {
          ...buildResumeDebugStats(replacements, fields),
          validationStatus: 'pass',
        });
      } catch (repairErr) {
        debugPipeline(log, 'validation-repaired', {
          ...buildResumeDebugStats(replacements, fields),
          validationStatus: 'fail',
        });
        const rescued = rescueQualityUntilStable(replacements, currentFields, planningContext?.roleMode);
        if (rescued !== replacements) {
          replacements = rescued;
          currentFields = activeResumeFields(replacements, fields);
          validateResumeQuality(replacements, currentFields);
          debugPipeline(log, 'validation-rescued', {
            ...buildResumeDebugStats(replacements, fields),
            validationStatus: 'pass',
          });
        } else {
          throw repairErr;
        }
      }
    }
    emit('validation', 'done');

    // Phase 0 evidence check: verifies numeric ($ / %) claims in the generated
    // resume trace back to the canonical candidate fact store
    // (data/candidate/*.json). Off by default (CANDIDATE_EVIDENCE_MODE=off) —
    // zero behavior change unless explicitly enabled with 'warn' or 'block'.
    const evidenceMode = evidenceValidationMode();
    if (evidenceMode !== 'off') {
      emit('evidence-check', 'started');
      const candidateFacts = loadCandidateFacts();
      const evidenceResult = validateGeneratedClaims(replacements, candidateFacts, { mode: evidenceMode });
      if (evidenceResult.claims.length) {
        debugPipeline(log, 'evidence-check', {
          validationStatus: evidenceResult.blocking ? 'fail' : 'warn',
          claims: evidenceResult.claims,
        });
        emit('evidence-check', evidenceResult.blocking ? 'blocked' : 'warning', {
          message: `Unsupported claims: ${evidenceResult.claims.map(c => `${c.field}="${c.text}"`).join('; ')}`,
        });
        if (evidenceResult.blocking) {
          const err = new Error(`Evidence validation failed — unsupported claims:\n${evidenceResult.claims.map(c => `${c.field}: "${c.text}" (not found in verified candidate data)`).join('\n')}`);
          err.claims = evidenceResult.claims;
          throw err;
        }
      } else {
        emit('evidence-check', 'done');
      }
    }

    emit('docx', 'started');
    const { outputDir, docxFilename } = outputPaths(job);
    const base = docxFilename.replace('.docx', '-default');
    const finalDocxPath = path.resolve(outputDir, `${base}.docx`);
    const workingDocxPath = path.resolve(outputDir, `.${base}.${process.pid}.${Date.now()}.working.docx`);
    let { unreplaced } = patchDocx(templatePath, replacements, workingDocxPath);
    emit('docx', 'done');

    try {
      if (isPageValidationEnabled()) {
        emit('page-fit', 'started');
        const preFitReplacements = { ...replacements };
        const fitted = await fitDynamicResumeLocally({
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
        replacements = fitted.replacements;
        unreplaced = fitted.unreplaced;
        knownLayout = fitted.layout;
        emit('page-fit', 'done');

        const lostCoverage = compareSupportedRequirementCoverage(preFitReplacements, replacements, planningContext);
        const fittedIssues = critiqueResumeDraft(replacements, planningContext);
        if (lostCoverage.length || fittedIssues.length) {
          log('final-review', `post-fit recheck triggered (lostCoverage=${lostCoverage.length}, issues=${fittedIssues.length})`);
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

      fs.renameSync(workingDocxPath, finalDocxPath);

      const docxUrl = `/output/${base}.docx`;
      const { pdfUrl, pageCount, pageValidation } = await maybeExportPdf(
        finalDocxPath,
        outputDir,
        replacements,
        fields,
        log,
        emit,
        knownLayout,
      );

      io.emit('complete', { jobId, variant: 'default', docxUrl, pdfUrl, pageValidation });
      log('complete', `docx=${base}.docx unreplaced=${unreplaced.length}`);

      if (unreplaced.length) {
        emit('warning', 'done', { message: `Unreplaced: ${unreplaced.join(', ')}` });
      }
      if (pageValidation.status === 'warning') {
        emit('warning', 'done', { message: pageValidation.message });
      }

      return { variant: 'default', docxUrl, pdfUrl, unreplaced, pageCount, pageValidation };
    } finally {
      fs.rmSync(workingDocxPath, { force: true });
    }
  } catch (err) {
    log('error', redactSecrets(err?.stack || err?.message || String(err)));
    throw err;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateResume(jobId, io, injectedSkills = '') {
  const state = await generateResumeDraft(jobId, io, injectedSkills);
  return generateResumeFinish(state);
}
