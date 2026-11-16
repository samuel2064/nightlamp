'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { QuestionDefinition } from './types'

interface QuestionStepProps {
  question: QuestionDefinition
  onAnswer: (values: string[]) => void
  disabled?: boolean
  previousValues?: string[]
}

export function QuestionStep({
  question,
  onAnswer,
  disabled,
  previousValues = [],
}: QuestionStepProps) {
  const [selectedValues, setSelectedValues] = useState<string[]>(previousValues)
  const [customValue, setCustomValue] = useState('')
  const { text, options, allowMultiple, allowCustom } = question

  const handleSelect = (value: string) => {
    if (allowMultiple) {
      const newValues = selectedValues.includes(value)
        ? selectedValues.filter((v) => v !== value)
        : [...selectedValues, value]
      setSelectedValues(newValues)
      onAnswer(newValues)
    } else {
      setSelectedValues([value])
      onAnswer([value])
    }
  }

  const handleCustomChange = (value: string) => {
    setCustomValue(value)
    if (value) {
      const newValues = [...selectedValues, `custom:${value}`]
      setSelectedValues(newValues)
      onAnswer(newValues)
    }
  }

  const isValid = selectedValues.length > 0

  return (
    <div className="space-y-6">
      <div>
        <p className="text-lg text-foreground">{text}</p>
      </div>

      <div className="space-y-3">
        {options.map((option) => (
          <Card key={option.value} className="hover:border-glow-500/60 transition-colors">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                {allowMultiple ? (
                  <Checkbox
                    id={`option-${option.value}`}
                    checked={selectedValues.includes(option.value)}
                    onCheckedChange={() => handleSelect(option.value)}
                    disabled={disabled}
                    aria-label={option.label}
                  />
                ) : (
                  <RadioGroup
                    value={selectedValues[0] || ''}
                    onValueChange={handleSelect}
                    disabled={disabled}
                  >
                    <RadioGroupItem
                      value={option.value}
                      id={`option-${option.value}`}
                      className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </RadioGroup>
                )}
                <div className="flex-1 min-w-0 pt-1">
                  <Label
                    htmlFor={`option-${option.value}`}
                    className="font-medium cursor-pointer"
                  >
                    {option.label}
                  </Label>
                  {option.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{option.description}</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {allowCustom && (
          <Card className="border-dashed border-glow-500/50 hover:border-glow-500 transition-colors">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                {allowMultiple ? (
                  <Checkbox
                    id="option-custom"
                    checked={selectedValues.some((v) => v.startsWith('custom:'))}
                    onCheckedChange={() => handleCustomChange(customValue)}
                    disabled={disabled}
                    aria-label="Custom option"
                  />
                ) : (
                  <RadioGroup
                    value={selectedValues[0] || ''}
                    onValueChange={handleSelect}
                    disabled={disabled}
                  >
                    <RadioGroupItem
                      value={selectedValues.find((v) => v.startsWith('custom:')) || ''}
                      id="option-custom"
                      className="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                  </RadioGroup>
                )}
                <div className="flex-1 min-w-0">
                  <Label htmlFor="option-custom" className="font-medium cursor-pointer">
                    Other...
                  </Label>
                  <Input
                    id="custom-input"
                    placeholder="Enter custom answer"
                    value={customValue}
                    onChange={(e) => handleCustomChange(e.target.value)}
                    disabled={disabled || !selectedValues.some((v) => v.startsWith('custom:'))}
                    className="mt-2 max-w-xs"
                    aria-label="Custom answer"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-border">
        <Button variant="outline" onClick={() => onAnswer(['__PREVIOUS__'])} disabled={disabled}>
          Previous
        </Button>
        <Button
          onClick={() => {}}
          disabled={disabled || !isValid}
          className="ml-auto"
        >
          Continue
          <ChevronRight className="size-4 ml-2" aria-hidden />
        </Button>
      </div>
    </div>
  )
}