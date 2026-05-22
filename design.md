# Career Ops Frontend Redesign Specification

## 1. Product Vision

Career Ops is a local-first, privacy-focused, AI-assisted operating system for enterprise-level job searching. It turns a fragmented job hunt into a daily command center: evaluate opportunities, optimize resumes, track outreach, manage recruiters, review ambiguous email signals, and decide exactly what to do next.

The redesigned frontend should feel like a serious workflow tool for a high-agency professional. It is not a job board, a CRM clone, or a generic analytics dashboard. It is a fast, dense, calm workspace for converting opportunities into interviews with minimal cognitive overhead.

Primary product promise:

> Open Career Ops and know, within seconds, what deserves attention today.

The interface should prioritize:

1. What should I do next?
2. Fast job triage
3. Resume optimization workflow
4. Follow-up management
5. Application pipeline visibility
6. AI-assisted recommendations

## 2. UX Philosophy

### Local-First Confidence

The product should make local-first operation feel intentional and premium, not technical. Users should understand that sensitive data, resume materials, Gmail-derived signals, recruiter notes, and generated drafts are treated as private working memory.

Design cues:

- Quiet local status indicators
- Clear sync freshness timestamps
- No cloud-heavy language unless an integration is explicitly involved
- Settings that expose file paths and config health without feeling like a developer console

### Action Over Browsing

Every major screen should answer:

- What is most important?
- Why does it matter?
- What action can I take now?
- What happens if I ignore it?

The UI should avoid passive reporting. Tables, cards, and panels should surface the next action directly.

### Dense But Calm

Career Ops should support power usage without visual overload. Use compact spacing, strong alignment, restrained borders, and clear hierarchy. Avoid oversized marketing layouts, decorative cards, and generic dashboard widgets.

Inspiration:

- Linear for issue density, keyboard workflow, and status clarity
- Notion for composable workspaces and soft document structure
- Superhuman for speed, shortcuts, and message triage
- Raycast for command palette behavior and action-first search
- Modern cybersecurity SaaS dashboards for urgency, confidence, and operational posture
- Executive workflow software for priority briefings and clean decision surfaces

### AI As Advisor, Not Mascot

AI should appear as concise intelligence embedded in workflow context. Avoid toy-like AI chat bubbles, sparkles, oversized assistant avatars, and vague recommendations. AI outputs should be inspectable, dismissible, and tied to clear actions.

Good AI pattern:

- "Resume missing quantified infrastructure impact. Add metric before generating final version."
- Actions: `Improve evidence`, `Generate anyway`, `Dismiss`

Poor AI pattern:

- "Hi, I am your career assistant! How can I help?"

## 3. Core Workflows

### Daily Command Review

Goal: The user opens the app and completes the day's highest-leverage tasks.

Flow:

1. Review command summary: urgent follow-ups, stale leads, ambiguous Gmail matches, jobs needing resume, ready-to-apply jobs, interviews/prep.
2. Open the top recommended item.
3. Take a focused action: generate resume, apply, send outreach, follow up, prep interview, archive.
4. Mark workflow event or add note.
5. Move to next recommended item.

Success state: User can finish a daily pass without hunting through tables.

### Job Intake And Triage

Goal: Decide whether a job is worth pursuing.

Flow:

1. Scan/import/discover jobs.
2. Review title, company, source, date, match score, detected seniority, location, compensation if available.
3. AI evaluation summarizes fit, risks, missing evidence, and likely ATS alignment.
4. User chooses: pursue, hold, archive, needs more research.
5. Job enters workflow timeline as discovered/evaluated.

Success state: Low-value jobs are filtered quickly; promising jobs are promoted into active workflow.

### Resume Optimization

Goal: Generate and manage role-specific resumes with score visibility.

Flow:

1. Open job detail or Resume Workspace.
2. Review existing generated resume versions.
3. See ATS/evaluator score, generated timestamp, strategy/variant, and file link.
4. Review source quality coach warnings: missing metrics, weak mechanisms, missing technical depth.
5. Generate or regenerate resume.
6. Compare metadata across versions without full diff engine.

Success state: User understands which resume is best and why.

### Gmail Signal Review

Goal: Process Gmail-derived job signals without corrupting statuses.

Flow:

1. Dashboard surfaces ambiguous Gmail matches.
2. User reviews subject, sender, detected company/title, confidence, candidates.
3. User attaches email to selected job or dismisses ambiguity.
4. No automatic job status change occurs from ambiguous events.

