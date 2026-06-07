import { Router, type Request, type Response } from 'express'
import {
  createPlaybookEntry,
  getPlaybookEntry,
  getPlaybookEntries,
  updatePlaybookStatus,
  deletePlaybookEntry,
  generatePlaybookEntry,
  getRegisteredFailureTypes,
} from './index.js'
import type { PlaybookSeverity, PlaybookStatus } from './index.js'

const router = Router()

router.get('/', (req: Request, res: Response) => {
  const source = typeof req.query.source === 'string' ? req.query.source : undefined
  const severity = typeof req.query.severity === 'string' ? req.query.severity as PlaybookSeverity : undefined
  const status = typeof req.query.status === 'string' ? req.query.status as PlaybookStatus : undefined
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined
  const offset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : undefined

  const entries = getPlaybookEntries({ source, severity, status, limit, offset })
  res.json(entries)
})

router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  const entry = getPlaybookEntry(id)
  if (!entry) {
    res.status(404).json({ error: 'Playbook entry not found' })
    return
  }
  res.json(entry)
})

router.post('/', (req: Request, res: Response) => {
  const { failureType, source, severity, title, description, affectedResource, diagnosis, remediation, relatedEntries } = req.body

  if (!failureType || !source || !severity || !title || !affectedResource) {
    res.status(400).json({ error: 'Missing required fields: failureType, source, severity, title, affectedResource' })
    return
  }

  if (!['critical', 'high', 'medium', 'low'].includes(severity)) {
    res.status(400).json({ error: 'severity must be one of: critical, high, medium, low' })
    return
  }

  const entry = createPlaybookEntry({
    failureType,
    source,
    severity,
    title,
    description: description || '',
    affectedResource,
    diagnosis: diagnosis || '',
    remediation: remediation || '',
    relatedEntries,
  })

  res.status(201).json(entry)
})

router.post('/auto-generate', (req: Request, res: Response) => {
  const { failureType, resource, details } = req.body

  if (!failureType || !resource) {
    res.status(400).json({ error: 'Missing required fields: failureType, resource' })
    return
  }

  const entry = generatePlaybookEntry(failureType, resource, details || {})
  res.status(201).json(entry)
})

router.patch('/:id/status', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  const { status, resolvedAt } = req.body

  if (!['open', 'investigating', 'resolved', 'dismissed'].includes(status)) {
    res.status(400).json({ error: 'status must be one of: open, investigating, resolved, dismissed' })
    return
  }

  const entry = updatePlaybookStatus(id, status, resolvedAt)
  if (!entry) {
    res.status(404).json({ error: 'Playbook entry not found' })
    return
  }

  res.json(entry)
})

router.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  const deleted = deletePlaybookEntry(id)
  if (!deleted) {
    res.status(404).json({ error: 'Playbook entry not found' })
    return
  }
  res.status(204).send()
})

router.get('/meta/failure-types', (_req: Request, res: Response) => {
  res.json({ failureTypes: getRegisteredFailureTypes() })
})

export default router