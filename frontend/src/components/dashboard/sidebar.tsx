'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  HeartPulse,
  AlertTriangle,
  Activity,
  Package,
  BookOpen,
  CreditCard,
  CheckCircle2,
  X,
} from 'lucide-react'
import { UserButton, OrganizationSwitcher, useUser } from '@clerk/nextjs'
import { Button } from '@/components/ui/button'

export const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/health', label: 'Health', icon: HeartPulse },
  { href: '/dashboard/incidents', label: 'Incidents', icon: AlertTriangle },
  { href: '/dashboard/activity', label: 'Activity', icon: Activity },
  { href: '/dashboard/dependencies', label: 'Dependencies', icon: Package },
  { href: '/dashboard/playbooks', label: 'Playbooks', icon: BookOpen },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
  { href: '/dashboard/approvals', label: 'Approvals', icon: CheckCircle2 },
]

interface SidebarProps {
  className?: string
  onNavigate?: () => void
  onClose?: () => void
}

export function Sidebar({ className, onNavigate, onClose }: SidebarProps) {
  const pathname = usePathname()
  const { user } = useUser()

  return (
    <aside
      className={cn(
        'flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface-secondary/40',
        className,
      )}
    >
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <Link href="/dashboard" className="flex items-center gap-2" onClick={onNavigate}>
          <div className="flex size-7 items-center justify-center rounded-full bg-glow-500">
            <span className="text-xs font-bold text-nightlamp-950">N</span>
          </div>
          <span className="font-semibold tracking-tight">Nightlamp</span>
        </Link>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 md:hidden"
            onClick={onClose}
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label="Dashboard">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                'focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
                isActive
                  ? 'bg-glow-500/10 text-glow-400'
                  : 'text-muted-foreground hover:bg-surface-tertiary/60 hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="space-y-3 border-t border-border p-3">
        <OrganizationSwitcher
          appearance={{
            elements: {
              rootBox: 'w-full',
              organizationSwitcherTrigger:
                'w-full justify-between text-sm py-2 px-3 rounded-md border border-border bg-surface-primary hover:bg-surface-tertiary/60',
            },
          }}
        />
        <div className="flex items-center gap-3 px-1">
          <UserButton afterSignOutUrl="/sign-in" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {user?.fullName ?? user?.emailAddresses?.[0]?.emailAddress ?? 'User'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {user?.primaryEmailAddress?.emailAddress ?? ''}
            </p>
          </div>
        </div>
      </div>
    </aside>
  )
}