Success state: Gmail ambiguity is resolved safely and quickly.

### Recruiter And Outreach Management

Goal: Track contacts and generate useful outreach.

Flow:

1. Add or edit recruiter/contact records per job.
2. Capture name, role/title, company, relationship type, LinkedIn URL, email, response status, follow-up due date.
3. Generate outreach draft for LinkedIn connection, LinkedIn follow-up, or email.
4. Review draft in copy-friendly format.
5. Mark outreach sent, response received, or follow-up completed.

Success state: Outreach is organized by opportunity and directly tied to job workflow.

### Interview Preparation

Goal: Surface interview-related work when timeline/status indicates it.

Flow:

1. Dashboard highlights interview scheduled/prep needed.
2. Job detail shows relevant timeline events, contact context, resume version, and evaluation notes.
3. User reviews AI prep notes when available.
4. User marks prep complete or adds notes.

Success state: Interview prep is visible without calendar integration.

## 4. Information Architecture

Primary structure:

- Command Center
- Jobs
- Resume
- Outreach
- Contacts
- Gmail Review
- Analytics
- Settings

Secondary object model:

- Job
- Workflow timeline event
- Resume version
- Contact
- Outreach draft
- Gmail ambiguity
- Evaluation/ATS score
- Source quality finding
- Note

Recommended route model:

- `/` Command Center dashboard
- `/jobs` Job list and triage
- `/jobs/:id` Job detail workspace
- `/resume` Resume workspace
- `/outreach` Outreach workspace
- `/contacts` Recruiter/contact workspace
- `/gmail-review` Ambiguous Gmail review
- `/analytics` Analytics and insights
- `/settings` Configuration and health

## 5. Navigation Structure

### Sidebar

Use a persistent left sidebar on desktop and tablet. Collapse to icon-only at narrower widths. On mobile, use a command-first bottom sheet or compact top nav with menu.

Suggested sidebar sections:

Primary:

- Command Center
- Jobs
- Resume
- Outreach
- Contacts

Signals:

- Gmail Review
- Follow-ups
- Stale Leads

System:

- Analytics
- Settings

Footer:

- Local status
- Last scan
- Gmail sync freshness
- Health indicator

Sidebar behavior:

- Active item has subtle filled background and left accent bar.
- Badge counts show only actionable items, not total records.
- Keyboard shortcut hints appear on hover or in command palette, not always visible.

### Top Navigation

Use a compact top bar inside the content area.

Contents:

- Page title
- Current view/filter summary
- Global search trigger
- Command palette trigger
- Primary page action
- Local sync/health indicator

Avoid large headers. The top nav should be operational, not decorative.

### Command Palette

Command palette is a core interaction, similar to Raycast or Linear.

Trigger:

- `Cmd+K` / `Ctrl+K`

Capabilities:

- Search jobs, companies, contacts, drafts, resume versions
- Run actions: generate resume, add contact, mark outreach sent, add note, dismiss Gmail ambiguity
- Jump to views
- Filter by status, next action, stale, follow-up due
- Create workflow event

Palette result anatomy:

- Icon
- Entity/action name
- Context line
- Status/priority pill
- Shortcut hint if available

Palette should support typed action phrases:

- "follow up stripe"
- "generate resume datadog"
- "add recruiter acme"
- "stale jobs"
- "gmail ambiguous"

## 6. Dashboard Layout

The dashboard is the daily command surface. It should be compact, scan-friendly, and actionable.

### Desktop Layout

Recommended structure:

- Left sidebar
- Top command bar
- Main content with two-column grid
- Right intelligence rail

Main content:

1. Today's Priority Stack
2. Pipeline Snapshot
3. Urgent Follow-ups
4. Jobs Ready To Apply
5. Stale Leads
6. Ambiguous Gmail Matches

Right rail:

1. Next Best Action
2. Local Health
3. Recent Activity
4. AI Observations

### Dashboard Sections

#### Today's Priority Stack

Purpose: The highest-leverage items ordered by urgency and opportunity value.

Each item:

- Job/company
- Reason it is prioritized
- Next best action
- Age/snooze/follow-up deadline
- Primary action button
- Secondary actions menu

Example:

```text
Datadog - Staff Platform Engineer
Applied 8 days ago, no follow-up sent
Action: Send follow-up
Score 87 | Contact: Maya Chen | Last activity: May 1
```

