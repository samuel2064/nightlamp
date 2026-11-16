'use client'

import { cn } from '@/lib/utils'

interface SparklineProps {
  data: number[]
  color?: 'success' | 'warning' | 'error' | 'info'
  className?: string
}

const colorMap = {
  success: 'stroke-success',
  warning: 'stroke-warning',
  error: 'stroke-error',
  info: 'stroke-info',
}

export function Sparkline({ data, color = 'success', className }: SparklineProps) {
  if (!data.length) return null

  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * 100
    const y = 100 - ((value - min) / range) * 100
    return `${x},${y}`
  }).join(' ')

  return (
    <svg
      className={cn('w-full h-12', className)}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="sparkline-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        className={cn('fill-none stroke-current stroke-[1.5]', colorMap[color])}
        d={`M${points}`}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className={cn('stroke-none', colorMap[color].replace('stroke', 'fill'))}
        d={`M${points} L100,100 L0,100 Z`}
        opacity="0.1"
      />
    </svg>
  )
}