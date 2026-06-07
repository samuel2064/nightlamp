export interface Incident {
  id: string
  title: string
  resource: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  status: 'open' | 'investigating' | 'resolved'
  source: string
  time: string
}

export function getIncidents(): Incident[] {
  return [
    {
      id: 'INC-001',
      title: 'Sentry error rate exceeded threshold',
      resource: 'Production API',
      severity: 'critical',
      status: 'investigating',
      source: 'sentry',
      time: new Date(Date.now() - 120_000).toISOString(),
    },
    {
      id: 'INC-002',
      title: 'SSL certificate validation failure',
      resource: 'app.example.com',
      severity: 'high',
      status: 'open',
      source: 'uptime-robot',
      time: new Date(Date.now() - 900_000).toISOString(),
    },
    {
      id: 'INC-003',
      title: 'Response time > 5s on /api/checkout',
      resource: 'API Gateway',
      severity: 'high',
      status: 'resolved',
      source: 'uptime-robot',
      time: new Date(Date.now() - 10_800_000).toISOString(),
    },
    {
      id: 'INC-004',
      title: 'Stripe webhook timeout',
      resource: 'Billing Service',
      severity: 'medium',
      status: 'resolved',
      source: 'sentry',
      time: new Date(Date.now() - 86_400_000).toISOString(),
    },
    {
      id: 'INC-005',
      title: 'Rate limit breached on /api/deployments',
      resource: 'Deployment API',
      severity: 'medium',
      status: 'open',
      source: 'failure-classifier',
      time: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: 'INC-006',
      title: 'Expired auth token detected in billing webhook',
      resource: 'Billing Service',
      severity: 'high',
      status: 'investigating',
      source: 'failure-classifier',
      time: new Date(Date.now() - 7_200_000).toISOString(),
    },
  ]
}