#### Pipeline Snapshot

Purpose: Compact visibility into current job funnel.

Display:

- Discovered
- Evaluated
- Resume generated
- Applied
- Outreach sent
- Recruiter reply
- Interview scheduled
- Rejected

Use a horizontal segmented funnel or compact bar list. Each segment is clickable and filters jobs.

#### Urgent Follow-ups

Purpose: Show contacts/jobs with due or overdue follow-up.

Columns:

- Company/job
- Contact
- Last event
- Due date
- Recommended action

#### Jobs Ready To Apply

Purpose: Jobs with adequate evaluation/resume readiness but not applied.

Show:

- Company/title
- Fit/ATS score
- Resume status
- Missing evidence warning if any
- Apply action

#### Ambiguous Gmail Matches

Purpose: Safe review for uncertain email-to-job matches.

Show:

- Subject
- Sender
- Detected company/title
- Confidence
- Candidate count
- Attach/dismiss actions

#### Stale Leads

Purpose: Identify neglected opportunities.

Show:

- Company/title
- Last activity
- Current state
- Staleness reason
- Suggested action

## 7. Page-By-Page Breakdown

### Main Dashboard / Command Center

Primary question:

> What needs attention today?

Key modules:

- Priority stack
- Next best action panel
- Pipeline summary
- Urgent follow-ups
- Stale lead detection
- Ambiguous Gmail review preview
- Jobs needing resume
- Jobs ready to apply
- Interview/prep needed
- Recent workflow activity

Primary actions:

- Start daily review
- Open top priority
- Generate resume
- Send outreach
- Mark follow-up done
- Review Gmail ambiguity
- Archive stale job

Design notes:

- The first visible content should be operational priorities, not charts.
- Use badges sparingly for urgency and state.
- Avoid separate cards for every metric; combine related information into dense panels.

### Jobs List / Triage

Primary question:

> Which opportunities are worth pursuing?

Layout:

- Filter bar
- Dense table/list
- Preview panel on desktop
- Saved views

Filters:

- Status
- Next best action
- Score range
- Source
- Stale
- Resume needed
- Applied
- Has contact
- Has Gmail ambiguity
- Interview

List columns:

- Company
- Title
- Score
- Workflow state
- Next action
- Last activity
- Resume
- Contact
- Source

Row behavior:

- Single click selects and previews.
- Double click or Enter opens detail.
- Keyboard arrows move selection.
- `A` archive, `G` generate resume, `O` outreach, `N` note.

### Job Command Center

Primary question:

> What is the operational state of this job?

This can be either the job detail page or a focused section within it.

Layout:

- Header with company/title/status/score
- Next best action banner
- Workflow state strip
- Main workspace tabs
- Right context rail

Header contents:

- Company
- Job title
- Current workflow state
- Fit score / ATS score
- Source
- Last activity
- Primary action

Workflow state strip:

- Discovered
- Evaluated
- Resume generated
- Applied
- Outreach sent
- Recruiter reply
- Interview scheduled
- Rejected

State strip behavior:

- Completed states are checked/subtle.
- Current state is emphasized.
- Future states are muted.
- Clicking a state filters timeline to related events or offers manual mark action where valid.

### Job Detail Workspace

Primary question:

> What do I know about this opportunity, and what should happen next?

Sections:

- Overview
- Evaluation
- Resume versions
- Contacts
- Outreach drafts
- Gmail signals
- Timeline
- Notes

Recommended desktop layout:

- Main column: overview, evaluation, resume, timeline
- Right rail: next action, contacts, drafts, health warnings

Primary actions:

- Generate resume
- Mark applied
- Add contact
- Generate outreach
- Add note
- Mark workflow event
- Archive

### Resume Workspace

Primary question:

> Which roles need resume work, and which resume version is strongest?

Views:

- Resume queue
- Version history by job
- Source quality coach
- Generated documents

Resume queue item anatomy:

- Company/title
- Fit score
- ATS/evaluator score
- Resume status
- Missing evidence categories
- Last generated version
- Primary action

Version history metadata:

- Generated at
- Strategy/variant
- ATS/evaluator score
- Source job id/company/title
- File name/docx URL

Source quality coach:

- Missing metrics
- Missing mechanisms
- Missing stakeholders
- Missing tools/platforms
- Missing business outcomes
- Missing technical depth

Coach output should be concise and question-based:

