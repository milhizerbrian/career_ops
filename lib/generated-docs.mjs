const DEFAULT_PAGE_VALIDATION = {
  status: 'skipped',
  message: 'PDF validation disabled',
};

function fileNameFromUrl(url) {
  const value = String(url || '');
  return value.split('/').filter(Boolean).pop() || value;
}

function normalizeHistory(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const history = Array.isArray(entry.history) ? entry.history : [];
  if (history.length) return history;
  if (!entry.docxUrl) return [];
  return [{
    generatedAt: entry.generatedAt || null,
    strategy: entry.strategy || entry.variant || 'default',
    variant: entry.variant || entry.strategy || 'default',
    evaluatorScore: entry.evaluatorScore ?? null,
    atsScore: entry.atsScore ?? null,
    sourceJobId: entry.sourceJobId || null,
    fileName: entry.fileName || fileNameFromUrl(entry.docxUrl),
    docxUrl: entry.docxUrl,
  }];
}

export function buildResumeVersionRecord(result, {
  generatedAt = new Date().toISOString(),
  job = {},
  jobId = job.id || result.jobId || null,
} = {}) {
  const variant = result.variant || 'default';
  return {
    generatedAt,
    strategy: result.strategy || variant,
    variant,
    evaluatorScore: job.score ?? result.evaluatorScore ?? null,
    atsScore: job._ats?.score ?? result.atsScore ?? null,
    sourceJobId: jobId,
    fileName: fileNameFromUrl(result.docxUrl),
    docxUrl: result.docxUrl,
  };
}

export function buildGeneratedDocEntry(result, {
  generatedAt = new Date().toISOString(),
  job = {},
  jobId = job.id || result.jobId || null,
  previousEntry = null,
} = {}) {
  const version = buildResumeVersionRecord(result, { generatedAt, job, jobId });
  return {
    pdfUrl: result.pdfUrl ?? null,
    pageCount: result.pageCount ?? null,
    pageValidation: result.pageValidation ?? { ...DEFAULT_PAGE_VALIDATION },
    ...version,
    generatedAt,
    history: [
      ...normalizeHistory(previousEntry),
      version,
    ],
  };
}
