import type { Metadata } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'
import { TRPCProvider } from '@/lib/trpc'
import { Toaster } from 'sonner'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Nightlamp',
  description: 'Monitoring platform dashboard',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <body>
          <TRPCProvider>
            {children}
            <Toaster />
          </TRPCProvider>
        </body>
      </html>
    </ClerkProvider>
  )
}