- "Which platform reliability metric improved?"
- "Who used the system, and what business process changed?"
- "What tools or infrastructure were involved?"

### Outreach Workspace

Primary question:

> Who needs a message, and what should I send?

Views:

- Due follow-ups
- Drafts
- Sent outreach
- Replies
- By contact
- By company

Draft anatomy:

- Recipient/contact
- Job/company
- Message type
- Generated timestamp
- Draft text
- Source context
- Copy action
- Regenerate action
- Mark sent action

Message types:

- LinkedIn connection request
- LinkedIn follow-up
- Email

Important rule:

- Never send automatically.
- Generated messages are drafts until the user copies or marks sent.

### Recruiter/Contact Workspace

Primary question:

> Which people are connected to which opportunities, and what is owed?

Contact fields:

- Name
- Role/title
- Company
- Relationship type
- LinkedIn URL
- Email
- Response status
- Follow-up due date
- Associated jobs
- Notes

Relationship types:

- Recruiter
- Hiring manager
- Referral
- Employee

Contact panel anatomy:

- Name and role
- Relationship badge
- Company
- LinkedIn/email actions
- Response status
- Follow-up due date
- Recent outreach
- Associated job
- Add note / mark outreach sent / generate draft

### Workflow Timeline

Primary question:

> What happened, when, and what changed?

Timeline event types:

- Discovered
- Evaluated
- Resume generated
- Applied
- Outreach sent
- Follow-up done
- Recruiter reply
- Interview scheduled
- Rejected
- Note
- Gmail signal attached
- Ambiguity dismissed

Timeline anatomy:

- Timestamp
- Event icon
- Event type
- Actor/source: manual, Gmail, scan, AI, system
- Summary
- Optional note
- Related entity links: contact, resume version, Gmail message, draft

Timeline behavior:

- Newest first by default.
- Compact mode on dashboard.
- Full mode on job detail.
- Filters by event type.
- Manual entries clearly distinguish user action from inferred/system events.

### Gmail Review

Primary question:

> Which email signals need manual resolution?

Views:

- Ambiguous
- Attached
- Dismissed

Ambiguous match row:

- Subject
- Sender
- Detected company/title
- Confidence
- Match candidates
- Received date if available
- Attach action
- Dismiss action

Candidate selector:

- Company/title
- Status
- Last activity
- Confidence/reason

Safety rule:

- Ambiguous Gmail actions should attach or dismiss only. Do not auto-modify job status from ambiguous events.

### Analytics / Insights

Primary question:

> Is the job search pipeline healthy?

Modules:

- Pipeline distribution
- Conversion by stage
- Average time since last activity
- Resume score distribution
- Outreach response status
- Follow-up debt
- Stale lead trend
- Source quality gaps

Keep charts simple and operational. Avoid vanity analytics.

Useful metrics:

- Active opportunities
- Jobs needing resume
- Ready to apply
- Applied without follow-up
- Outreach awaiting response
- Interviews scheduled
- Rejections
- Average score of active pipeline

### Settings / Config

Primary question:

> Is my local system configured and healthy?

Sections:

- Local paths
- Profile configuration
- Gmail/OAuth status
- Resume template status
- LM Studio/local model status
- Runtime data locations
- Ignored/private files
- Health checks

Settings should be clear enough for technical users but not require code knowledge.

Show:

- Config file present/missing
- Last modified timestamp
- Health status
- Action or instruction

Do not expose secrets.

## 8. Component Hierarchy

Recommended top-level components:

- `AppShell`
- `SidebarNav`
- `TopCommandBar`
- `CommandPalette`
- `HealthIndicator`
- `DashboardPage`
- `JobsPage`
- `JobDetailPage`
- `ResumePage`
- `OutreachPage`
- `ContactsPage`
- `GmailReviewPage`
- `AnalyticsPage`
- `SettingsPage`

Core domain components:

- `PriorityStack`
- `NextBestActionPanel`
- `PipelineSummary`
- `JobTable`
- `JobPreview`
- `JobHeader`
- `WorkflowStateStrip`
- `WorkflowTimeline`
- `TimelineEvent`
- `ResumeVersionList`
- `SourceQualityCoach`
- `ContactPanel`
- `ContactEditor`
- `OutreachDraftPanel`
- `GmailAmbiguityReview`
- `AiInsightPanel`
- `StaleLeadList`
- `FollowUpQueue`

