'use client'

import { Bell, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

export function Topbar() {
  return (
    <header className="h-14 border-b border-border bg-background flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-3 flex-1 max-w-md">
        <Search className="size-4 text-muted-foreground shrink-0" />
        <Input
          placeholder="Search incidents, playbooks..."
          className="h-9 border-0 bg-muted/50 focus-visible:bg-muted"
        />
      </div>
      <div className="flex items-center gap-3">
        <button className="relative p-2 rounded-md hover:bg-muted transition-colors">
          <Bell className="size-4 text-muted-foreground" />
          <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-destructive" />
        </button>
        <Avatar className="size-8">
          <AvatarFallback className="bg-primary/10 text-primary text-xs">EN</AvatarFallback>
        </Avatar>
      </div>
    </header>
  )
}
