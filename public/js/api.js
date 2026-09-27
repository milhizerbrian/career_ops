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

export function fetchHome() {
  return jsonFetch('/api/home');
}

export function postActionDecision(actionId, decision, extra = {}) {
  return jsonFetch('/api/actions/' + encodeURIComponent(actionId) + '/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, ...extra }),
  });
}

export function postQuickDecision(opportunityId, decision, extra = {}) {
  return jsonFetch('/api/opportunities/' + encodeURIComponent(opportunityId) + '/quick-decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, ...extra }),
  });
}

export function fetchOpportunityWorkspace(opportunityId) {
  return jsonFetch('/api/opportunities/' + encodeURIComponent(opportunityId) + '/workspace');
}

export function patchOpportunity(opportunityId, body) {
  return jsonFetch('/api/opportunities/' + encodeURIComponent(opportunityId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function postOpportunityStage(opportunityId, stage, reason = '') {
  return jsonFetch('/api/opportunities/' + encodeURIComponent(opportunityId) + '/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage, reason }),
  });
}

export function createInterviewRound(opportunityId, body) {
  return jsonFetch('/api/opportunities/' + encodeURIComponent(opportunityId) + '/interviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function updateInterviewRound(opportunityId, roundId, body) {
  return jsonFetch('/api/opportunities/' + encodeURIComponent(opportunityId) + '/interviews/' + encodeURIComponent(roundId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function answerCandidateQuestion(questionId, answer) {
  return jsonFetch('/api/candidate-questions/' + encodeURIComponent(questionId) + '/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
}

export function fetchEvidenceVault() {
  return jsonFetch('/api/evidence-vault');
}

export function addEvidenceFact(category, body) {
  return jsonFetch('/api/evidence-vault/' + encodeURIComponent(category), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function updateEvidenceFact(category, id, body) {
  return jsonFetch('/api/evidence-vault/' + encodeURIComponent(category) + '/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function promoteQuestionToEvidence(questionId, body = {}) {
  return jsonFetch('/api/candidate-questions/' + encodeURIComponent(questionId) + '/promote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true, ...body }),
  });
}