Foundation components:

- `Button`
- `IconButton`
- `Input`
- `Textarea`
- `Select`
- `Combobox`
- `Badge`
- `StatusPill`
- `ScoreBadge`
- `DataTable`
- `EmptyState`
- `LoadingState`
- `ErrorBanner`
- `Toast`
- `Popover`
- `DropdownMenu`
- `Tabs`
- `SegmentedControl`
- `Tooltip`
- `KeyboardShortcut`

## 9. Design System Guidance

### Overall Visual Direction

Style:

- Minimal
- High-density
- Premium operational software
- Calm contrast
- Sharp alignment
- Subtle depth
- Low ornamentation

Avoid:

- Big rounded marketing cards
- Excessive gradients
- Decorative blobs
- Large empty hero areas
- Generic admin templates
- Cartoon AI styling

### Shape

- Cards: 6-8px radius
- Buttons: 6px radius
- Inputs: 6px radius
- Badges: 999px radius only for small pills
- Panels: subtle border, minimal shadow

### Spacing

Use an 8px spacing grid.

Recommended scale:

- 4px micro gaps
- 8px component internal rhythm
- 12px compact panel gaps
- 16px section gaps
- 24px page group gaps
- 32px only for major separation

### Density Modes

Consider supporting density preferences:

- Comfortable
- Compact

Default should be compact but readable.

## 10. Typography

Recommended fonts:

- Primary UI: Inter, Geist Sans, or SF Pro
- Monospace/data: JetBrains Mono, Geist Mono, or SF Mono

Type scale:

- Page title: 20-24px, 600
- Section title: 14-16px, 600
- Body: 13-14px, 400
- Table text: 12-13px, 400
- Metadata: 11-12px, 400
- Badge: 11-12px, 500

Guidelines:

- Use tabular numbers for counts, dates, and scores.
- Avoid large hero typography.
- Keep letter spacing at 0.
- Use weight and spacing before color to create hierarchy.

## 11. Color Palette

Use a neutral base with restrained semantic accents. The interface should not be dominated by one hue.

Recommended palette:

Base:

- Background: `#F7F8FA`
- Surface: `#FFFFFF`
- Surface muted: `#F1F3F5`
- Border: `#DDE1E6`
- Border subtle: `#E8EBEF`
- Text primary: `#171A1F`
- Text secondary: `#4E5968`
- Text muted: `#7A8493`

Dark mode optional:

- Background: `#0F1115`
- Surface: `#151922`
- Surface muted: `#1D2330`
- Border: `#2B3240`
- Text primary: `#F4F6F8`
- Text secondary: `#B6C0CC`
- Text muted: `#788394`

Semantic:

- Action blue: `#2563EB`
- Success green: `#16A34A`
- Warning amber: `#D97706`
- Danger red: `#DC2626`
- Info cyan: `#0891B2`
- AI accent violet: `#7C3AED`, used sparingly

Workflow states:

- Discovered: neutral gray
- Evaluated: cyan
- Resume generated: violet
- Applied: blue
- Outreach sent: amber
- Recruiter reply: green
- Interview scheduled: emerald
- Rejected: red/gray depending on emphasis

Color use:

- Use semantic color for status and urgency only.
- Avoid full-panel color fills except critical alerts.
- Keep AI accent subtle and rare.

## 12. Interaction Patterns

### Keyboard-Driven Workflow

Core shortcuts:

- `Cmd/Ctrl+K`: command palette
- `/`: search current view
- `J` / `K`: move selection down/up
- `Enter`: open selected item
- `Esc`: close panel or clear selection
- `G`: generate resume for selected job
- `O`: generate outreach
- `A`: mark applied or archive depending context; avoid ambiguity by showing hint
- `N`: add note
- `F`: mark follow-up done
- `R`: mark recruiter reply
- `?`: shortcuts overlay

Shortcuts should be discoverable but not visually noisy.

### Inline Actions

Prefer inline actions and right rail panels over modals.

Use modals only for:

- Destructive confirmation
- Complex edit forms that need focus
- First-time setup flows

### Progressive Disclosure

Show compact summaries by default. Let users expand for detail.

Examples:

- AI recommendation shows one-line reason, expandable evidence.
- Resume version shows score/strategy/date, expandable generation metadata.
- Timeline event shows summary, expandable raw note/source.

### Optimistic Updates

For local-first actions, UI can update immediately with graceful rollback on error.

