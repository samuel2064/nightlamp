'use client'

import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { InfoDefinition } from './types'

interface InfoStepProps {
  info: InfoDefinition
  onContinue: () => void
  onPrevious: () => void
  disabled?: boolean
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n')
  const rendered: React.ReactNode[] = []

  let inCodeBlock = false
  let codeBlockContent = ''
  let codeLanguage = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLanguage = line.slice(3).trim() || 'text'
        codeBlockContent = ''
      } else {
        inCodeBlock = false
        rendered.push(
          <pre key={`code-${i}`} className="bg-surface-primary rounded-lg p-4 overflow-x-auto my-4">
            <code className={`language-${codeLanguage} text-sm font-mono`}>
              {codeBlockContent}
            </code>
          </pre>
        )
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockContent += line + '\n'
      continue
    }

    if (line.startsWith('# ')) {
      rendered.push(<h1 key={i} className="text-2xl font-bold mb-4 mt-6">{line.slice(2)}</h1>)
    } else if (line.startsWith('## ')) {
      rendered.push(<h2 key={i} className="text-xl font-bold mb-3 mt-5">{line.slice(3)}</h2>)
    } else if (line.startsWith('### ')) {
      rendered.push(<h3 key={i} className="text-lg font-bold mb-2 mt-4">{line.slice(4)}</h3>)
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      rendered.push(<li key={i} className="ml-4 mb-1">{line.slice(2)}</li>)
    } else if (line.match(/^\d+\./)) {
      rendered.push(<li key={i} className="ml-4 mb-1">{line}</li>)
    } else if (line.startsWith('> ')) {
      rendered.push(<blockquote key={i} className="border-l-4 border-glow-500 pl-4 italic text-muted-foreground my-2">{line.slice(2)}</blockquote>)
    } else if (line.includes('`') && !line.startsWith('```')) {
      const parts = line.split('`')
      const spans = parts.map((part, idx) =>
        idx % 2 === 1 ? <code key={idx} className="bg-surface-primary px-1.5 py-0.5 rounded text-sm font-mono">{part}</code> : <span key={idx}>{part}</span>
      )
      rendered.push(<p key={i} className="mb-2">{spans}</p>)
    } else if (line.trim() === '') {
      rendered.push(<div key={i} className="h-4" />)
    } else {
      rendered.push(<p key={i} className="mb-2">{line}</p>)
    }
  }

  return <div className="prose prose-invert max-w-none">{rendered}</div>
}

export function InfoStep({
  info,
  onContinue,
  onPrevious,
  disabled,
}: InfoStepProps) {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-4">
          <MarkdownRenderer content={info.content} />
        </CardContent>
      </Card>

      <div className="flex justify-between pt-4 border-t border-border">
        <Button variant="outline" onClick={onPrevious} disabled={disabled}>
          Previous
        </Button>
        <Button onClick={onContinue} disabled={disabled} className="ml-auto gap-2">
          Continue
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}