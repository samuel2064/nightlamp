'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, ChevronRight } from 'lucide-react'
import { Sidebar, navItems } from '@/components/dashboard/sidebar'
import { ConnectionIndicator } from '@/components/dashboard/connection-indicator'
import { Button } from '@/components/ui/button'

function currentLabel(pathname: string): string {
  const match = [...navItems]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(item.href + '/'))
  return match?.label ?? 'Dashboard'
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    setNavOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!navOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navOpen])

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar className="hidden md:flex" />

      {navOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 z-50 shadow-elevation-3">
            <Sidebar
              onClose={() => setNavOpen(false)}
              onNavigate={() => setNavOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface-primary/80 px-4 backdrop-blur md:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="size-9 md:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
          >
            <Menu className="size-5" />
          </Button>

          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-semibold md:hidden">
              {currentLabel(pathname)}
            </span>
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground md:inline-flex">
              <span>Dashboard</span>
              <ChevronRight className="size-3 text-muted-foreground/60" aria-hidden />
              <span className="text-foreground">{currentLabel(pathname)}</span>
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <ConnectionIndicator />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl p-4 md:p-6">{children}</div>
        </main>
      </div>
    </div>
  )
}
