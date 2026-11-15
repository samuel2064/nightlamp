'use client'

import { PlaybookReader } from '@/components/playbook/PlaybookReader'
import { useParams } from 'next/navigation'

export default function PlaybookDetailPage() {
  const params = useParams()
  const id = params.id as string

  return <PlaybookReader playbookId={id} onExit={() => window.history.back()} />
}