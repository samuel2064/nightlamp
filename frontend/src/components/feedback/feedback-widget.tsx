'use client'

import * as React from 'react'
import { Bug, Lightbulb, MessageSquare, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { FeedbackSheet } from './feedback-sheet'
import { FEEDBACK_TYPES, type FeedbackType } from '@/lib/feedback/contract'

// User-initiated feedback entry point. It is always available, including while
// automatic prompts are suppressed: reporting a problem must never queue
// behind the scheduler.
//
// - desktop: header dropdown
// - mobile: floating action button above the safe area, opening a bottom sheet
// - every entry point is a 44x44 minimum hit area

const FEEDBACK_ENTRIES: { type: FeedbackType; label: string; description: string; icon: typeof Bug }[] = [
  { type: 'bug_report', label: 'Report a bug', description: 'Something is broken', icon: Bug },
  { type: 'feature_request', label: 'Request a feature', description: 'Something is missing', icon: Lightbulb },
  { type: 'general', label: 'Share feedback', description: 'Anything else', icon: MessageSquare },
]

export function FeedbackMenuItems({ onSelect }: { onSelect: (type: FeedbackType) => void }) {
  return (
    <>
      {FEEDBACK_ENTRIES.map((entry) => (
        <DropdownMenuItem
          key={entry.type}
          onSelect={() => onSelect(entry.type)}
          className="min-h-11 gap-3"
        >
          <entry.icon className="size-4 shrink-0" aria-hidden />
          <span className="flex flex-col">
            <span className="text-base">{entry.label}</span>
            <span className="text-xs text-muted-foreground">{entry.description}</span>
          </span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

function FeedbackEntries({ onSelect }: { onSelect: (type: FeedbackType) => void }) {
  return (
    <ul className="grid gap-2">
      {FEEDBACK_ENTRIES.map((entry) => (
        <li key={entry.type}>
          <Button
            variant="outline"
            className="min-h-11 w-full justify-start gap-3 px-3 text-base"
            onClick={() => onSelect(entry.type)}
          >
            <entry.icon className="size-4 shrink-0" aria-hidden />
            <span>{entry.label}</span>
          </Button>
        </li>
      ))}
    </ul>
  )
}

export function FeedbackWidget() {
  const [activeType, setActiveType] = React.useState<FeedbackType | null>(null)
  const [menuOpen, setMenuOpen] = React.useState(false)

  const open = (type: FeedbackType) => {
    setMenuOpen(false)
    setActiveType(type)
  }

  return (
    <>
      {/* Desktop: header dropdown */}
      <div className="hidden md:block">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="min-h-11 gap-2">
              <MessageSquarePlus className="size-4" aria-hidden />
              Feedback
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Share feedback</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <FeedbackMenuItems onSelect={open} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Mobile: floating action button, bottom sheet menu */}
      <div className="md:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent
            side="bottom"
            className="max-h-[80dvh] overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeader>
              <SheetTitle>Share feedback</SheetTitle>
            </SheetHeader>
            <div className="mt-4">
              <FeedbackEntries
                onSelect={(type) => {
                  setMenuOpen(false)
                  setActiveType(type)
                }}
              />
            </div>
          </SheetContent>
          <Button
            className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] right-4 z-40 size-14 rounded-full shadow-elevation-3"
            onClick={() => setMenuOpen(true)}
            aria-label="Share feedback"
          >
            <MessageSquarePlus className="size-6" aria-hidden />
          </Button>
        </Sheet>
      </div>

      {FEEDBACK_TYPES.map((type) => (
        <FeedbackSheet
          key={type}
          type={type}
          open={activeType === type}
          onClose={() => setActiveType(null)}
        />
      ))}
    </>
  )
}