Examples:

- Mark outreach sent
- Dismiss ambiguity
- Add note
- Save contact

Show subtle success toasts, not interruptive dialogs.

## 13. Card, Table, And List Behaviors

### Card Anatomy

Use cards for discrete actionable records, not for every page section.

Standard card:

- Header: entity name and status
- Metadata row: score, date, source, owner/contact
- Body: concise reason or summary
- Action row: primary action plus overflow menu
- Footer optional: timeline snippet or warning

### Job Card Anatomy

- Company
- Title
- Workflow state
- Fit/ATS score
- Next best action
- Last activity
- Contact/resume indicators
- Primary action

### AI Recommendation Anatomy

- Recommendation title
- Confidence or priority
- Reason
- Evidence references
- Impact if ignored
- Primary action
- Dismiss/snooze

Example:

```text
Send follow-up today
Applied 8 days ago. Contact exists. No outreach after application.
Action: Generate follow-up draft
```

### Timeline Event Anatomy

- Icon
- Event label
- Timestamp
- Source
- Summary
- Optional note
- Related artifact links

### Tables

Use tables for dense scanning and batch workflows.

Table behavior:

- Sticky header
- Sortable columns
- Resizable columns if practical
- Row hover actions
- Keyboard selection
- Saved filters
- Empty states per filter

Avoid:

- Overly tall rows
- Action buttons in every column
- Low-contrast text

### Lists

Use lists for priority queues and timeline previews.

List item behavior:

- Clear selection state
- Right-aligned status/age
- Inline primary action
- Overflow menu

## 14. Responsive Behavior

### Desktop

Target: 1280px and wider.

Layout:

- Persistent sidebar
- Main content
- Optional right rail
- Dense tables
- Split preview panels

### Tablet

Target: 768-1279px.

Layout:

- Collapsible sidebar
- Right rail moves below or into tabs
- Tables become narrower with configurable columns
- Job detail uses stacked panels

### Mobile

Target: below 768px.

Mobile is for quick review and action, not full configuration.

Layout:

- Top bar with menu and command button
- Bottom action bar for selected job
- Priority stack first
- Cards/lists over tables
- Timeline compact mode
- Forms use full-screen sheets

Mobile priorities:

1. See today's priorities
2. Mark actions done
3. Review follow-ups
4. Copy outreach draft
5. Check job detail summary

Do not attempt to reproduce every desktop table on mobile.

## 15. Accessibility Guidance

Requirements:

- WCAG AA contrast for text and controls
- Full keyboard navigation
- Visible focus states
- Screen reader labels for icon-only buttons
- Do not rely on color alone for status
- Respect reduced motion preferences
- Provide accessible names for command palette results
- Use semantic headings and landmarks
- Ensure toasts are announced politely

Focus behavior:

- Command palette traps focus while open.
- Closing panels returns focus to trigger.
- Row selection should be keyboard-visible.
- Modal usage should be rare and accessible.

## 16. Empty, Loading, And Error States

### Empty States

Empty states should be practical, not whimsical.

Examples:

- No urgent follow-ups: "No follow-ups due. Review stale leads or generate resumes."
- No Gmail ambiguities: "All Gmail signals are resolved."
- No contacts: "Add a recruiter, hiring manager, referral, or employee contact for this job."
- No resume versions: "Generate the first role-specific resume for this job."

Include one clear next action where appropriate.

### Loading States

Use skeleton rows and panels for predictable structures.

For AI generation:

- Show stage labels:
  - Reading job context
  - Checking profile evidence
  - Drafting recommendation
  - Saving result

Avoid theatrical loading animations.

### Error States

Errors should be specific and recoverable.

Examples:

- "Gmail jobs file is unavailable."
- "Contact name is required."
- "Outreach draft was not saved."
- "Local model unavailable. Template fallback used."

Include:

- What failed
- Whether data was changed
- Suggested next action

## 17. AI Interaction Patterns

### Embedded AI Panels

AI should appear in context:

- Job evaluation summary
- Next best action reason
- Resume evidence gaps
- Outreach draft explanation
- Interview prep notes

AI panel anatomy:

- Label: "AI Insight" or specific title
- Short recommendation
- Evidence
- Confidence/priority
- Actions
- Dismiss/snooze

### AI Recommendation Rules

Recommendations must be:

- Short
- Specific
- Evidence-backed
- Actionable
- Dismissible
- Non-destructive by default

