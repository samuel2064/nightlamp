'use client'

import * as React from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { QuestionBlock, SurveyFooterActions } from './survey-fields'
import { useDurableSubmission } from './use-durable-submission'
import type { SurveyAnswers, SurveyDefinition } from '@/lib/feedback/survey-definitions'
import { npsScoreFor, surveyValidationIssues } from '@/lib/feedback/survey-definitions'

// Interior of every survey surface (NOC-161 2026-11-16 addendum):
// - editing -> submitting -> server-confirmed success; the success state only
//   exists after the durable receipt arrives (a timeout is not success)
// - Skip is a dismissal, never a completion, and never blocks monitoring
// - timeout/offline keeps the in-memory draft and offers Retry and Discard
// - authentication expiry preserves the draft and offers sign-in
// - the canonical survey_completed event is emitted by the server from the
//   durable receipt; this component never emits a second event

export interface SurveyInteriorProps {
  definition: SurveyDefinition
  answers: SurveyAnswers
  onAnswersChange: (next: SurveyAnswers) => void
  /** Skip / discard / done: a dismissal, never a completion. */
  onDismiss: () => void
  onSent?: () => void
  idPrefix: string
}

export function SurveyInterior({
  definition,
  answers,
  onAnswersChange,
  onDismiss,
  onSent,
  idPrefix,
}: SurveyInteriorProps) {
  const durable = useDurableSubmission<SurveyAnswers>({
    kind: 'survey',
    surface: definition.id,
    values: answers,
    validate: (current) =>
      surveyValidationIssues(definition, current).map((issue) => ({
        fieldId: issue.questionId,
        message: issue.message,
      })),
    toSubmission: (current, response) => ({
      kind: 'survey' as const,
      survey_id: definition.id,
      // Only the 0-10 NPS scale maps to the allowlisted `score` property.
      score: npsScoreFor(definition, current),
      response,
    }),
  })
  const { view, issues, state } = durable

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
              Your answers were saved and our team can see them.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={onDismiss} className="min-h-11 sm:min-w-32">
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
              <a href="/sign-in" className="text-base font-medium underline">
                Sign in
              </a>
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

      <div className="grid gap-6">
        {definition.questions.map((question) => (
          <QuestionBlock
            key={question.id}
            question={question}
            idPrefix={idPrefix}
            answers={answers}
            onAnswerChange={(questionId, value) => onAnswersChange({ ...answers, [questionId]: value })}
            disabled={view.isSending}
          />
        ))}
      </div>

      <SurveyFooterActions
        submitLabel={definition.submitLabel ?? 'Submit'}
        isSubmitting={view.isSending}
        onSubmit={durable.submit}
        onSkip={onDismiss}
      />
      {/* Answers are held in memory only; never written to a URL, storage or log. */}
      <p className="sr-only" aria-live="polite">
        {state.phase === 'sending' ? 'Sending your answers' : ''}
      </p>
    </div>
  )
}
