import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge } from '@/components/ui/badge'

describe('Badge', () => {
  it('renders with default variant', () => {
    render(<Badge>test</Badge>)
    expect(screen.getByText('test')).toBeDefined()
  })

  it('applies destructive variant class', () => {
    const { container } = render(<Badge variant="destructive">critical</Badge>)
    expect(container.firstChild).toBeDefined()
  })
})
