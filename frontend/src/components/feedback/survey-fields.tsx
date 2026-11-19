'use client'

import * as React from 'react'
import { Check, Circle, Star } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { radioGroupKeyAction, radioGroupTargetIndex } from '@/lib/feedback/radio-group-keys'
import type { SurveyAnswers, SurveyDefinition } from '@/lib/feedback/survey-definitions'

// Shared survey question renderers (NOC-161 addendum contract):
// - 320/375px without clipping or page-level horizontal overflow
// - NPS choices wrap in ascending order in a labeled radio group with explicit
//   0/10 anchors; up to five columns below 480px (never one eleven-wide row)
// - 44x44 minimum hit areas; selected state includes a non-colour indicator
// - keyboard radio-group behaviour: one tab stop, arrows move and select,
//   Home/End jump to the ends, selection moves focus with it

// WAI-ARIA radiogroup keyboard behaviour for the custom star and NPS scales:
// one tab stop on the checked (or first) item, arrow keys move and select,
// Home/End jump to the ends. Selection is reported to the caller as a number.
export function KeyboardRadioGroup({
  label,
  values,
  current,
  disabled,
  onSelect,
  className,
  renderItem,
}: {
  label: string
  values: number[]
  current: number | undefined
  disabled?: boolean
  onSelect: (value: number) => void
  className?: string
  renderItem: (
    value: number,
    selected: boolean,
    tabIndex: number,
    ref: (el: HTMLButtonElement | null) => void
  ) => React.ReactNode
}) {
  const refs = React.useRef<Map<number, HTMLButtonElement>>(new Map())

  const focusIndex = React.useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(values.length - 1, index))
      const target = refs.current.get(values[clamped])
      target?.focus()
      onSelect(values[clamped])
    },
    [onSelect, values]
  )

  const onKeyDown = (event: React.KeyboardEvent, value: number) => {
    if (disabled) return
    const index = values.indexOf(value)
    const action = radioGroupKeyAction(event.key)
    if (!action) return
    event.preventDefault()
    const target = radioGroupTargetIndex(action, index, values.length)
    if (target !== null) focusIndex(target)
  }

  return (
    <div role="radiogroup" aria-label={label} className={className}>
      {values.map((value) => {
        const selected = current === value
        const tabIndex = current === undefined ? (value === values[0] ? 0 : -1) : selected ? 0 : -1
        return (
          <span
            key={value}
            role="none"
            className="contents"
            onKeyDown={(event) => onKeyDown(event, value)}
          >
            {renderItem(value, selected, tabIndex, (el) => {
              if (el) refs.current.set(value, el)
              else refs.current.delete(value)
            })}
          </span>
        )
      })}
    </div>
  )
}

// Native radio semantics with an explicit group name give the WAI-ARIA radio
// keyboard behaviour (arrow keys move and select, one tab stop) for free, and
// the visual control is hidden because the row itself is the click target.
export function ChoiceRow({
  id,
  label,
  name,
  checked,
  onSelect,
  multi,
  onOtherChange,
  otherValue,
  otherId,
  disabled,
}: {
  id: string
  label: string
  name: string
  checked: boolean
  onSelect: () => void
  multi?: boolean
  onOtherChange?: (value: string) => void
  otherValue?: string
  otherId?: string
  disabled?: boolean
}) {
  return (
    <Label
      htmlFor={id}
      className={cn(
        'flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-md border border-input px-3 py-2 text-base has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2',
        checked && 'border-primary ring-1 ring-primary',
        disabled && 'cursor-not-allowed opacity-70'
      )}
    >
      {multi ? (
        <span
          aria-hidden
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-[4px] border',
            checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
          )}
        >
          {checked ? <Check className="size-3.5" /> : null}
        </span>
      ) : (
        <Circle
          aria-hidden
          className={cn('size-5 shrink-0', checked ? 'fill-primary text-primary' : 'text-input')}
        />
      )}
      {multi ? (
        <input
          id={id}
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={onSelect}
          disabled={disabled}
        />
      ) : (
        <input
          id={id}
          type="radio"
          name={name}
          className="sr-only"
          checked={checked}
          onChange={onSelect}
          disabled={disabled}
        />
      )}
      <span className="flex-1 text-base leading-snug">{label}</span>
      {onOtherChange && otherId ? (
        <input
          type="text"
          value={otherValue ?? ''}
          onChange={(event) => onOtherChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          placeholder="Other"
          aria-label={`${label}: other`}
          disabled={disabled}
          className="w-28 shrink-0 rounded-md border border-input bg-background px-2 py-1 text-base"
        />
      ) : null}
    </Label>
  )
}

