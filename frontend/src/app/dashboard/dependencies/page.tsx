'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { trpc } from '@/lib/trpc'

export default function DependenciesPage() {
  const { data: health, isLoading } = trpc.dependency.health.useQuery()

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading dependency data...</div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dependencies</h1>
        <p className="text-sm text-muted-foreground mt-1">Track dependency versions and updates</p>
      </div>
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold">{health?.total ?? 0}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Up to date</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-success">{health?.upToDate ?? 0}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Outdated</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-warning">{health?.outdated ?? 0}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Critical</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-2xl font-bold text-destructive">
              {(health?.bySeverity?.critical ?? 0) + (health?.bySeverity?.high ?? 0)}
            </span>
          </CardContent>
        </Card>
      </div>
      {health?.criticalItems && health.criticalItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Critical Items</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Package</th>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Current</th>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Latest</th>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Severity</th>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Summary</th>
                </tr>
              </thead>
              <tbody>
                {health.criticalItems.map((item) => (
                  <tr key={item.name} className="border-b border-border/50 last:border-0">
                    <td className="py-3 text-sm font-medium">{item.name}</td>
                    <td className="py-3 text-sm font-mono text-muted-foreground">{item.currentVersion}</td>
                    <td className="py-3 text-sm font-mono text-foreground">{item.latestVersion}</td>
                    <td className="py-3">
                      <Badge variant={item.severity === 'critical' || item.severity === 'high' ? 'destructive' : 'secondary'}>
                        {item.severity}
                      </Badge>
                    </td>
                    <td className="py-3 text-sm text-muted-foreground max-w-xs truncate">{item.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
