'use client'

import * as React from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { FeedbackDefinition } from '@/lib/feedback/feedback-definitions'
import { validateFeedbackValues, toFeedbackResponse, type FeedbackValues } from '@/lib/feedback/feedback-definitions'
import { useDurableSubmission } from './use-durable-submission'
import { ChoiceRow } from './survey-fields'

// Feedback surface for bug_report, feature_request and general feedback.
// Contract (NOC-161 addendum + a48ae78):
// - editing -> submitting -> server-confirmed success; success only after the
//   durable receipt arrives
// - while submitting: repeat submission disabled, the action reads Sending…,
//   entered values are retained
// - offline/timeout: "Not sent yet. Your feedback is still here." with Retry
//   and Discard; the draft survives in memory only (never URLs or storage)
// - authentication expiry preserves the draft and offers sign-in
// - 16px inputs, 44x44 hit areas, content-height sheet capped by the viewport
//   with the body scrolling and the actions visible with the keyboard open

export interface FeedbackDialogBodyProps {
  definition: FeedbackDefinition
  values: FeedbackValues
  onValuesChange: (values: FeedbackValues) => void
  idPrefix: string
}

export function FeedbackFormFields({
  definition,
  values,
  onValuesChange,
  idPrefix,
}: FeedbackDialogBodyProps) {
  const setValue = (fieldId: string, value: string) => {
    onValuesChange({ ...values, [fieldId]: value })
  }
  return (
    <div className="grid gap-6">
      {definition.fields.map((field) => {
        const value = values[field.id]
        if (field.kind === 'single') {
          return (
            <fieldset key={field.id} className="grid gap-2 border-0 p-0">
              <legend className="text-base font-medium">{field.label}</legend>
              {field.options.map((option) => (
                <ChoiceRow
                  key={option.value}
                  id={`${idPrefix}-${field.id}-${option.value}`}
                  name={`${idPrefix}-${field.id}`}
                  label={option.label}
                  checked={value === option.value}
                  onSelect={() => setValue(field.id, option.value)}
                />
              ))}
            </fieldset>
          )
        }
        if (field.kind === 'text') {
          return (
            <div key={field.id} className="grid gap-2">
              <Label htmlFor={`${idPrefix}-${field.id}`} className="text-base font-medium">
                {field.label}
                {field.required ? <span className="ml-1 text-destructive">*</span> : null}
              </Label>
              <Input
                id={`${idPrefix}-${field.id}`}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => setValue(field.id, event.target.value)}
                placeholder={field.placeholder}
                required={field.required}
                className="min-h-11 text-base"
              />
            </div>
          )
        }
        return (
          <div key={field.id} className="grid gap-2">
            <Label htmlFor={`${idPrefix}-${field.id}`} className="text-base font-medium">
              {field.label}
              {field.required ? <span className="ml-1 text-destructive">*</span> : null}
            </Label>
            <Textarea
              id={`${idPrefix}-${field.id}`}
              value={typeof value === 'string' ? value : ''}
              onChange={(event) => setValue(field.id, event.target.value)}
              placeholder={field.placeholder}
              required={field.required}
              rows={field.rows ?? 3}
              className="min-h-16 text-base"
            />
          </div>
        )
      })}
    </div>
  )
}

export interface FeedbackSurfaceProps {
  definition: FeedbackDefinition
  values: FeedbackValues
  onValuesChange: (values: FeedbackValues) => void
  idPrefix: string
  onCancel: () => void
  onSent?: () => void
}

// The durable feedback form: validation summary, retry/discard failure state,
// auth-expiry sign-in offer, and success only after the durable receipt.
export function FeedbackSurface({
  definition,
  values,
  onValuesChange,
  idPrefix,
  onCancel,
  onSent,
}: FeedbackSurfaceProps) {
  const durable = useDurableSubmission<FeedbackValues>({
    kind: 'feedback',
    surface: definition.feedback_type,
    values,
    validate: (current) => validateFeedbackValues(definition, current),
    toSubmission: (current, response) => {
      const mapped = toFeedbackResponse(current)
      if (!mapped.ok) return null
      return {
        kind: 'feedback' as const,
        feedback_type: definition.feedback_type,
        response: Object.keys(mapped.response).length > 0 ? mapped.response : response,
      }
    },
  })
  const { view, issues } = durable

  React.useEffect(() => {
    if (view.isSent) onSent?.()
  }, [view.isSent, onSent])

  const allIssues = [
    ...issues.map((issue) => ({ fieldId: issue.fieldId, message: issue.message })),
    ...view.fieldErrors.map((message, index) => ({ fieldId: `server-${index}`, message })),
  ]

  if (view.isSent) {
    return (
      <div className="grid gap-4 py-2" aria-live="polite">
        <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/10 px-4 py-3">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div>
            <p className="text-base font-medium">Received. Thank you.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your {definition.feedback_type === 'bug_report' ? 'report' : 'feedback'} was saved and our team can see it.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={onCancel} className="min-h-11 sm:min-w-32">
            Done
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-6">
      {view.isFailed ? (
        <div
          className={cn(
            'flex items-start gap-3 rounded-md border px-4 py-3',
            view.offerSignIn ? 'border-border bg-muted/50' : 'border-destructive/40 bg-destructive/10'
          )}
          role="alert"
        >
          <AlertTriangle
            className={cn('mt-0.5 size-5 shrink-0', view.offerSignIn ? 'text-muted-foreground' : 'text-destructive')}
            aria-hidden
          />
          <div className="grid gap-2">
            <p className="text-base font-medium">{view.headline}</p>
            {view.detail ? <p className="text-sm text-muted-foreground">{view.detail}</p> : null}
            {view.offerSignIn ? (
              <Link href="/sign-in" className="text-base font-medium underline">
                Sign in
              </Link>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={durable.retry} className="min-h-11 sm:min-w-24">
                  Retry
                </Button>
                <Button variant="ghost" onClick={durable.discard} className="min-h-11 sm:min-w-24">
                  Discard
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {allIssues.length > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3" role="alert">
          <p className="text-sm font-medium text-destructive">Please fix the following:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-destructive">
            {allIssues.map((issue) => (
              <li key={`${issue.fieldId}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <FeedbackFormFields
        definition={definition}
        values={values}
        onValuesChange={onValuesChange}
        idPrefix={idPrefix}
      />

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onCancel} className="min-h-11 sm:min-w-24">
          Cancel
        </Button>
        <Button
          onClick={durable.submit}
          disabled={!view.canSubmit}
          aria-disabled={!view.canSubmit}
          className="min-h-11 sm:min-w-32"
        >
          {view.submitLabel}
        </Button>
      </div>
    </div>
  )
}
