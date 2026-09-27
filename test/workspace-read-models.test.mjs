import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnalyticsSummary,
  buildContactsWorkspace,
  buildJobReadModel,
  buildOutreachWorkspace,
  buildResumeWorkspace,
  buildSettingsHealth,
} from '../lib/workspace-read-models.mjs';

const job = {
  id: 'job1',
  company: 'Acme Security',
  title: 'Senior CSM',
  status: 'applied',
  score: 4,
  date_updated: '2026-05-01',
  companyResearch: {
    fundingStage: 'Series C',
    productCategory: 'Cybersecurity platform',
    customers: ['Fortune 500'],
    competitors: ['Beta Security'],
    recentNews: ['Launched enterprise security workflow'],
  },
  generatedDocs: {
    default: {
      docxUrl: '/output/acme.docx',
      fileName: 'acme.docx',
      generatedAt: '2026-05-02T12:00:00.000Z',
      atsScore: 82,
      history: [
        {
          docxUrl: '/output/acme-v1.docx',
          fileName: 'acme-v1.docx',
          generatedAt: '2026-05-01T12:00:00.000Z',
          atsScore: 76,
        },
      ],
    },
  },
  contacts: [
    {
      id: 'contact1',
      name: 'Alex Morgan',
      title: 'Recruiter',
      company: 'Acme Security',
      relationshipType: 'recruiter',
      responseStatus: 'follow_up_due',
      followUpDue: '2026-05-01',
      outreachDrafts: [
        {
          type: 'linkedin_connection',
          text: 'Hi Alex',
          generatedAt: '2026-05-03T12:00:00.000Z',
          contactId: 'contact1',
        },
      ],
    },
  ],
  _ats: { score: 82 },
  _oi: { score: 75 },
  _workflow: {
    nextBestAction: 'follow_up',
    staleness: { stale: true, needsAppliedFollowUp: true, appliedForDays: 10 },
    timeline: [{ type: 'applied', at: '2026-05-01T00:00:00.000Z', source: 'status', label: '' }],
  },
};

const recruiterTargetingJob = {
  id: 'job2',
  company: 'Beta Security',
  title: 'Director of Customer Success',
  status: 'lead',
  date_updated: '2026-05-01',
  recruiterTargeting: {
    recruiterName: 'Jordan Lee',
    recruiterTitle: 'Talent Partner',
    recruiterLinkedInUrl: 'https://www.linkedin.com/in/jordan',
    responseStatus: 'message_drafted',
    followUpDate: '2026-05-04',
    suggestedMessage: 'Hi Jordan - concise draft.',
  },
};

