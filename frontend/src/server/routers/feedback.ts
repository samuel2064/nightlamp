import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, tokenProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'
import { FEEDBACK_TYPES, SURVEY_IDS } from '@/lib/feedback/contract'
import { receiptStatusFromRecord } from '@/lib/feedback/receipt'

// The payload shape is the protected backend response contract
// (origin/feat/noc-253-analytics-ingestion, src/analytics/event-contract.ts
// validateFeedbackResponse). Exactly the six allowed fields, one response_id
// per intended submission, and scalar answers only. The schema is strict: any
// unknown top-level key is rejected here instead of being proxied.

const responseIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,200}$/, 'response_id must be 1-200 characters of [A-Za-z0-9._:-]')

const scalarSchema = z.union([z.string().max(4000), z.number(), z.boolean()])

export const submissionSchema = z
  .object({
    response_id: responseIdSchema,
    kind: z.enum(['feedback', 'survey']),
    feedback_type: z.enum(FEEDBACK_TYPES).optional(),
    survey_id: z.enum(SURVEY_IDS).optional(),
    score: z.number().min(0).max(10).optional(),
    // Raw answers live here and only in the protected response store; they are
    // never copied into analytics.
    response: z.record(z.string(), scalarSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'feedback') {
      if (!value.feedback_type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['feedback_type'],
          message: 'feedback_type must be one of: bug_report, feature_request, general',
        })
      }
      if (value.survey_id !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['survey_id'],
          message: 'survey_id must not be sent with kind feedback',
        })
      }
      if (value.score !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['score'],
          message: 'score must not be sent with a feedback response',
        })
      }
      return
    }
    if (!value.survey_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['survey_id'],
        message: 'survey_id must be one of: welcome, microsurvey_monitor_created, microsurvey_alert_received, microsurvey_playbook_completed, microsurvey_team_invite, nps_day14, nps_day30, exit_account_delete, exit_inactivity',
      })
    }
    if (value.feedback_type !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feedback_type'],
        message: 'feedback_type must not be sent with kind survey',
      })
    }
  })

export const feedbackRouter = router({
  submit: tokenProcedure
    .input(submissionSchema)
    .mutation(async ({ ctx, input }) => {
      return createBackendClient(ctx.token).feedback.submit(input)
    }),

  receipt: tokenProcedure
    .input(z.object({ responseId: responseIdSchema }).strict())
    .query(async ({ ctx, input }) => {
      const record = await createBackendClient(ctx.token)
        .feedback.receipt(input.responseId)
        .catch((error: unknown) => {
          // The protected backend answers 404 when it has no such response.
          const message = error instanceof Error ? error.message : String(error)
          if (/^Backend API error 404/.test(message)) return null
          throw error
        })
      // Metadata-only DTO: raw answers, team and user identifiers stay on the
      // server. An unknown or unusable record answers NOT_FOUND.
      const status = record === null ? null : receiptStatusFromRecord(record)
      if (!status || status.response_id !== input.responseId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Response not found' })
      }
      return status
    }),
})