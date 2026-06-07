'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Activity, Bug, FileText, LayoutDashboard, RefreshCw, CreditCard, Clock } from 'lucide-react'

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/incidents', label: 'Incidents', icon: Bug },
  { href: '/dashboard/health', label: 'Health', icon: Activity },
  { href: '/dashboard/activity', label: 'Activity', icon: Clock },
  { href: '/dashboard/dependencies', label: 'Dependencies', icon: RefreshCw },
  { href: '/dashboard/playbooks', label: 'Playbooks', icon: FileText },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="w-64 border-r border-sidebar-border bg-sidebar flex flex-col h-screen shrink-0">
      <div className="p-4 border-b border-sidebar-border">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-[#6C5CE7] flex items-center justify-center">
            <span className="text-white font-bold text-sm">N</span>
          </div>
          <span className="font-semibold text-sidebar-foreground">Nightlamp</span>
        </Link>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                  : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
