import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sidebar } from '@/components/dashboard/sidebar'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}))

describe('Sidebar', () => {
  it('renders the Nightlamp logo', () => {
    render(<Sidebar />)
    expect(screen.getByText('Nightlamp')).toBeInTheDocument()
  })

  it('renders all navigation items', () => {
    render(<Sidebar />)
    expect(screen.getByText('Overview')).toBeInTheDocument()
    expect(screen.getByText('Incidents')).toBeInTheDocument()
    expect(screen.getByText('Health')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
    expect(screen.getByText('Dependencies')).toBeInTheDocument()
    expect(screen.getByText('Playbooks')).toBeInTheDocument()
    expect(screen.getByText('Billing')).toBeInTheDocument()
  })
})
