'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { trpc } from '@/lib/trpc'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Plus } from 'lucide-react'

const statusCycle = ['open', 'investigating', 'resolved'] as const

export default function PlaybooksPage() {
  const utils = trpc.useUtils()
  const { data: entries, isLoading } = trpc.playbook.list.useQuery()
  const createEntry = trpc.playbook.create.useMutation({
    onSuccess: () => utils.playbook.list.invalidate(),
  })
  const updateStatus = trpc.playbook.updateStatus.useMutation({
    onSuccess: () => utils.playbook.list.invalidate(),
  })
  const autoGenerate = trpc.playbook.autoGenerate.useMutation({
    onSuccess: () => utils.playbook.list.invalidate(),
  })

  const quickTypes = [
    { label: 'Broken Webhook', type: 'broken_webhook', resource: 'API Gateway' },
    { label: 'Expired Token', type: 'expired_token', resource: 'Billing Service' },
    { label: 'Rate Limit', type: 'rate_limit_shift', resource: 'Deployment API' },
    { label: 'Schema Drift', type: 'schema_drift', resource: 'Database' },
  ]

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    title: '',
    failureType: '',
    source: '',
    severity: 'medium',
    affectedResource: '',
    description: '',
    diagnosis: '',
    remediation: '',
  })

  async function handleCreate() {
    await createEntry.mutateAsync(form)
    setForm({ title: '', failureType: '', source: '', severity: 'medium', affectedResource: '', description: '', diagnosis: '', remediation: '' })
    setOpen(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Playbooks</h1>
          <p className="text-sm text-muted-foreground mt-1">Diagnostic playbook entries</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger>
            <Button size="sm">
              <Plus className="size-4 mr-1" />
              New Entry
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Playbook Entry</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Title</label>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Expired API token detected" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Failure Type</label>
                  <Input value={form.failureType} onChange={(e) => setForm({ ...form, failureType: e.target.value })} placeholder="e.g. expired_token" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Source</label>
                  <Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="e.g. sentry" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Severity</label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    value={form.severity}
                    onChange={(e) => setForm({ ...form, severity: e.target.value })}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Affected Resource</label>
                  <Input value={form.affectedResource} onChange={(e) => setForm({ ...form, affectedResource: e.target.value })} placeholder="e.g. API Gateway" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Diagnosis</label>
                <Input value={form.diagnosis} onChange={(e) => setForm({ ...form, diagnosis: e.target.value })} placeholder="Root cause analysis..." />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Remediation</label>
                <Input value={form.remediation} onChange={(e) => setForm({ ...form, remediation: e.target.value })} placeholder="Steps to fix..." />
              </div>
              <Button onClick={handleCreate} className="w-full" disabled={!form.title || !form.failureType || !form.source || !form.affectedResource}>
                {createEntry.isPending ? 'Creating...' : 'Create Entry'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Quick Generate</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {quickTypes.map((qt) => (
            <Button
              key={qt.type}
              variant="outline"
              size="sm"
              onClick={() => autoGenerate.mutate({ failureType: qt.type, resource: qt.resource })}
              disabled={autoGenerate.isPending}
            >
              {autoGenerate.isPending ? '...' : `+ ${qt.label}`}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="investigating">Investigating</TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
        </TabsList>

        {isLoading && (
          <div className="mt-4 text-sm text-muted-foreground">Loading playbook entries...</div>
        )}

        {['all', 'open', 'investigating', 'resolved'].map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-4 space-y-4">
            {!entries || entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No playbook entries found.</p>
            ) : (
              entries
                .filter((e) => tab === 'all' || e.status === tab)
                .map((entry) => (
                  <Card key={entry.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <CardTitle className="text-sm font-medium">{entry.title}</CardTitle>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant={
                                entry.severity === 'critical' ? 'destructive' :
                                entry.severity === 'high' ? 'default' : 'secondary'
                              }
                            >
                              {entry.severity}
                            </Badge>
                            <button
                              onClick={() => {
                                const idx = statusCycle.indexOf(entry.status as typeof statusCycle[number])
                                const next = statusCycle[(idx + 1) % statusCycle.length]
                                updateStatus.mutate({ id: entry.id, status: next })
                              }}
                              title="Click to cycle status: open → investigating → resolved"
                            >
                              <Badge variant="outline" className="capitalize cursor-pointer hover:bg-accent">{entry.status}</Badge>
                            </button>
                            <span className="text-xs text-muted-foreground">{entry.affectedResource}</span>
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {new Date(entry.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Diagnosis</p>
                        <p className="text-sm">{entry.diagnosis || 'No diagnosis recorded'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Remediation Steps</p>
                        <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans">
                          {entry.remediation || 'No remediation steps recorded'}
                        </pre>
                      </div>
                    </CardContent>
                  </Card>
                ))
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
