import { Router, type Request, type Response } from 'express'
import { listActions } from './actions/registry.js'
import {
  listRuns,
  approveRun,
  rejectRun,
  retryRun,
  listPolicies,
  updatePolicy,
} from './engine.js'

const router = Router()

router.get('/actions', (_req: Request, res: Response) => {
  res.json(listActions())
})

router.get('/runs', (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const playbook_entry_id = typeof req.query.playbook_entry_id === 'string' ? req.query.playbook_entry_id : undefined
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined
  const offset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : undefined

  res.json(listRuns({ status, playbook_entry_id, limit, offset }))
})

router.post('/runs/:id/approve', async (req: Request, res: Response) => {
  try {
    const result = await approveRun(String(req.params.id))
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

router.post('/runs/:id/reject', (req: Request, res: Response) => {
  try {
    res.json(rejectRun(String(req.params.id)))
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

router.post('/runs/:id/retry', async (req: Request, res: Response) => {
  try {
    const result = await retryRun(String(req.params.id))
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

router.get('/policies', (_req: Request, res: Response) => {
  res.json(listPolicies())
})

router.patch('/policies/:id', (req: Request, res: Response) => {
  const { auto_approve, require_dry_run, cooldown_minutes } = req.body
  try {
    res.json(updatePolicy(String(req.params.id), { auto_approve, require_dry_run, cooldown_minutes }))
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

export default router
