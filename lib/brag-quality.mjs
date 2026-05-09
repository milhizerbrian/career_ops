const CATEGORY_DEFINITIONS = [
  {
    key: 'metrics',
    label: 'Metrics',
    threshold: 4,
    patterns: [
      /\$[\d,.]+(?:[KMB]|mm|bn)?\b/gi,
      /\b\d+(?:\.\d+)?%/g,
      /\b\d+\+?\s*(?:accounts?|customers?|clients?|users?|renewals?|expansions?|deployments?|implementations?)\b/gi,
      /\b(?:ARR|NRR|GRR|NPS|CSAT|MTTR|SLA|pipeline|quota|revenue)\b/gi,
    ],
    prompt: 'Where can you add numbers: ARR, renewal size, expansion value, retention %, account count, or before/after change?',
  },
  {
    key: 'mechanisms',
    label: 'Mechanisms',
    threshold: 5,
    patterns: [
      /\b(?:by|through|via|using|with)\s+[a-z][a-z-]+/gi,
      /\b(?:implemented|built|created|designed|launched|introduced|standardized|automated|operationalized|orchestrated)\b/gi,
      /\b(?:framework|playbook|cadence|QBR|success plan|maturity model|recovery plan|adoption plan|enablement)\b/gi,
    ],
    prompt: 'For each major win, what exact playbook, process, cadence, framework, or technical action produced the result?',
  },
  {
    key: 'stakeholders',
    label: 'Stakeholders',
    threshold: 4,
    patterns: [
      /\b(?:CISO|CIO|CTO|CEO|CRO|COO|VP|SVP|EVP)\b/g,
      /\b(?:executives?|board|directors?|security leaders?|SOC|architects?|product|sales|engineering|partners?|stakeholders?)\b/gi,
    ],
    prompt: 'Which executive, security, product, sales, or delivery stakeholders were involved, and what decisions did you influence?',
  },
  {
    key: 'tools_platforms',
    label: 'Tools/platforms',
    threshold: 4,
    patterns: [
      /\b(?:Salesforce|Gainsight|Skilljar|ServiceNow|Jira|Tableau|Looker|Pendo|HubSpot|Marketo)\b/gi,
      /\b(?:Splunk|Sentinel|QRadar|CrowdStrike|Okta|Duo|ExtraHop|Darktrace|AWS|Azure|GCP|Kubernetes|Docker)\b/gi,
      /\b(?:SIEM|NDR|XDR|EDR|IAM|SOAR|API|CRM|CSM|SaaS)\b/g,
    ],
    prompt: 'Which named platforms, security products, CRM/CS tools, or integrations did you use to drive the outcome?',
  },
  {
    key: 'business_outcomes',
    label: 'Business outcomes',
    threshold: 5,
    patterns: [
      /\b(?:renewal|retention|expansion|adoption|revenue|churn|growth|pipeline|forecast|margin|profitability)\b/gi,
      /\b(?:time-to-value|risk reduction|cost savings|saved|protected|recovered|accelerated|reduced|increased|improved|preserved)\b/gi,
      /\b(?:ARR|NRR|GRR|NPS|CSAT)\b/g,
    ],
    prompt: 'What business result changed: retention, expansion, adoption, risk reduction, time-to-value, CSAT, or churn?',
  },
  {
    key: 'technical_depth',
    label: 'Technical depth',
    threshold: 5,
    patterns: [
      /\b(?:architecture|integration|deployment|implementation|detection|incident response|threat|ransomware|zero trust)\b/gi,
      /\b(?:MITRE|SOC|cloud|identity|endpoint|network|hybrid-cloud|east-west|telemetry|workflow)\b/gi,
      /\b(?:SIEM|NDR|XDR|EDR|IAM|SOAR|API|AWS|Azure|GCP|Kubernetes)\b/g,
    ],
    prompt: 'What technical environment, architecture, detection use case, integration, or security workflow made the work difficult?',
  },
];

export const BRAG_QUALITY_CATEGORIES = CATEGORY_DEFINITIONS.map(({ key, label, prompt }) => ({
  key,
  label,
  prompt,
}));

function uniqueMatches(markdown, patterns) {
  const matches = new Set();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of markdown.matchAll(pattern)) {
      matches.add(match[0].toLowerCase().replace(/\s+/g, ' ').trim());
    }
  }
  return [...matches].filter(Boolean).sort();
}

function statusFor(count, threshold) {
  if (count === 0) return 'missing';
  if (count < threshold) return 'weak';
  return 'strong';
}

export function analyzeBragDocQuality(markdown, options = {}) {
  const source = String(markdown ?? '');
  const maxSignals = options.maxSignalsPerCategory ?? 5;
  const categories = CATEGORY_DEFINITIONS.map(def => {
    const signals = uniqueMatches(source, def.patterns);
    const status = statusFor(signals.length, def.threshold);
    return {
      key: def.key,
      label: def.label,
      status,
      count: signals.length,
      threshold: def.threshold,
      signals: signals.slice(0, maxSignals),
      prompts: status === 'strong' ? [] : [def.prompt],
    };
  });

  const missingCategories = categories.filter(c => c.status === 'missing').map(c => c.key);
  const weakCategories = categories.filter(c => c.status === 'weak').map(c => c.key);
  const strongCategories = categories.filter(c => c.status === 'strong').map(c => c.key);

  return {
    generatedAt: new Date().toISOString(),
    sourceLength: source.length,
    summary: {
      missingCategories,
      weakCategories,
      strongCategories,
      advisoryCount: missingCategories.length + weakCategories.length,
    },
    categories,
  };
}

export function formatBragQualityReport(report) {
  const categories = Array.isArray(report?.categories) ? report.categories : [];
  const advisory = categories.filter(c => c.status !== 'strong');
  const lines = [
    'Brag Doc Source Quality Coach',
    `Source length: ${report?.sourceLength ?? 0} characters`,
    '',
  ];

  if (!advisory.length) {
    lines.push('All tracked evidence categories look covered.');
    return `${lines.join('\n')}\n`;
  }

  for (const category of advisory) {
    lines.push(`${category.label}: ${category.status} (${category.count}/${category.threshold})`);
    for (const prompt of category.prompts ?? []) lines.push(`- ${prompt}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
