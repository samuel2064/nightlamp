'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { MoreHorizontal, Play, Eye, Edit } from 'lucide-react'
import { formatLatency, relativeTimestamp, formatUtcTimestamp } from '@/lib/format'

interface Column<T> {
  key: string
  header: string
  render: (row: T) => React.ReactNode
  className?: string
  headerClassName?: string
}

interface RowAction<T> {
  label: string
  icon?: React.ReactNode
  onClick: (row: T) => void
  variant?: 'default' | 'destructive'
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  loading?: boolean
  emptyMessage?: string
  rowActions?: RowAction<T>[]
  onRowClick?: (row: T) => void
  className?: string
}

function StatusBadge({ status }: { status: string }) {
  const lower = status.toLowerCase()
  if (lower === 'pass' || lower === 'ok' || lower === 'healthy') {
    return <Badge variant="success">Pass</Badge>
  }
  if (lower === 'warn' || lower === 'degraded') {
    return <Badge variant="warning">Warn</Badge>
  }
  if (lower === 'fail' || lower === 'critical') {
    return <Badge variant="destructive">Fail</Badge>
  }
  return <Badge variant="secondary">{status}</Badge>
}

function TypeBadge({ type }: { type: string }) {
  const lower = type.toLowerCase()
  if (lower === 'http') return <Badge variant="info">HTTP</Badge>
  if (lower === 'tcp') return <Badge variant="secondary">TCP</Badge>
  return <Badge variant="secondary">{type}</Badge>
}

export function DataTable<T extends { id: string }>({
  columns,
  data,
  loading = false,
  emptyMessage = 'No data',
  rowActions,
  onRowClick,
  className,
}: DataTableProps<T>) {
  if (loading) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} className={col.headerClassName}>
                <div className="h-4 w-24 animate-pulse bg-surface-tertiary rounded" />
              </TableHead>
            ))}
            {rowActions && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              {columns.map((col) => (
                <TableCell key={col.key} className={col.className}>
                  <div className="h-4 w-32 animate-pulse bg-surface-tertiary rounded" />
                </TableCell>
              ))}
              {rowActions && <TableCell className="text-right"><div className="h-8 w-24 animate-pulse bg-surface-tertiary rounded" /></TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  if (data.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className={cn('overflow-x-auto', className)}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} className={cn('font-medium', col.headerClassName)}>
                {col.header}
              </TableHead>
            ))}
            {rowActions && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => (
            <TableRow
              key={row.id}
              className={cn(
                'transition-colors',
                onRowClick && 'cursor-pointer hover:bg-surface-tertiary/50'
              )}
              onClick={() => onRowClick?.(row)}
            >
              {columns.map((col) => (
                <TableCell key={col.key} className={col.className}>
                  {col.render(row)}
                </TableCell>
              ))}
              {rowActions && (
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" aria-hidden />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {rowActions.map((action) => (
                        <DropdownMenuItem
                          key={action.label}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            action.onClick(row)
                          }}
                          className={cn(action.variant === 'destructive' && 'text-destructive focus:text-destructive')}
                          inset
                        >
                          {action.icon && <span className="mr-2 flex h-4 w-4">{action.icon}</span>}
                          {action.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function createMonitoringColumns<T extends {
  id: string
  appName: string
  checkName: string
  type: string
  lastStatus: string
  lastRun: string
  duration: string | number
  nextRun: string
}>(
  onRunNow: (row: T) => void,
  onDisable: (row: T) => void,
  onEdit: (row: T) => void
): Column<T>[] {
  return [
    {
      key: 'app',
      header: 'App',
      render: (row) => (
        <div>
          <p className="font-medium truncate max-w-[200px]" title={row.appName}>
            {row.appName}
          </p>
        </div>
      ),
    },
    {
      key: 'check',
      header: 'Check',
      render: (row) => (
        <p className="truncate max-w-[200px]" title={row.checkName}>
          {row.checkName}
        </p>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => <TypeBadge type={row.type} />,
      className: 'hidden md:table-cell',
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge status={row.lastStatus} />,
    },
    {
      key: 'lastRun',
      header: 'Last Run',
      render: (row) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap" title={formatUtcTimestamp(row.lastRun)}>
          {relativeTimestamp(row.lastRun)}
        </span>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      render: (row) => (
        <span className="font-mono text-xs">
          {typeof row.duration === 'number' ? formatLatency(row.duration) : row.duration}
        </span>
      ),
      className: 'hidden lg:table-cell',
    },
    {
      key: 'nextRun',
      header: 'Next Run',
      render: (row) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap" title={formatUtcTimestamp(row.nextRun)}>
          {relativeTimestamp(row.nextRun)}
        </span>
      ),
      className: 'hidden lg:table-cell',
    },
    {
      key: 'actions',
      header: 'Actions',
      render: () => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" aria-hidden />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {}}
              inset
            >
              <Play className="mr-2 h-4 w-4" aria-hidden />
              Run Now
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {}}
              inset
            >
              <Eye className="mr-2 h-4 w-4" aria-hidden />
              View Details
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {}}
              inset
            >
              <Edit className="mr-2 h-4 w-4" aria-hidden />
              Edit
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ]
}