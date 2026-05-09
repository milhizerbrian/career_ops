import { appendWorkflowEvent } from './job-workflow.mjs';

export const CONTACT_RELATIONSHIP_TYPES = [
  'recruiter',
  'hiring_manager',
  'referral',
  'employee',
];

export const CONTACT_RESPONSE_STATUSES = [
  'not_contacted',
  'outreach_sent',
  'responded',
  'no_response',
  'follow_up_due',
];

const RELATIONSHIP_SET = new Set(CONTACT_RELATIONSHIP_TYPES);
const RESPONSE_SET = new Set(CONTACT_RESPONSE_STATUSES);
const LIMITS = {
  name: 120,
  title: 160,
  company: 160,
  linkedinUrl: 300,
  email: 180,
  followUpDue: 20,
};

function cleanString(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isSafeUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function isSafeEmail(value) {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isSafeDate(value) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function normalizeContacts(contacts) {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .filter(contact => contact && typeof contact === 'object' && !Array.isArray(contact))
    .map(contact => ({
      id: cleanString(contact.id, 80) || makeContactId(),
      name: cleanString(contact.name, LIMITS.name),
      title: cleanString(contact.title, LIMITS.title),
      company: cleanString(contact.company, LIMITS.company),
      linkedinUrl: cleanString(contact.linkedinUrl, LIMITS.linkedinUrl),
      email: cleanString(contact.email, LIMITS.email),
      relationshipType: RELATIONSHIP_SET.has(contact.relationshipType) ? contact.relationshipType : 'recruiter',
      responseStatus: RESPONSE_SET.has(contact.responseStatus) ? contact.responseStatus : 'not_contacted',
      followUpDue: cleanString(contact.followUpDue, LIMITS.followUpDue),
      outreachSentAt: cleanString(contact.outreachSentAt, 40),
      outreachDrafts: normalizeContactDrafts(contact.outreachDrafts),
      updatedAt: cleanString(contact.updatedAt, 40),
    }))
    .filter(contact => contact.name);
}

export function validateContactPayload(payload = {}) {
  const contact = payload.contact && typeof payload.contact === 'object' ? payload.contact : payload;
  const normalized = {
    id: cleanString(contact.id, 80),
    name: cleanString(contact.name, LIMITS.name),
    title: cleanString(contact.title, LIMITS.title),
    company: cleanString(contact.company, LIMITS.company),
    linkedinUrl: cleanString(contact.linkedinUrl, LIMITS.linkedinUrl),
    email: cleanString(contact.email, LIMITS.email),
    relationshipType: cleanString(contact.relationshipType, 40) || 'recruiter',
    responseStatus: cleanString(contact.responseStatus, 40) || 'not_contacted',
    followUpDue: cleanString(contact.followUpDue, LIMITS.followUpDue),
  };

  if (!normalized.name) throw new Error('Contact name is required');
  if (!RELATIONSHIP_SET.has(normalized.relationshipType)) {
    throw new Error(`Invalid relationshipType: ${normalized.relationshipType}`);
  }
  if (!RESPONSE_SET.has(normalized.responseStatus)) {
    throw new Error(`Invalid responseStatus: ${normalized.responseStatus}`);
  }
  if (!isSafeUrl(normalized.linkedinUrl)) throw new Error('Contact linkedinUrl must be http(s)');
  if (!isSafeEmail(normalized.email)) throw new Error('Contact email is invalid');
  if (!isSafeDate(normalized.followUpDue)) throw new Error('followUpDue must use YYYY-MM-DD');

  return normalized;
}

export function upsertJobContact(job, payload = {}, now = new Date()) {
  if (!job || typeof job !== 'object') throw new Error('job is required');
  const contact = validateContactPayload(payload);
  const contacts = normalizeContacts(job.contacts);
  const idx = contact.id ? contacts.findIndex(item => item.id === contact.id) : -1;
  const previous = idx >= 0 ? contacts[idx] : {};
  const next = {
    ...previous,
    ...contact,
    id: contact.id || previous.id || makeContactId(),
    updatedAt: now.toISOString(),
  };

  const markOutreachSent = payload.markOutreachSent === true || (
    previous.responseStatus !== 'outreach_sent' && contact.responseStatus === 'outreach_sent'
  );
  if (markOutreachSent) {
    next.responseStatus = 'outreach_sent';
    next.outreachSentAt = now.toISOString();
    appendWorkflowEvent(job, {
      type: 'outreach_sent',
      at: now.toISOString(),
      source: 'contact',
      label: next.name,
      note: next.title || next.relationshipType,
    }, now);
  }

  if (idx >= 0) contacts[idx] = next;
  else contacts.push(next);
  job.contacts = contacts;
  return next;
}

function makeContactId() {
  return `contact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeContactDrafts(drafts) {
  if (!Array.isArray(drafts)) return [];
  return drafts
    .filter(draft => draft && typeof draft === 'object' && !Array.isArray(draft))
    .map(draft => ({
      type: cleanString(draft.type, 40),
      text: cleanString(draft.text, 4000),
      generatedAt: cleanString(draft.generatedAt, 40),
      contactId: cleanString(draft.contactId, 100),
    }))
    .filter(draft => draft.type && draft.text && draft.generatedAt && draft.contactId);
}
