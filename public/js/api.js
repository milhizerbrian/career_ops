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

export function evaluateUrl(payload) {
  return jsonFetch('/api/evaluate-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function createDocs(jobId) {
  return jsonFetch('/api/create-docs/' + jobId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
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
