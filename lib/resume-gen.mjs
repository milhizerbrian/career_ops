import Anthropic from '@anthropic-ai/sdk';
import { loadJobById, loadBragDoc, saveBragDoc, loadLinkedInText, loadJdFromReports } from './data.mjs';
import { resolveTemplatePath, patchDocx, listTemplateFields, tightenDocxLayout } from './docx-utils.mjs';
import { docxToPdf, getPdfPageCount, getPdfPageMetrics } from './pdf-utils.mjs';
import { createLogger } from './logger.mjs';
import { getLmStudioAnalysisModel } from './lm-studio-config.mjs';
import { HUMANIZED_OUTPUT_RULES, withHumanizer } from './humanizer.mjs';
import {
  anthropicPromptCachingEnabled,
  anthropicRequestCacheControl,
  logAnthropicCacheUsage,
} from './anthropic-cache.mjs';
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
const PROFILE_PDF_NAME = 'Profile.pdf';
const MASTER_BRAG_NAME = 'master-brag-document.md';
const TEMPLATE_NAME = 'FINAL Brian Milhizer Production Resume Template v3.dotx';
const ROLE_SLOT_COUNTS = [5, 4, 4, 3, 3, 2];
const DEFAULT_DYNAMIC_BULLET_BUDGET = Number(process.env.RESUME_BULLET_BUDGET ?? '18');
let anthropicClient = null;
let anthropicClientKey = null;

function preferClaudePipeline() {
  return (process.env.PREFER_CLAUDE_SYNTHESIS ?? '1') !== '0';
}

function getAnthropicClient(apiKey = process.env.ANTHROPIC_API_KEY) {
  if (!apiKey) return null;
  if (!anthropicClient || anthropicClientKey !== apiKey) {
    anthropicClient = new Anthropic({ apiKey });
    anthropicClientKey = apiKey;
  }
  return anthropicClient;
}

// ── LM Studio helpers ─────────────────────────────────────────────────────────

const LM_STUDIO_BASE = 'http://localhost:1234';

