'use client'

import { HealthStatusCards } from '@/components/dashboard/overview/health-status-cards'
import { RecentAlerts } from '@/components/dashboard/overview/recent-alerts'
import { UptimeSparklines } from '@/components/dashboard/overview/uptime-sparklines'
import { trpc } from '@/lib/trpc'

export default function OverviewPage() {
  const { data: failureTypes } = trpc.playbook.failureTypes.useQuery(undefined, { retry: false })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">System health at a glance</p>
      </div>
      <HealthStatusCards />
      <div className="grid grid-cols-2 gap-4">
        <RecentAlerts />
        <UptimeSparklines />
      </div>
      {failureTypes && (
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs text-muted-foreground">
            Registered failure types: {failureTypes.failureTypes.join(', ')}
          </span>
        </div>
      )}
    </div>
  )
}
