'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { trpc } from '@/lib/trpc'
import { Loader2 } from 'lucide-react'

export function TeamGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [loading, setLoading] = useState(true)
  const [hasTeam, setHasTeam] = useState(false)

  // Check if user has a team by querying the teams list
  const teamsQuery = trpc.monitors.list.useQuery(undefined, {
    enabled: false,
  })

  useEffect(() => {
    const checkTeam = async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/teams`, {
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
        })
        if (res.ok) {
          const data = await res.json()
          if (data.teams && data.teams.length > 0) {
            setHasTeam(true)
          }
        }
      } catch {
        // Ignore errors
      } finally {
        setLoading(false)
      }
    }

    checkTeam()
  }, [])

  // Don't redirect from onboarding page itself
  useEffect(() => {
    if (!loading && !hasTeam && !pathname.startsWith('/onboarding')) {
      router.push('/onboarding')
    }
  }, [loading, hasTeam, pathname, router])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    )
  }

  if (!hasTeam) {
    return null
  }

  return <>{children}</>
}