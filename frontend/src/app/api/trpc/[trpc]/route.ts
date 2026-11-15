import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '@/server'
import { createTRPCContext, extractAuthFromRequest, getUserFromToken } from '@/api/trpc'
import { Database } from 'sql.js'
import { createPlaybookEngine } from '../playbook/engine'

let db: Database
let playbookEngine: ReturnType<typeof createPlaybookEngine>

export function initTRPCContext(_db: Database, _engine: ReturnType<typeof createPlaybookEngine>) {
  db = _db
  playbookEngine = _engine
}

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext(db!, playbookEngine!),
  })

export { handler as GET, handler as POST }
