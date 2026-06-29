import type { Metadata } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'
import { TRPCProvider } from '@/lib/trpc'
import { Toaster } from 'sonner'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Nightlamp — 24/7 Monitoring for AI-Built Apps',
  description: 'Nightlamp monitors your app around the clock, catches silent failures before users do, and fixes them without you touching code.',
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
