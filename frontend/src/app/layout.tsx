import type { Metadata } from "next"
import localFont from "next/font/local"
import "./globals.css"
import { cn } from "@/lib/utils"
import { TRPCProvider } from "@/components/TRPCProvider"
import { Toaster } from "@/components/ui/sonner"

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-sans",
  weight: "100 900",
})
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-mono",
  weight: "100 900",
})

export const metadata: Metadata = {
  title: "Nightlamp - Monitoring Dashboard",
  description: "Automated health checks, dependency tracking, and diagnostic playbooks",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={cn(geistSans.variable, geistMono.variable, "font-sans antialiased")}>
        <TRPCProvider>
          {children}
          <Toaster />
        </TRPCProvider>
      </body>
    </html>
  )
}
