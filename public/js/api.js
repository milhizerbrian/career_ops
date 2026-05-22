async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(body.error || res.statusText);
    err.response = res;
    err.body = body;
    throw err;
  }
  return res.json();
}

export function fetchDashboard() {
  return jsonFetch('/api/dashboard');
}

export function fetchResumeRuns() {
  return jsonFetch('/api/resume-runs');
}

export function fetchJobDetail(jobId) {
  return jsonFetch('/api/jobs/' + encodeURIComponent(jobId));
}

export function fetchResumeWorkspace() {
  return jsonFetch('/api/workspaces/resume');
}

export function fetchOutreachWorkspace() {
  return jsonFetch('/api/workspaces/outreach');
}

export function fetchContactsWorkspace() {
  return jsonFetch('/api/workspaces/contacts');
}

export function fetchAnalyticsSummary() {
  return jsonFetch('/api/analytics/summary');
}

export function fetchSettingsHealth() {
  return jsonFetch('/api/settings/health');
}

export function evaluateUrl(payload) {
  return jsonFetch('/api/evaluate-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function createDocs(jobId, body = {}) {
  return jsonFetch('/api/create-docs/' + jobId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function fetchResumeGapQuestions(jobId) {
  return jsonFetch('/api/resume-gap-questions/' + jobId);
}

export function submitResumeGapAnswers(jobId, answers) {
  return jsonFetch('/api/resume-gap-answers/' + jobId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
}

export function patchJob(jobId, body) {
  return jsonFetch('/api/jobs/' + jobId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function postWorkflowEvent(jobId, body) {
  return jsonFetch('/api/jobs/' + jobId + '/workflow-event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function upsertJobContact(jobId, body) {
  return jsonFetch('/api/jobs/' + jobId + '/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function generateContactOutreachDraft(jobId, body) {
  return jsonFetch('/api/jobs/' + jobId + '/contacts/outreach-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteJobRequest(jobId) {
  return jsonFetch('/api/jobs/' + jobId, { method: 'DELETE' });
}

export function fetchAmbiguousGmailJobs() {
  return jsonFetch('/api/gmail-jobs?ambiguous=1');
}

export function fetchBragQuality() {
  return jsonFetch('/api/brag-quality');
}

export function attachGmailAmbiguity(threadId, jobId) {
  return jsonFetch('/api/gmail-jobs/' + encodeURIComponent(threadId) + '/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
}

export function dismissGmailAmbiguity(threadId) {
  return jsonFetch('/api/gmail-jobs/' + encodeURIComponent(threadId) + '/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}