Never auto-send outreach.
Never auto-apply.
Never auto-change status from ambiguous Gmail events.

### AI Confidence

Use confidence sparingly. Prefer human-readable certainty:

- High confidence
- Needs review
- Weak evidence
- Ambiguous match

### AI Fallbacks

When local LM is unavailable:

- Use deterministic templates
- Clearly label generated content as template fallback
- Do not block workflow

## 18. Motion And Animation Guidance

Motion should communicate state changes, not decorate.

Use:

- 120-180ms transitions for hover/focus
- 160-220ms panel slide/fade
- Subtle row insertion animation
- Smooth command palette open/close
- Tiny progress indicator for generation

Avoid:

- Bouncy effects
- Long transitions
- Decorative looping animations
- Overanimated charts

Respect `prefers-reduced-motion`.

## 19. Workflow Prioritization Logic

The UI should consistently order work by urgency, value, and readiness.

Priority inputs:

- Workflow state
- Last activity date
- Fit/ATS score
- Resume availability
- Follow-up due date
- Contact availability
- Gmail signals
- Interview status
- Stale lead age
- Ambiguity count

Suggested next-best-action rules:

- If interview scheduled and prep not done: `prep_interview`
- If applied and no follow-up after threshold: `follow_up`
- If recruiter reply exists and no response action recorded: `follow_up`
- If evaluated and no resume generated: `generate_resume`
- If resume generated and not applied: `apply`
- If active job has contact but no outreach: `send_outreach`
- If stale with low score or rejected: `archive`
- If ambiguous Gmail match exists: `review_match`

Stale detection:

- No activity for configurable X days
- Applied but no follow-up
- Outreach sent but no response after threshold
- Resume generated but application not marked

Urgency levels:

- Critical: interview/prep today, overdue follow-up, high-score stale lead
- High: applied without follow-up, recruiter reply, ready-to-apply high score
- Medium: resume needed, contact outreach available, Gmail ambiguity
- Low: low score stale lead, archived/rejected, incomplete data

## 20. Example Layouts And Wireframe Descriptions

### Dashboard Desktop Wireframe

```text
┌──────────────┬─────────────────────────────────────────────┬──────────────────────┐
│ Sidebar      │ Top Command Bar                             │ Health / Shortcuts   │
├──────────────┼─────────────────────────────────────────────┼──────────────────────┤
│ Command      │ Today's Priority Stack                      │ Next Best Action     │
│ Jobs         │ ┌─────────────────────────────────────────┐ │ ┌──────────────────┐ │
│ Resume       │ │ Job priority item + action              │ │ │ Recommendation   │ │
│ Outreach     │ │ Job priority item + action              │ │ │ Reason           │ │
│ Contacts     │ └─────────────────────────────────────────┘ │ │ Action           │ │
│ Gmail Review │ Pipeline Snapshot                          │ └──────────────────┘ │
│ Analytics    │ Urgent Follow-ups | Ready To Apply          │ Recent Activity      │
│ Settings     │ Stale Leads | Gmail Ambiguities             │ AI Observations      │
└──────────────┴─────────────────────────────────────────────┴──────────────────────┘
```

### Job Detail Desktop Wireframe

```text
┌──────────────┬─────────────────────────────────────────────┬──────────────────────┐
│ Sidebar      │ Job Header                                  │ Next Action          │
│              │ Workflow State Strip                        │ Contacts             │
│              │ Tabs: Overview Resume Outreach Timeline     │ Drafts               │
│              │                                             │ Gmail Signals        │
│              │ Evaluation Summary                          │                      │
│              │ Resume Versions                             │                      │
│              │ Timeline                                    │                      │
└──────────────┴─────────────────────────────────────────────┴──────────────────────┘
```

### Mobile Priority Flow

```text
┌─────────────────────────┐
│ Top bar + command       │
├─────────────────────────┤
│ Today's top action      │
├─────────────────────────┤
│ Priority cards          │
├─────────────────────────┤
│ Follow-ups              │
├─────────────────────────┤
│ Ready to apply          │
├─────────────────────────┤
│ Bottom action sheet     │
└─────────────────────────┘
```

## 21. Recommended Frontend Stack

Recommended:

- React
- TypeScript
- Vite
- TanStack Router or React Router
- TanStack Query for server/cache state
- Zustand or Jotai for local UI state
- TanStack Table for dense tables
- Radix UI primitives for accessible interactions
- Lucide icons
- CSS Modules, Tailwind CSS, or vanilla-extract
- Playwright for UI verification
- Vitest for component/unit tests

