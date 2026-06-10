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
} from 'lucide-react'
import { UserButton, OrganizationSwitcher, useUser } from '@clerk/nextjs'

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/health', label: 'Health', icon: HeartPulse },
  { href: '/dashboard/incidents', label: 'Incidents', icon: AlertTriangle },
  { href: '/dashboard/activity', label: 'Activity', icon: Activity },
  { href: '/dashboard/dependencies', label: 'Dependencies', icon: Package },
  { href: '/dashboard/playbooks', label: 'Playbooks', icon: BookOpen },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
  { href: '/dashboard/approvals', label: 'Approvals', icon: CheckCircle2 },
]

export function Sidebar() {
  const pathname = usePathname()
  const { user } = useUser()

  return (
    <aside className="w-56 border-r bg-muted/30 flex flex-col shrink-0">
      <div className="p-4 border-b">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="size-7 rounded-full bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-xs">N</span>
          </div>
          <span className="font-semibold">Nightlamp</span>
        </Link>
      </div>
      <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="p-3 border-t space-y-3">
        <OrganizationSwitcher
          appearance={{
            elements: {
              rootBox: 'w-full',
              organizationSwitcherTrigger: 'w-full justify-between text-sm py-2 px-3 rounded-md border bg-background hover:bg-muted',
            },
          }}
        />
        <div className="flex items-center gap-3 px-1">
          <UserButton afterSignOutUrl="/sign-in" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {user?.fullName ?? user?.emailAddresses?.[0]?.emailAddress ?? 'User'}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {user?.primaryEmailAddress?.emailAddress ?? ''}
            </p>
          </div>
        </div>
      </div>
    </aside>
  )
}
