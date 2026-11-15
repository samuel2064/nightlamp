import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { auth } from '@clerk/nextjs/server'
import { appRouter } from '@/server'

export const dynamic = 'force-dynamic'

const handler = async (req: Request) => {
  const { userId, getToken } = await auth()
  const token = userId ? await getToken() : null

  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => ({ userId: userId ?? null, token: token ?? null }),
  })
}

export { handler as GET, handler as POST }