If preserving current vanilla frontend:

- Keep components modular under `public/js/components`
- Add a small client-side store module
- Use declarative render functions per page
- Avoid adding framework complexity until redesign implementation begins

## 22. Recommended State Management

Use separate state categories:

Server/local runtime data:

- Jobs
- Gmail ambiguities
- Contacts
- Timeline events
- Resume versions
- Outreach drafts
- Health status

Recommended tool: TanStack Query or equivalent fetch/cache layer.

UI state:

- Selected job
- Open panels
- Active filters
- Command palette state
- Table sort/column visibility
- Density mode

Recommended tool: Zustand/Jotai or simple reducer store.

Persistent user preferences:

- Density
- Theme
- Last selected view
- Saved filters
- Column visibility

Store locally, not in tracker data unless needed for app behavior.

## 23. Suggested Component Organization

```text
src/
  app/
    AppShell.tsx
    routes.tsx
    providers.tsx
  components/
    foundation/
      Button.tsx
      Input.tsx
      Badge.tsx
      DataTable.tsx
      CommandPalette.tsx
    layout/
      SidebarNav.tsx
      TopCommandBar.tsx
      RightRail.tsx
    workflow/
      WorkflowStateStrip.tsx
      WorkflowTimeline.tsx
      TimelineEvent.tsx
      NextBestActionPanel.tsx
    jobs/
      JobTable.tsx
      JobCard.tsx
      JobHeader.tsx
      JobPreview.tsx
    resume/
      ResumeVersionList.tsx
      SourceQualityCoach.tsx
    outreach/
      OutreachDraftPanel.tsx
      FollowUpQueue.tsx
    contacts/
      ContactPanel.tsx
      ContactEditor.tsx
    gmail/
      GmailAmbiguityReview.tsx
    ai/
      AiInsightPanel.tsx
      RecommendationCard.tsx
  pages/
    DashboardPage.tsx
    JobsPage.tsx
    JobDetailPage.tsx
    ResumePage.tsx
    OutreachPage.tsx
    ContactsPage.tsx
    GmailReviewPage.tsx
    AnalyticsPage.tsx
    SettingsPage.tsx
  data/
    api.ts
    queries.ts
    mutations.ts
  state/
    uiStore.ts
    preferencesStore.ts
  styles/
    tokens.css
    global.css
```

## 24. Implementation Priorities

Phase 1: Information Architecture And Shell

- App shell
- Sidebar
- Top command bar
- Command palette scaffold
- Dashboard priority layout
- Job detail layout

Phase 2: Operational Workflows

- Next best action panel
- Workflow timeline
- Follow-up queue
- Stale lead list
- Gmail ambiguity review
- Contact panel

Phase 3: Resume And Outreach Workspaces

- Resume version history
- Source quality coach
- Outreach draft display
- Contact-linked draft generation
- Copy-friendly draft interactions

Phase 4: Analytics And Settings

- Pipeline health
- Source quality trends
- Local health/config screen
- Non-secret CI/health visibility

Phase 5: Polish

- Keyboard shortcuts
- Saved filters
- Responsive refinements
- Accessibility pass
- Motion polish
- Empty/loading/error states

## 25. Design Guardrails

Do:

- Make the next action obvious.
- Keep rows and cards dense.
- Put AI inside the workflow.
- Make local-first status visible but quiet.
- Design for daily repetition.
- Let keyboard users move quickly.
- Keep manual review explicit for ambiguous data.

Do not:

- Redesign into a marketing site.
- Use generic bootstrap admin visuals.
- Hide critical actions in nested menus.
- Make AI feel like a chatbot overlay.
- Auto-send or auto-apply.
- Auto-change status from ambiguous Gmail events.
- Use charts where a queue is more useful.
- Overuse modals.

## 26. North Star Experience

The ideal Career Ops session feels like this:

1. The user opens the app.
2. The dashboard immediately shows the top five actions that matter.
3. The user presses `Cmd+K`, jumps to the most important job, reviews the reason, and acts.
4. Resume, outreach, contacts, Gmail signals, and timeline are all visible in context.
5. The system records what happened.
6. The next priority moves into focus.

The product should feel less like managing a database and more like operating a precise, private command center for career momentum.
