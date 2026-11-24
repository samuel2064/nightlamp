// Declarative feedback form definitions for the flows the current backend
// response contract supports (NOC-161 addendum + a48ae78 contract):
// bug_report, feature_request and general. Screenshot annotation, email
// follow-up and similar-request behavior are deliberately absent: the backend
// response store accepts scalars only and there is no contract for images,
// annotations or upvotes. Free text belongs to the protected response store
// and is never placed in analytics, URLs or unprotected local storage.

import { FEEDBACK_TYPES, type FeedbackType } from './contract'

export type FeedbackField =
  | {
      kind: 'single'
      id: string
      label: string
      options: { value: string; label: string }[]
    }
  | { kind: 'text'; id: string; label: string; required?: boolean; placeholder?: string; rows?: number }
  | { kind: 'textarea'; id: string; label: string; required?: boolean; placeholder?: string; rows?: number }

export interface FeedbackDefinition {
  feedback_type: FeedbackType
  title: string
  description?: string
  fields: FeedbackField[]
  submitLabel: string
}

const OPTION_BUG_TYPES = [
  { value: 'bug', label: 'Bug or crash' },
  { value: 'performance', label: 'Performance' },
  { value: 'ui', label: 'UI issue' },
  { value: 'other', label: 'Other' },
]

const OPTION_SEVERITY = [
  { value: 'critical', label: 'Critical - blocks my work' },
  { value: 'high', label: 'High - major issue' },
  { value: 'medium', label: 'Medium - minor issue' },
  { value: 'low', label: 'Low - cosmetic' },
]

const OPTION_PRIORITY = [
  { value: 'must_have', label: 'Must have - blocks my workflow' },
  { value: 'nice_to_have', label: 'Nice to have - improves the experience' },
  { value: 'dream', label: 'Dream feature - would love it' },
]

const OPTION_GENERAL_TOPICS = [
  { value: 'onboarding', label: 'Onboarding and setup' },
  { value: 'alerts', label: 'Alerts and incidents' },
  { value: 'playbooks', label: 'Playbooks and remediation' },
  { value: 'billing', label: 'Plans and billing' },
  { value: 'other', label: 'Something else' },
]

const MIN_TEXT = 2
const MAX_TEXT = 4000

export const FEEDBACK_DEFINITIONS: Record<FeedbackType, FeedbackDefinition> = {
  bug_report: {
    feedback_type: 'bug_report',
    title: 'Report a bug',
    description: 'Tell us what broke. We read every report during the beta.',
    submitLabel: 'Submit report',
    fields: [
      { kind: 'single', id: 'bug_type', label: 'What kind of issue is it?', options: OPTION_BUG_TYPES },
      { kind: 'single', id: 'severity', label: 'How severe is it?', options: OPTION_SEVERITY },
      {
        kind: 'textarea',
        id: 'description',
        label: 'What happened?',
        required: true,
        placeholder: 'Describe the issue and what you expected instead.',
        rows: 4,
      },
      {
        kind: 'textarea',
        id: 'steps_to_reproduce',
        label: 'Steps to reproduce (optional)',
        placeholder: '1. I opened ... 2. I clicked ...',
        rows: 3,
      },
    ],
  },
  feature_request: {
    feedback_type: 'feature_request',
    title: 'Request a feature',
    description: 'Shape the beta with what you need next.',
    submitLabel: 'Submit request',
    fields: [
      { kind: 'text', id: 'title', label: 'Short title', required: true, placeholder: 'Weekly digest emails' },
      {
        kind: 'textarea',
        id: 'description',
        label: 'Describe the feature',
        required: true,
        placeholder: 'What should it do, and when would you use it?',
        rows: 4,
      },
      { kind: 'single', id: 'priority', label: 'How important is it to you?', options: OPTION_PRIORITY },
      {
        kind: 'textarea',
        id: 'workaround',
        label: 'Current workaround (optional)',
        placeholder: 'What do you do today instead?',
        rows: 3,
      },
    ],
  },
  general: {
    feedback_type: 'general',
    title: 'Share feedback',
    description: 'Anything else: praise, gaps, rough edges.',
    submitLabel: 'Send feedback',
    fields: [
      { kind: 'single', id: 'topic', label: 'What is this about?', options: OPTION_GENERAL_TOPICS },
      {
        kind: 'textarea',
        id: 'message',
        label: 'Your feedback',
        required: true,
        placeholder: 'Tell us what is on your mind.',
        rows: 4,
      },
    ],
  },
}

export function feedbackDefinitionFor(id: string): FeedbackDefinition | null {
  return (FEEDBACK_TYPES as readonly string[]).includes(id)
    ? FEEDBACK_DEFINITIONS[id as FeedbackType]
    : null
}

export type FeedbackValues = Record<string, string | number | boolean | string[]>

export interface FeedbackFieldIssue {
  fieldId: string
  message: string
}

// Client-side validation mirroring the backend scalar contract: required text
// fields present, no value over the 4000-character store limit, no unexpected
// shapes. The server remains the authority; this only avoids obvious 400s.
export function validateFeedbackValues(
  definition: FeedbackDefinition,
  values: FeedbackValues,
): FeedbackFieldIssue[] {
  const issues: FeedbackFieldIssue[] = []
  for (const field of definition.fields) {
    const value = values[field.id]
    if (field.kind === 'single') {
      if (!field.options.some((option) => option.value === value)) {
        issues.push({ fieldId: field.id, message: `Choose one option for ${field.label.toLowerCase()}.` })
      }
      continue
    }
    const text = typeof value === 'string' ? value : ''
    if (field.required && text.trim().length < MIN_TEXT) {
      issues.push({ fieldId: field.id, message: `${field.label} is required.` })
    }
    if (text.length > MAX_TEXT) {
      issues.push({ fieldId: field.id, message: `${field.label} is too long.` })
    }
  }
  return issues
}

// Maps form values to the backend scalar response object: empty optional
// fields are omitted, strings are trimmed, and any non-scalar is rejected
// before it can leave the browser.
export function toFeedbackResponse(values: FeedbackValues): {
  ok: boolean
  response: Record<string, string | number | boolean>
  issues: FeedbackFieldIssue[]
} {
  const response: Record<string, string | number | boolean> = {}
  const issues: FeedbackFieldIssue[] = []
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length === 0) continue
      if (trimmed.length > MAX_TEXT) {
        issues.push({ fieldId: key, message: 'One of your answers is too long.' })
        continue
      }
      response[key] = trimmed
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      response[key] = value
      continue
    }
    issues.push({ fieldId: key, message: 'One of your answers has an unsupported format.' })
  }
  return { ok: issues.length === 0, response, issues }
}
