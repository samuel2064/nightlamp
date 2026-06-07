import express from 'express'
import cors from 'cors'
import { initDb } from './db.js'
import billingRoutes from './billing/routes.js'
import playbookRoutes from './playbooks/routes.js'
import { getDependencyHealth } from './api/dependency-health.js'
import { getMonitors } from './api/monitors.js'
import { getIncidents } from './api/incidents.js'
import { getActivity } from './api/activity.js'

const app = express()
const PORT = parseInt(process.env.PORT || '3000', 10)

app.use(cors())

app.use('/api/billing/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

app.use('/api/billing', billingRoutes)
app.use('/api/playbooks', playbookRoutes)

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'nightlamp-backend' })
})

app.get('/api/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'nightlamp-backend' })
})

app.get('/api/dependency-health', (_req, res) => {
  res.json(getDependencyHealth())
})

app.get('/api/monitors', (_req, res) => {
  res.json(getMonitors())
})

app.get('/api/incidents', (_req, res) => {
  res.json(getIncidents())
})

app.get('/api/activity', (_req, res) => {
  res.json(getActivity())
})

async function start() {
  await initDb()
  app.listen(PORT, () => {
    console.log(`Nightlamp backend listening on port ${PORT}`)
  })
}

start().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})

export default app