describe('workspace read models', () => {
  it('builds a full job read model without requiring legacy fields', () => {
    const model = buildJobReadModel({ id: 'legacy', company: 'Legacy Co', title: 'Role', status: 'lead' });
    assert.equal(model.id, 'legacy');
    assert.deepEqual(model.contacts, []);
    assert.deepEqual(model.generatedDocs, {});
    assert.equal(typeof model._search.score, 'number');
    assert.equal(typeof model._search.dimensions.interviewFit, 'number');
    assert.equal(Array.isArray(model._workflow.timeline), true);
  });

  it('builds resume queue and version history', () => {
    const model = buildResumeWorkspace([job], {
      resumeRuns: [{ jobId: 'job2', status: 'running' }],
      sourceQuality: { findings: ['Add quantified platform proof'] },
    });
    assert.equal(model.queue.length, 1);
    assert.equal(model.queue[0].resumeStatus, 'generated');
    assert.equal(model.versions.length, 1);
    assert.equal(model.versions[0].fileName, 'acme-v1.docx');
  });

  it('builds outreach and contacts workspaces from job contacts', () => {
    const now = new Date('2026-05-04T12:00:00.000Z');
    const outreach = buildOutreachWorkspace([job, recruiterTargetingJob], { now });
    const contacts = buildContactsWorkspace([job, recruiterTargetingJob], { now });
    assert.equal(outreach.dueFollowUps.length, 2);
    assert.equal(outreach.drafts.length, 2);
    assert.equal(outreach.byCompany.find(item => item.company === 'Acme Security').dueCount, 1);
    assert.equal(outreach.byCompany.find(item => item.company === 'Beta Security').dueCount, 1);
    assert.equal(contacts.contacts[0].name, 'Alex Morgan');
    assert.equal(contacts.contacts[0].experienceMatchPct, 80);
    assert.equal(contacts.contacts[0].experienceMatchSource, 'ai');
    assert.equal(typeof contacts.contacts[0].influenceScore, 'number');
    assert.equal(typeof contacts.contacts[0].contactIntelligence.score, 'number');
    assert.ok(contacts.contacts.some(contact => contact.name === 'Jordan Lee' && contact.legacySource === 'recruiterTargeting'));
    assert.deepEqual(contacts.filters.relationshipTypes, ['recruiter']);
  });

  it('deduplicates contacts attached to multiple jobs at the same company', () => {
    const jobs = [
      {
        id: 'job-a',
        company: 'Acme Security',
        title: 'CSM',
        contacts: [{
          id: 'contact-a',
          name: 'Jane Smith',
          title: 'VP Customer Success',
          company: 'Acme Security',
          linkedinUrl: 'https://www.linkedin.com/in/janesmith',
          relationshipType: 'employee',
          responseStatus: 'not_contacted',
        }],
      },
      {
        id: 'job-b',
        company: 'Acme Security',
        title: 'Director CSM',
        contacts: [{
          id: 'contact-b',
          name: 'Jane Smith',
          title: 'VP Customer Success',
          company: 'Acme Security',
          linkedinUrl: 'https://www.linkedin.com/in/janesmith',
          relationshipType: 'employee',
          responseStatus: 'not_contacted',
        }],
      },
    ];

    const contacts = buildContactsWorkspace(jobs, { now: new Date('2026-05-04T12:00:00.000Z') });
    assert.equal(contacts.contacts.length, 1);
    assert.deepEqual(contacts.contacts[0].associatedJobIds.sort(), ['job-a', 'job-b']);
    assert.equal(contacts.contacts[0].relatedJobCount, 2);
  });

  it('uses the strongest related job score as contact experience match', () => {
    const jobs = [
      {
        id: 'job-a',
        company: 'Acme Security',
        title: 'CSM',
        score: 3.1,
        contacts: [{
          id: 'contact-a',
          name: 'Jane Smith',
          title: 'VP Customer Success',
          company: 'Acme Security',
          linkedinUrl: 'https://www.linkedin.com/in/janesmith',
          relationshipType: 'employee',
          responseStatus: 'not_contacted',
        }],
      },
      {
        id: 'job-b',
        company: 'Acme Security',
        title: 'Director CSM',
        score: 4.4,
        contacts: [{
          id: 'contact-b',
          name: 'Jane Smith',
          title: 'VP Customer Success',
          company: 'Acme Security',
          linkedinUrl: 'https://www.linkedin.com/in/janesmith',
          relationshipType: 'employee',
          responseStatus: 'not_contacted',
        }],
      },
    ];

    const contacts = buildContactsWorkspace(jobs, { now: new Date('2026-05-04T12:00:00.000Z') });

    assert.equal(contacts.contacts[0].experienceMatchPct, 88);
  });

  it('uses report score as AI contact experience match when top-level score is missing', () => {
    const contacts = buildContactsWorkspace([{
      id: 'job-a',
      company: 'Acme Security',
      title: 'CSM',
      report: { score: 3.7 },
      contacts: [{
        id: 'contact-a',
        name: 'Jane Smith',
        title: 'VP Customer Success',
        company: 'Acme Security',
        relationshipType: 'employee',
        responseStatus: 'not_contacted',
      }],
    }], { now: new Date('2026-05-04T12:00:00.000Z') });

    assert.equal(contacts.contacts[0].experienceMatchPct, 74);
  });

  it('builds operational analytics', () => {
    // Command Center sections only surface jobs with activity on/after the
    // 2026-09-01 display cutoff, so this fixture is dated after it.
    const recentJob = { ...job, date_updated: '2026-09-10' };
    const model = buildAnalyticsSummary([recentJob], { now: new Date('2026-09-27T12:00:00.000Z') });
    assert.equal(model.activeOpportunities, 1);
    assert.equal(model.stageDistribution.applied, 1);
    assert.equal(model.averageActiveAtsScore, 82);
    assert.equal(model.followUpDebt.count, 1);
    assert.equal(model.searchScoring.topPriorities.length, 1);
    assert.equal(model.searchScoring.topPriorities[0].jobId, 'job1');
    assert.ok(model.searchScoring.outcomeLearning.source);
    assert.equal(model.commandCenter.priorityQueue[0].jobId, 'job1');
    assert.equal(model.commandCenter.dailyDigest.followUpsDue.length, 1);
    assert.equal(model.commandCenter.staleCleanup[0].recommendedAction, 'follow_up');
    assert.equal(model.commandCenter.companyResearch[0].company, 'Acme Security');
    assert.ok(model.commandCenter.resumeFeedback[0].replyRate >= 0);
  });

  it('builds settings health without exposing secret values', async () => {
    const model = await buildSettingsHealth({
      env: {
        CAREER_OPS_DATA_DIR: '/tmp/career-data',
        CAREER_OPS_CONFIG_DIR: '/tmp/career-config',
        GMAIL_CLIENT_ID: 'client',
      },
      healthChecks: [{ status: 'WARN', name: 'Gmail OAuth env', message: 'partial' }],
    });
    assert.equal(model.integrations.gmailOAuth.configured, false);
    assert.deepEqual(model.integrations.gmailOAuth.missingKeys, ['GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']);
    assert.doesNotMatch(JSON.stringify(model), /client/);
  });
});