async function lmStudioChat(model, messages, { maxTokens = 2000, timeoutMs = 30_000 } = {}) {
  const res = await fetch(`${LM_STUDIO_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
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

async function claudeKeywordAnalysis(jdText, log, notify = () => {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const client = getAnthropicClient(apiKey);
  const model = process.env.CLAUDE_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';
  const prompt = `Extract the 20 most important ATS keywords and required skills from this job description. Return a comma-separated list only, no explanation.\n\nJOB DESCRIPTION:\n${jdText.slice(0, 2500)}`;
  notify('keyword-analysis', 'running', 'Claude', `Extracting keywords · ${model}`);
  const message = await client.messages.create({
    model,
    max_tokens: 300,
    cache_control: anthropicRequestCacheControl(),
    messages: [{ role: 'user', content: prompt }],
  });
  logAnthropicCacheUsage(log, 'claude-keywords-cache', message.usage);
  log('claude-pass1', 'done');
  notify('keyword-analysis', 'done', 'Claude', 'Keywords extracted');
  return (message.content[0]?.text ?? '').trim();
}

async function pass1KeywordAnalysis(jdText, log, notify = () => {}) {
  if (preferClaudePipeline()) {
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
11. ROLE FRAME: Infer the target function from the JD title, responsibilities, and repeated vocabulary before writing. Do not default to Customer Success language when the JD is pre-sales, solutions architecture, sales engineering, or technical advisory.
12. PRE-SALES / SOLUTIONS ARCHITECT MODE: When the JD mentions solution architect, client solutions engineer, sales engineer, pre-sales, presales, technical architect, solution sizing, BOM, RFP/RFI, POC, demo, discovery, technical sales campaign, data center, cloud management, infrastructure, or security architecture:
   - TITLE_LINE must mirror the JD function and signal role comprehension, e.g. Senior Client Solutions Engineer | Pre-Sales Technical Advisory | Enterprise Cloud & Security Architecture. Do not open with Enterprise Customer Success leader.
   - PROFESSIONAL_SUMMARY must open with a pre-sales/technical-advisory identity and include campaign ownership, architecture/design guidance, SME positioning, and solution sizing or BOM review when supported by the JD and candidate history.
   - CORE_COMPETENCIES should be the only skills/platform section. Use labeled groups when possible: Security Platforms, Cloud & Infrastructure, GTM/CS Platforms, and Security Domains. Use named platforms from candidate history or the JD only. Do not create or imply a duplicate Tools & Platforms block.
   - CERTIFICATIONS_LINE must prioritize the most relevant supported cybersecurity certification first. For technical cybersecurity, sales engineering, endpoint, application control, Zero Trust, or security architecture roles, lead with Certified Ethical Hacker (CEH).
   - ExtraHop bullets should prioritize architecture design decisions, technical business case construction, solution design changes, demos/discovery, and stakeholder technical advisory. Cut or de-emphasize pure adoption, renewal recovery, NRR, churn, or account-health metrics unless tied directly to technical sales execution.
   - Securonix bullets should lead with SIEM/log ingestion architecture, vulnerability-management integrations, onboarding architecture, competitive displacement, and security workflow design. Do not lead with internal CS health scoring or escalation operations.
13. CUSTOMER SUCCESS MODE: Use retention, NRR, renewal, churn prevention, adoption, and account-health vocabulary only when the JD is actually a CS, CSM, TAM, renewal, or post-sale leadership role.
14. MSP / COMPLIANCE DELIVERY MODE: When the JD emphasizes managed services, compliance programs, service delivery, onboarding project management, corrective action plans, technical project execution, technology rollouts, environment builds, dashboards, ticket queues, backlog, escalation accountability, or cross-functional execution:
   - Reframe the resume around delivery accountability, execution coordination, operating cadence, playbooks, escalation protocols, customer communication, and team standards.
   - TITLE_LINE should signal managed services, cybersecurity delivery, execution leadership, compliance-aligned program delivery, or service delivery leadership. Do not lead with Retention & Expansion Ownership.
   - METRICS_LINE should prioritize scale, team leadership, portfolio size, retention, CS function building, onboarding reduction, or direct reports ahead of NRR.
   - PROFESSIONAL_SUMMARY should read like a general manager of customer delivery: onboarding execution, corrective action coordination, escalation accountability, cross-functional team alignment, and process scale.
   - CORE_COMPETENCIES should be a clean competency list with execution/project/compliance/service-delivery terms. Avoid a duplicate Tools & Platforms inventory unless the JD is platform-specific.
   - Use compliance-adjacent language honestly. If CMMC, DIB, GRC, or audit language appears in the JD but candidate history does not show direct experience, say compliance-aligned, regulated-industry, audit-readiness, DLP, IAM, email security, SIEM/SOC, or policy-enforcement workflows only where supported. Do not claim direct CMMC ownership unless present in source material.
   - ExtraHop bullets should lead with onboarding, time-to-value, delivery roadmap, executive/technical alignment, adoption gap resolution, and measurable customer outcome before expansion language.
   - Securonix and Total Trial Services should emphasize lifecycle model building, onboarding reduction, escalation protocols, team accountability, and delivery infrastructure.
   - Downrank pure QBR pipeline, expansion-assist, NRR, ARR growth, and commercial-owner language unless the JD makes upsell/renewal ownership a dominant requirement.
15. SUMMARY: Three sentences maximum. Sentence 1 shows domain, seniority, scope, and years. Sentence 2 states the operator thesis. Sentence 3 gives a hard-to-replicate differentiator tied to the JD's unstated priorities. Do not open with a personal pronoun or adjective-heavy phrase.
16. 7-SECOND SCAN: Above the fold, make seniority, scale, role-specific outcome, and cybersecurity domain credibility immediately visible. For SaaS CS roles, the outcome may be retention/expansion. For delivery/compliance roles, the outcome should be execution, onboarding, escalation, compliance alignment, or team operating scale.
17. HUMAN VOICE: Apply the humanizer standard. No JD restatements, no "Responsible for..." phrasing, no three consecutive gerund-opening bullets, no identical sentence structures inside the same role, no consecutive bullets starting with the same verb. Use concrete operator language that Brian could say out loud.
18. METRICS_LINE should use Brian's strongest truthful scale signal for the JD. For enterprise cybersecurity or Sales Engineer roles, prefer $55M ARR Portfolio (peak) over lower current-role portfolio numbers unless the JD clearly values most-recent scope more.
19. When a supported metric is missing, use a neutral placeholder such as [X%] or [$XM ARR] rather than inventing a number.

${HUMANIZED_OUTPUT_RULES}

FIELDS: TITLE_LINE=positioning tagline | METRICS_LINE=4-5 compact career metrics | PROFESSIONAL_SUMMARY=3 strong executive sentences | CORE_COMPETENCIES=single skills/platform section with labeled platform/domain groups where useful | KEY_ACHIEVEMENT_1-4=metric-driven accomplishment | CERTIFICATIONS_LINE=certifications only, ordered by JD relevance and source truth | ROLES=array of six chronological role objects with roleIndex, context, and bullets[]

Return strict JSON. Use scalar fields for the top-level sections plus ROLES: [{roleIndex: 1, context: "...", bullets: ["...", "..."]}, ...].`;

export function synthesisSystemBlocks() {
  if (!anthropicPromptCachingEnabled()) return SYNTHESIS_SYSTEM_PROMPT;
  return [{
    type: 'text',
    text: SYNTHESIS_SYSTEM_PROMPT,
    cache_control: { type: 'ephemeral' },
  }];
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

const REQUIREMENT_CATALOG = [
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
];

const DOMAIN_CATALOG = [
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
  'compliance program',
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

const GENERIC_KEYWORD_REQUIREMENTS = new Set([
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

const GAP_QUESTION_PRIORITY = new Map([
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

const EVIDENCE_ALIASES = {
  'managed services delivery': ['managed services', 'service delivery', 'customer success', 'onboarding', 'delivery', 'support'],
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
  if (explicitTechnicalPostSale && !explicitPreSales) return 'cse';
  if (explicitPreSales || scored['pre-sales-solutions-architecture'] >= 2) return 'pre-sales-solutions-architecture';
  if (scored['msp-compliance-delivery'] > 1) return 'msp-compliance-delivery';
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
  if (/\barchitecture|integration|technical|api|cloud|data center|security operations|soc|siem|ndr|iam\b/i.test(jdText)) {
    unstatedPriorities.push('Lead with technical depth, architecture judgment, and integration fluency.');
  }
  if (/\bdirector|head of|vp|scale|build|operating model|team\b/i.test(jdText)) {
    unstatedPriorities.push('Show operating model, team rhythm, and scalable systems, not only account execution.');
  }
  if (/\bmanaged services|msp|service delivery|compliance|cmmc|corrective action|onboarding project|technology rollout|environment build|ticket queue|backlog|playbook|execution coordination\b/i.test(jdText)) {
    unstatedPriorities.push('Prioritize delivery execution, onboarding coordination, corrective action discipline, escalation accountability, and service operating cadence over pure SaaS expansion framing.');
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

  const seen = new Set();
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
    summaryThesis: 'Enterprise customer success and technical advisory leader focused on adoption, retention, renewal recovery, stakeholder alignment, and cybersecurity outcomes.',
    toolsPlatformsDirective: 'Include named platforms and domains where supported, but keep CS outcomes central.',
    certificationDirective: 'Order certifications by JD relevance while preserving only source-truth credentials.',
    achievementFocus: topRequirements.filter(req => evidenceStatus(evidenceMap, req) !== 'gap'),
    emphasizeBullets: ['Renewal recovery, adoption planning, executive stakeholder alignment, value realization, and technical advisory.'],
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
    'Still preserve technical credibility with named security platforms, integrations, discovery, architecture, and measurable customer outcomes.',
  ].join('\n');
}

async function pass2Synthesis(jdText, keywords, bragDoc, fields, log, notify = () => {}, planningContext = null) {
  const preferClaude = preferClaudePipeline();
  const positioningMode = planningContext?.roleMode || classifyResumeRole(jdText);
  const positioningInstructions = resumePositioningInstructions(positioningMode);
  const planningText = planningContextText(planningContext);
  const buildContent = (historySlice) =>
    `ROLE STRATEGY:\n${positioningInstructions}\n\n${planningText}\n\nCANDIDATE SOURCE OF TRUTH:\n${historySlice}\n\nJOB DESCRIPTION:\n${jdText.slice(0, CAP_JD)}\n\nKEYWORDS FROM PASS 1:\n${keywords}\n\nRETURN SHAPE:\n- Fill scalar fields: ${fields.filter(field => !/^JOB_\d+_/.test(field)).map(f => f).join(', ')}\n- Return ROLES with six chronological objects: { roleIndex, context, bullets[] }\n- bullets[] are ranked candidate bullets. The app will choose the final bullet count locally.\n- Low-match roles may return an empty bullets[] while keeping a concise context line.\n\nReturn strict JSON only.`;

  const lmContent   = buildContent(bragDoc.slice(0, CAP_BRAG));
  const fullContent = buildContent(bragDoc);

  if (preferClaude || !process.env.LM_STUDIO_SYNTHESIS_MODEL) {
    notify('lm-synthesis', 'skipped', 'LM Studio', 'PREFER_CLAUDE_SYNTHESIS=1 — skipping LM Studio');
    return await claudeSynthesis(fullContent, log, notify);
  }

  const model = process.env.LM_STUDIO_SYNTHESIS_MODEL ?? 'qwen2.5-14b-instruct-1m';
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
      log('lm-studio-pass2', `low coverage ${filled}/${scalarFields.length + ROLE_SLOT_COUNTS.length} sections — falling back to Claude`);
      notify('lm-synthesis', 'fallback', 'LM Studio', `Low coverage ${filled}/${scalarFields.length + ROLE_SLOT_COUNTS.length} sections → falling back to Claude`);
      return await claudeSynthesis(fullContent, log, notify);
    }

    log('lm-studio-pass2', `done (${filled}/${scalarFields.length + ROLE_SLOT_COUNTS.length} sections)`);
    notify('lm-synthesis', 'done', 'LM Studio', `${filled}/${scalarFields.length + ROLE_SLOT_COUNTS.length} sections filled`);
    return parsed;
  } catch (err) {
    log('lm-studio-pass2', `fallback to Claude (${err.message.slice(0, 80)})`);
    notify('lm-synthesis', 'fallback', 'LM Studio', `${err.message.slice(0, 60)} → falling back to Claude`);
    return await claudeSynthesis(fullContent, log, notify);
  }
}

async function claudeSynthesis(userContent, log, notify = () => {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const client = getAnthropicClient(apiKey);
  const model = process.env.CLAUDE_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';

  notify('claude-synthesis', 'running', 'Claude', `Synthesizing resume · ${model}`);
  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    cache_control: anthropicRequestCacheControl(),
    system: synthesisSystemBlocks(),
    messages: [{ role: 'user', content: userContent }],
  });

  const rawText = message.content[0]?.text ?? '';
  const cleaned = rawText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const parsed = JSON.parse(cleaned);
  logAnthropicCacheUsage(log, 'claude-synthesis-cache', message.usage);
  log('claude-synthesis', 'done');
  notify('claude-synthesis', 'done', 'Claude', 'Synthesis complete');
  return parsed;
}

// ── Draft critique / repair ──────────────────────────────────────────────────

const PRE_SALES_CS_MISMATCH_RE = /\b(customer success leader|customer success manager|csm|post-sale|post sale|renewal|renewals|retention|nrr|churn|account health)\b/i;
const PRE_SALES_SIGNAL_RE = /\b(pre-sales|presales|solution architect|solutions architect|client solutions engineer|sales engineer|technical advisor|technical advisory|architecture|discovery|demo|poc|solution sizing|bom|data center|cloud|security architecture)\b/i;
const DELIVERY_SAAS_MISMATCH_RE = /\b(retention\s*&\s*expansion ownership|retention and expansion ownership|nrr|net revenue retention|arr growth|expansion-focused|commercial owner|pipeline generation|sales-assist|sales assist)\b/i;
const DELIVERY_SIGNAL_RE = /\b(managed services|msp|service delivery|delivery accountability|execution leadership|execution coordination|onboarding|corrective action|technology rollout|environment build|playbook|escalation accountability|dashboards|ticket queues|backlog|compliance-aligned|compliance program|audit-readiness|team accountability)\b/i;
const STRATEGIC_CS_SIGNAL_RE = /\b(customer health|value realization|executive engagement|executive stakeholder|team leadership|coaching|customer planning|qbr|ebr|operating model|segmentation|cross-functional|adoption|customer outcomes)\b/i;
const OVERTECHNICAL_CS_RE = /\b(ndr|siem|ueba|edr|iam|soc|detection coverage|threat detection|platform architecture|security platform lifecycle|security stakeholders)\b/i;
const TRANSFERABLE_OUTCOME_SIGNAL_RE = /\b(customer outcomes?|business outcomes?|value realization|executive engagement|stakeholder alignment|operating model|operating cadence|adoption|retention|execution|team leadership|customer planning|risk reduction|growth opportunities)\b/i;
const SOURCE_DOMAIN_HEAVY_RE = /\b(ndr|npm|siem|ueba|edr|iam|soc|threat detection|security program maturity|deployment health|security architecture|security operations timelines|detection use-case adoption|hybrid environments)\b/i;
const BANNED_PHRASE_RE = /\b(results-driven|proven track record|passionate about|passionate|dynamic|thought leader|world-class|best-in-class|synergy|leverage|empowered|responsible for|served as (?:a |the )?point of contact|managed relationships|provided support)\b|—/i;
const GERUND_OPENING_RE = /^\s*[A-Z][a-z]+ing\b/;

export function sanitizeResumeLanguage(value) {
  return String(value ?? '')
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
    .replace(/,\s*across enterprise customer environments,\s*by aligning stakeholders,\s*use cases,\s*and measurable security outcomes\.?$/i, '.')
    .replace(/,\s*across enterprise customer environments,\s*using stakeholder alignment,\s*use-case scoping,\s*and measurable security outcomes\.*$/i, '.')
    .replace(/,\s*for technical advisory,\s*security architecture,\s*and cybersecurity SaaS execution\.?$/i, '.')
    .replace(/,\s*by aligning stakeholders,\s*use cases,\s*and measurable security outcomes\.?$/i, '.')
    .replace(/,\s*across enterprise cybersecurity stakeholders using documented deployment criteria and measurable security outcomes\.?$/i, '.')
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

function sanitizeReplacementSet(replacements, fields = Object.keys(replacements || {})) {
  const sanitized = { ...replacements };
  for (const field of fields) {
    if (Object.hasOwn(sanitized, field)) sanitized[field] = sanitizeResumeLanguage(sanitized[field]);
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
  return Object.fromEntries(fields.map(field => [field, flattened[field] ?? '']));
}

function activeResumeFields(replacements, fields) {
  return fields.filter(field => !/^JOB_\d+_BULLET_\d+$/i.test(field) || String(replacements[field] ?? '').trim());
}

export function critiqueResumeDraft(replacements, planningContext) {
  const issues = [];
  const roleMode = planningContext?.roleMode || 'customer-success';
  const title = String(replacements?.TITLE_LINE ?? '');
  const summary = String(replacements?.PROFESSIONAL_SUMMARY ?? '');
  const tools = String(replacements?.CORE_COMPETENCIES ?? '');
  const securitySpecificTarget = isSecuritySpecificTarget(planningContext, planningContext?.jdText);

  for (const [field, value] of Object.entries(replacements || {})) {
    if (BANNED_PHRASE_RE.test(String(value))) {
      issues.push({
        field,
        code: 'banned-or-support-framing',
        message: 'Resume text uses banned phrasing, em dash, or support-first framing.',
      });
    }
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
    if (issue.code === 'banned-or-support-framing') {
      repaired[field] = sanitizeResumeLanguage(repaired[field]);
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    notify('draft-critique', 'done', 'Local', `${issues.length} framing issues repaired locally`);
    return repaired;
  }

  try {
    const client = getAnthropicClient(apiKey);
    const model = process.env.CLAUDE_POLISH_MODEL ?? 'claude-sonnet-4-6';
    const failedFields = [...new Set(remainingIssues.map(issue => issue.field))].filter(Boolean);
    const prompt = withHumanizer(`Repair only the listed resume fields so they match the role strategy and critique. Preserve only facts supported by the existing text, section plan, evidence map, or candidate history already present in the field values. Do not invent employers, dates, certifications, product names, or exact metrics. Return strict JSON with only these fields: ${failedFields.join(', ')}.\n\nROLE MODE:\n${planningContext?.roleMode}\n\nSECTION PLAN:\n${JSON.stringify(planningContext?.sectionPlan ?? {}, null, 2)}\n\nEVIDENCE MAP:\n${JSON.stringify(planningContext?.evidenceMap ?? [], null, 2)}\n\nCRITIQUE ISSUES:\n${JSON.stringify(remainingIssues, null, 2)}\n\nFIELDS:\n${JSON.stringify(Object.fromEntries(failedFields.map(field => [field, repaired[field] ?? replacements[field] ?? ''])), null, 2)}`);

    const message = await client.messages.create({
      model,
      max_tokens: 1600,
      cache_control: anthropicRequestCacheControl(),
      messages: [{ role: 'user', content: prompt }],
    });
    logAnthropicCacheUsage(log, 'draft-critique-cache', message.usage);
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    repaired = { ...repaired, ...JSON.parse(cleaned) };
    repaired = sanitizeReplacementSet(repaired, failedFields);
    notify('draft-critique', 'done', 'Claude', `${issues.length} framing issues repaired`);
    return repaired;
  } catch (err) {
    log('draft-critique', `local repair kept after Claude error (${err.message.slice(0, 60)})`);
    notify('draft-critique', 'done', 'Local', `${issues.length} framing issues repaired locally`);
    return repaired;
  }
}

// ── Quality gate ──────────────────────────────────────────────────────────────

const GENERIC_BULLET_RE = /\b(managed|owned|supported|advised|maintained|partnered|worked|helped|assisted|handled|responsible for|drove adoption|improved engagement|ensured|collaborated)\b/i;
const PROOF_RE = /(\$[\d,.]+[MBK]?|\d+%|\d+\+?x|\b\d+\s*(accounts?|customers?|clients?|direct reports|opportunities|expansions|renewals|years?|ARR|NPS|CSAT)\b|\bFortune\s*\d+\b|\benterprise\b|\bCISO\b|\bVP\b)/i;
const DOMAIN_RE = /\b(NDR|NPM|SIEM|UEBA|EDR|IAM|DLP|CNAPP|CWPP|XDR|SaaS|security|cybersecurity|cloud|identity|endpoint|network|email|renewal|retention|expansion|onboarding|QBR|time-to-value|adoption|managed services|MSP|service delivery|compliance|audit-readiness|corrective action|technology rollout|environment build|ticket queue|backlog|playbook|escalation)\b/i;
const MECHANISM_RE = /\b(by|through|using|via|with|across|for|while|including|tied to|resulting in|enabling|reducing|retaining|expanding|accelerating|recovering|introducing|building|stabilizing)\b/i;

function wordCount(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function hasWeakGenericShape(value) {
  const text = String(value ?? '').trim();
  return GENERIC_BULLET_RE.test(text) && !(PROOF_RE.test(text) && DOMAIN_RE.test(text) && MECHANISM_RE.test(text));
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
    if (/^JOB_\d+_CONTEXT$/i.test(field) && words < 12) {
      issues.push(`${field}: context is too short (${words} words, expected 12+)`);
    }
    if (BANNED_PHRASE_RE.test(value)) {
      issues.push(`${field}: contains banned phrase, em dash, or support-first framing`);
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
      : 'with security architecture and cybersecurity SaaS context');
  }
  if (!MECHANISM_RE.test(text) || hasWeakGenericShape(text)) {
    additions.push(roleMode === 'strategic-cs-leadership'
      ? 'using executive alignment, customer planning, and measurable business outcomes'
      : 'through stakeholder alignment, use-case scoping, and measurable security outcomes');
  }

  if (additions.length) text = `${text}, ${additions.join(', ')}`;

  const targets = bulletTargets(field);
  if (targets && wordCount(text) < targets.minWords) {
    text = `${text}, with executive-ready operating rhythm and clear ownership`;
  }
  if (targets && text.length < targets.minChars) {
    text = `${text}, tying daily execution to durable adoption, risk reduction, and ${roleMode === 'strategic-cs-leadership' ? 'customer value' : 'security value'}`;
  }

  return `${text}.`;
}

function forceBulletQuality(value, issueTexts = [], roleMode = 'customer-success') {
  let text = String(value ?? '').trim().replace(/\.$/, '');
  const combinedIssues = issueTexts.join(' ');
  if (/lacks metric, enterprise scope, or stakeholder proof|generic activity/i.test(combinedIssues)) {
    text = roleMode === 'strategic-cs-leadership'
      ? `${text}, across enterprise stakeholders using customer planning, executive alignment, and measurable business outcomes`
      : `${text}, for enterprise security stakeholders through documented deployment criteria and measurable security outcomes`;
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
  if (['pre-sales-solutions-architecture', 'tam', 'cse', 'msp-compliance-delivery'].includes(roleMode)) return true;
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
      repaired[target] = 'Led POC-style technical evaluations for enterprise security platform decisions, defining success criteria with security engineering and IT stakeholders across NDR and SIEM engagements.';
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('quality-repair', `fallback (${failedFields.length} fields)`);
    notify('quality-repair', 'done', 'Local', `${failedFields.length} bullets repaired`);
    return repaired;
  }

  try {
    const client = getAnthropicClient(apiKey);
    const model = process.env.CLAUDE_POLISH_MODEL ?? 'claude-sonnet-4-6';
    const prompt = withHumanizer(`Repair only the listed resume fields so they pass the quality gate while preserving only facts already present in each field. Keep bullets concise and impact-oriented. Every job bullet must include enterprise/stakeholder proof, JD-relevant domain or customer-outcome language, and a concrete mechanism. Remove banned phrases, em dashes, "Responsible for", "provided support", and support-first framing. Do not invent employers, dates, certifications, product names, or exact metrics. Return strict JSON mapping field names to repaired text only.\n\nFAILED ISSUES:\n${issues.join('\n')}\n\nFIELDS:\n${JSON.stringify(Object.fromEntries(failedFields.map(field => [field, repaired[field]])))}`);

    notify('quality-repair', 'running', 'Claude', `Repairing ${failedFields.length} bullets · ${model}`);
    const message = await client.messages.create({
      model,
      max_tokens: 1200,
      cache_control: anthropicRequestCacheControl(),
      messages: [{ role: 'user', content: prompt }],
    });
    logAnthropicCacheUsage(log, 'quality-repair-cache', message.usage);
    const raw = message.content[0]?.text ?? '';
    const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    repaired = { ...repaired, ...JSON.parse(cleaned) };
    repaired = sanitizeReplacementSet(repaired, failedFields);
    repaired = applyDeterministicQualityRepairs(repaired, fields, issues, roleMode);
    repaired = rescueQualityUntilStable(repaired, fields, roleMode);
    log('quality-repair', `done (${failedFields.length} fields)`);
    notify('quality-repair', 'done', 'Claude', `${failedFields.length} bullets repaired`);
    return repaired;
  } catch (err) {
    log('quality-repair', `fallback after Claude error (${err.message.slice(0, 60)})`);
    notify('quality-repair', 'done', 'Local', `${failedFields.length} bullets repaired locally`);
    return repaired;
  }
}

async function finalStrategicReviewAndRepair(replacements, fields, { jdText = '', candidateTruth = '', planningContext = null, log, notify = () => {} } = {}) {
  let repaired = applyDeterministicStrategicRepairs(replacements, fields, { jdText, planningContext });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log?.('final-review', 'local deterministic repair');
    notify('final-review', 'done', 'Local', 'Strategic review applied locally');
    return repaired;
  }

  try {
    const client = getAnthropicClient(apiKey);
    const model = process.env.CLAUDE_POLISH_MODEL ?? 'claude-sonnet-4-6';
    const prompt = withHumanizer(`Act as the final hiring-manager resume reviewer before DOCX creation. Compare the finished resume fields against the JD and return only strategic field repairs that would make the resume top 1% for this exact role.

MANDATORY REVIEW CHECKS:
- The finished DOCX must be a full, dense 2-page resume only. Add substantive, source-supported detail if the content is sparse. Do not create a third page.
- No duplicate Tools & Platforms section. CORE_COMPETENCIES is the single skills/platform section.
- TITLE_LINE must mirror the JD's function and strongest domain language.
- METRICS_LINE must use Brian's strongest truthful enterprise scale when relevant, including $55M ARR Portfolio (peak) for enterprise cybersecurity Sales Engineer roles.
- For strategic Customer Success leadership JDs, the resume must lead with executive engagement, customer health, adoption, value realization, customer planning, operating models, cross-functional influence, and people leadership rather than cybersecurity tooling.
- PROFESSIONAL_SUMMARY must include the top supported JD domain terms when they are central to the role, such as application control, allowlisting, endpoint security, Zero Trust, POC, RFP/RFI, MITRE, NIST, CIS, Active Directory, Windows, APIs, integrations, and cloud platforms.
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

    notify('final-review', 'running', 'Claude', `Final strategic review · ${model}`);
    const message = await client.messages.create({
      model,
      max_tokens: 2200,
      cache_control: anthropicRequestCacheControl(),
      messages: [{ role: 'user', content: prompt }],
    });
    logAnthropicCacheUsage(log, 'final-review-cache', message.usage);
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
    notify('final-review', 'done', 'Claude', `${Object.keys(allowed).length} strategic fields repaired`);
    return repaired;
  } catch (err) {
    log?.('final-review', `local repair after Claude error (${err.message.slice(0, 80)})`);
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
  if (!pageCount) return { status: 'unknown', pageCount, secondPageFillRatio, lastPage };
  if (pageCount > 2) return { status: 'overflow', pageCount, secondPageFillRatio, lastPage };
  if (pageCount < 2) return { status: 'underfilled', pageCount, secondPageFillRatio, lastPage };
  if ((secondPageFillRatio ?? 0) < MIN_FULL_SECOND_PAGE_RATIO) {
    return { status: 'underfilled', pageCount, secondPageFillRatio, lastPage };
  }
  return { status: 'fit', pageCount, secondPageFillRatio, lastPage };
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
        repaired[field] = value;
      }
    }
  }
  return repaired;
}

async function repairForLayout(replacements, fields, layout, { jdText = '', candidateTruth = '', planningContext = null, log, notify = () => {} } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !layout?.pageCount || layout.status === 'fit') return replacements;
  try {
    const client = getAnthropicClient(apiKey);
    const model = process.env.CLAUDE_POLISH_MODEL ?? 'claude-sonnet-4-6';
    const direction = layout.status === 'overflow'
      ? 'shorten enough to fit exactly 2 full pages'
      : 'add substantive source-supported detail until page 2 is materially full';
    const editableFields = selectPageFitFields(fields, layout.status);
    const prompt = withHumanizer(`Repair these resume fields to ${direction}. The rendered DOCX is currently ${layout.pageCount} page(s). Page 2 fill ratio is ${layout.secondPageFillRatio ?? 'unknown'} and the final resume must be exactly 2 full pages with page 2 fill ratio at least ${MIN_FULL_SECOND_PAGE_RATIO}.

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
    notify('page-fit', 'running', 'Claude', `Repairing ${layout.status} resume to full 2 pages · ${model}`);
    const message = await client.messages.create({
      model,
      max_tokens: 2600,
      cache_control: anthropicRequestCacheControl(),
      messages: [{ role: 'user', content: prompt }],
    });
    logAnthropicCacheUsage(log, 'page-fit-cache', message.usage);
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
    notify('page-fit', 'done', 'Claude', `${layout.status} layout repaired toward full 2 pages`);
    return repaired;
  } catch (err) {
    log?.('page-fit', `skipped after Claude error (${err.message.slice(0, 80)})`);
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
      log?.('page-fit', `tightened layout before content repair (${layout.pageCount} page(s), page2 fill=${layout.secondPageFillRatio ?? 'n/a'})`);
      if (layout.status === 'fit') return { replacements: fitted, unreplaced, pageCount: layout.pageCount, layout };
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
    log?.('page-fit', `attempt ${attempt} repatched after ${layout.status} render (${layout.pageCount} page(s), page2 fill=${layout.secondPageFillRatio ?? 'n/a'})`);
  }

  const finalCheck = await getRenderedLayout(docxPath);
  if (finalCheck.status === 'fit') {
    return { replacements: fitted, unreplaced, pageCount: finalCheck.pageCount, layout: finalCheck };
  }
  throw new Error(`Rendered resume layout is ${finalCheck.status} (${finalCheck.pageCount ?? 'unknown'} page(s), page 2 fill ${finalCheck.secondPageFillRatio ?? 'unknown'}); final output must be exactly 2 full pages`);
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

function lowestPrioritySelectedBullet(replacements, planningContext) {
  return selectedBulletEntries(replacements)
    .map(item => ({ ...item, score: bulletSelectionScore(item.text, item.roleIndex, planningContext) }))
    .sort((a, b) => a.score - b.score || b.roleIndex - a.roleIndex)
    .at(0);
}

async function fitDynamicResumeLocally({
  replacements,
  fields,
  docxPath,
  templatePath,
  planningContext,
  log,
}) {
  let fitted = { ...replacements };
  let unreplaced = [];
  tightenDocxLayout(docxPath);
  for (let attempt = 0; attempt <= ROLE_SLOT_COUNTS.reduce((sum, value) => sum + value, 0); attempt += 1) {
    const layout = await getRenderedLayout(docxPath);
    if (layout.status === 'fit') return { replacements: fitted, unreplaced, pageCount: layout.pageCount, layout };
    if (layout.status !== 'overflow') {
      throw new Error(`Rendered resume layout is ${layout.status} (${layout.pageCount ?? 'unknown'} page(s), page 2 fill ${layout.secondPageFillRatio ?? 'unknown'}); final output must be exactly 2 full pages`);
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
            ? `Rendered resume is 2 full pages (page 2 fill ${resolvedLayout.secondPageFillRatio})`
            : `Rendered resume layout is ${resolvedLayout.status} (${pageCount} page(s), page 2 fill ${resolvedLayout.secondPageFillRatio ?? 'unknown'}); target is 2 full pages`,
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
  return 'ROLE-SPECIFIC POLISH: Preserve the detected role frame from the section plan and do not drift into a different function.';
}

async function polishBullets(replacements, log, notify = () => {}, planningContext = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    notify('claude-polish', 'skipped', 'Claude', 'Polish skipped — no API key');
    return replacements;
  }

  const bulletEntries = Object.entries(replacements)
    .filter(([k, value]) => (k.toLowerCase().includes('achievement') || k.toLowerCase().includes('bullet')) && String(value ?? '').trim());
  if (!bulletEntries.length) {
    notify('claude-polish', 'skipped', 'Claude', 'No bullets to polish');
    return replacements;
  }

  const client = getAnthropicClient(apiKey);
  const model = process.env.CLAUDE_POLISH_MODEL ?? 'claude-sonnet-4-6';
  notify('claude-polish', 'running', 'Claude', `Polishing ${bulletEntries.length} bullets · ${model}`);
  const prompt = withHumanizer(`Rewrite these resume bullets to meet a top-1% executive resume bar while preserving only real facts already present in the text. Do not trim them into generic one-liners or resume shorthand. Frame Brian as an operator who builds systems, aligns stakeholders, drives execution, closes gaps, and owns role-specific outcomes, not as a relationship manager or support contact. ${polishRoleDirective(planningContext)} Each JOB bullet should be 22-34 words and include at least two of: measurable impact, scope, method/system, stakeholder, and business outcome. For JOB_1 through JOB_4 bullets, target 175-240 characters. For older or compressed JOB_5+ bullets, target 140-210 characters. Each KEY_ACHIEVEMENT should be 18-28 words. Avoid generic verbs without proof, repeated openers, three consecutive gerunds, em dashes, "Responsible for", and banned phrases such as results-driven, proven track record, passionate, dynamic, thought leader, world-class, best-in-class, synergy, leverage as jargon, or empowered. Do not over-compress useful detail. Return a JSON object with the same keys and refined values. No explanation.\n\n${JSON.stringify(Object.fromEntries(bulletEntries))}`);

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 2048,
      cache_control: anthropicRequestCacheControl(),
      messages: [{ role: 'user', content: prompt }],
    });
    logAnthropicCacheUsage(log, 'claude-polish-cache', message.usage);
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
    notify('claude-polish', 'done', 'Claude', `${Object.keys(polished).length} bullets polished`);
    return { ...replacements, ...polished };
  } catch (err) {
    log('claude-polish', `skipped (${err.message.slice(0, 60)})`);
    notify('claude-polish', 'skipped', 'Claude', `Polish skipped — ${err.message.slice(0, 50)}`);
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
    if (preferClaudePipeline()) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
      const client = getAnthropicClient(apiKey);
      const model = process.env.CLAUDE_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';
      const message = await client.messages.create({
        model,
        max_tokens: 700,
        cache_control: anthropicRequestCacheControl(),
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = message.content[0]?.text ?? '';
      const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
      return JSON.parse(cleaned);
    }

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
    if (preferClaudePipeline()) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
      const client = getAnthropicClient(apiKey);
      const model = process.env.CLAUDE_SYNTHESIS_MODEL ?? 'claude-sonnet-4-6';
      const message = await client.messages.create({
        model,
        max_tokens: 350,
        cache_control: anthropicRequestCacheControl(),
        messages: [{ role: 'user', content: prompt }],
      });
      return JSON.parse(stripJsonFence(message.content[0]?.text));
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
}

export async function generateResumeFinish(state) {
  const { jobId, io, job, templatePath, fields, planningContext, log } = state;
  let { replacements } = state;
  let knownLayout = null;

  const emit = (stage, status, extra = {}) => {
    io.emit('progress', { jobId, stage, status, ...extra });
    log(stage, status);
  };

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
        log,
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
            log,
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
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateResume(jobId, io, injectedSkills = '') {
  const state = await generateResumeDraft(jobId, io, injectedSkills);
  return generateResumeFinish(state);
}