export function StarsField({
  question,
  value,
  onChange,
  disabled,
}: {
  question: Extract<SurveyDefinition['questions'][number], { kind: 'stars' }>
  value: SurveyAnswers[string]
  onChange: (value: number) => void
  disabled?: boolean
}) {
  const current = typeof value === 'number' ? value : 0
  return (
    <div>
      <KeyboardRadioGroup
        label={question.label}
        values={Array.from({ length: question.max }, (_, index) => index + 1)}
        current={current}
        disabled={disabled}
        onSelect={onChange}
        className="flex flex-wrap items-center gap-2"
        renderItem={(score, selected, tabIndex, ref) => (
          <button
            key={score}
            ref={ref}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${score} of ${question.max}`}
            tabIndex={tabIndex}
            disabled={disabled}
            className={cn(
              'flex size-11 items-center justify-center rounded-md border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              selected && 'border-primary ring-1 ring-primary'
            )}
          >
            <Star
              aria-hidden
              className={cn(
                'size-8',
                selected ? 'fill-warning text-warning' : 'text-muted-foreground/40'
              )}
            />
            <span className="sr-only">{score}</span>
          </button>
        )}
      />
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{question.anchors[0]}</span>
        <span>{question.anchors[1]}</span>
      </div>
    </div>
  )
}

export function NpsField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: SurveyAnswers[string]
  onChange: (value: number) => void
  disabled?: boolean
}) {
  const current = typeof value === 'number' ? value : undefined
  return (
    <div>
      {/* Ascending order. Container-safe wrapping: the number of columns
          follows the panel's own width, never the viewport's, so the eleven
          choices never overflow a narrow inline sheet or form one wide row.
          Every item keeps its 44x44 hit area. */}
      <KeyboardRadioGroup
        label={label}
        values={Array.from({ length: 11 }, (_, index) => index)}
        current={current}
        disabled={disabled}
        onSelect={onChange}
        className="grid grid-cols-[repeat(auto-fit,minmax(44px,1fr))] gap-1"
        renderItem={(score, selected, tabIndex, ref) => (
          <button
            key={score}
            ref={ref}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={score === 0 ? '0 - Not at all likely' : score === 10 ? '10 - Extremely likely' : `${score}`}
            tabIndex={tabIndex}
            disabled={disabled}
            className={cn(
              'relative flex size-11 items-center justify-center rounded-md border text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none',
              selected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input hover:bg-accent'
            )}
          >
            {score}
            {selected ? <Check aria-hidden className="absolute -bottom-0.5 -right-0.5 size-4 text-primary" /> : null}
          </button>
        )}
      />
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>0 - Not at all likely</span>
        <span>10 - Extremely likely</span>
      </div>
    </div>
  )
}

export function TextQuestion({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string
  label: string
  value: SurveyAnswers[string]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id} className="text-base font-medium">
        {label}
      </Label>
      <Textarea
        id={id}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={2}
        className="min-h-16 text-base"
      />
    </div>
  )
}

export function QuestionBlock({
  question,
  idPrefix,
  answers,
  onAnswerChange,
  disabled,
  footer,
}: {
  question: SurveyDefinition['questions'][number]
  idPrefix: string
  answers: SurveyAnswers
  onAnswerChange: (questionId: string, value: string | number | boolean | string[]) => void
  disabled?: boolean
  footer?: React.ReactNode
}) {
  const value = answers[question.id]

  if (question.kind === 'stars') {
    return (
      <div className="grid gap-2">
        <Label className="text-base font-medium">{question.label}</Label>
        <StarsField
          question={question}
          value={value}
          onChange={(next) => onAnswerChange(question.id, next)}
          disabled={disabled}
        />
        {footer}
      </div>
    )
  }

  if (question.kind === 'nps') {
    return (
      <div className="grid gap-2">
        <Label className="text-base font-medium">{question.label}</Label>
        <NpsField
          label={question.label}
          value={value}
          onChange={(next) => onAnswerChange(question.id, next)}
          disabled={disabled}
        />
        {footer}
      </div>
    )
  }

  if (question.kind === 'text') {
    return (
      <TextQuestion
        id={`${idPrefix}-${question.id}`}
        label={question.label}
        value={value}
        onChange={(next) => onAnswerChange(question.id, next)}
        placeholder={question.placeholder}
        disabled={disabled}
      />
    )
  }

  if (question.kind === 'single') {
    return (
      <div className="grid gap-2">
        <span className="text-base font-medium">{question.label}</span>
        {question.options.map((option) => (
          <ChoiceRow
            key={option.value}
            id={`${idPrefix}-${question.id}-${option.value}`}
            name={`${idPrefix}-${question.id}`}
            label={option.label}
            checked={value === option.value}
            onSelect={() => onAnswerChange(question.id, option.value)}
            disabled={disabled}
          />
        ))}
        {footer}
      </div>
    )
  }

  const selected = Array.isArray(value) ? value : []
  return (
    <div className="grid gap-2">
      <span className="text-base font-medium">{question.label}</span>
      {question.options.map((option) => (
        <ChoiceRow
          key={option.value}
          id={`${idPrefix}-${question.id}-${option.value}`}
          name={`${idPrefix}-${question.id}`}
          label={option.label}
          multi
          checked={selected.includes(option.value)}
          onSelect={() =>
            onAnswerChange(
              question.id,
              selected.includes(option.value)
                ? selected.filter((entry) => entry !== option.value)
                : [...selected, option.value]
            )
          }
          disabled={disabled}
        />
      ))}
      {question.otherId ? (
        <ChoiceRow
          id={`${idPrefix}-${question.otherId}`}
          name={`${idPrefix}-${question.id}`}
          label="Other"
          multi
          checked={selected.includes('other')}
          onSelect={() =>
            onAnswerChange(
              question.id,
              selected.includes('other')
                ? selected.filter((entry) => entry !== 'other')
                : [...selected, 'other']
            )
          }
          otherId={`${idPrefix}-${question.otherId}-text`}
          otherValue={typeof answers[`${question.otherId}_text`] === 'string' ? (answers[`${question.otherId}_text`] as string) : ''}
          onOtherChange={(text) => onAnswerChange(`${question.otherId}_text`, text)}
          disabled={disabled}
        />
      ) : null}
      {footer}
    </div>
  )
}

// Footer action pair used by the modal survey surfaces: Skip (dismissal, never
// a completion) and Submit. 44x44 minimum hit areas at every width.
export function SurveyFooterActions({
  submitLabel,
  isSubmitting,
  onSubmit,
  onSkip,
  submitDisabled,
}: {
  submitLabel: string
  isSubmitting: boolean
  onSubmit: () => void
  onSkip: () => void
  submitDisabled?: boolean
}) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="ghost" onClick={onSkip} disabled={isSubmitting} className="min-h-11 sm:min-w-24">
        Skip
      </Button>
      <Button onClick={onSubmit} disabled={isSubmitting || submitDisabled} className="min-h-11 sm:min-w-32">
        {isSubmitting ? 'Sending…' : submitLabel}
      </Button>
    </div>
  )
}
