export interface Team {
  id: string
  name: string
  slug: string
  ownerId: string
  plan: string
  createdAt: string
}

export interface Membership {
  id: string
  teamId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
  invitedAt: string
}

export interface Invitation {
  id: string
  teamId: string
  email: string
  role: 'admin' | 'member'
  token: string
  expiresAt: string
  createdAt: string
}

export interface TeamWorkspace {
  id: string
  teamId: string
  monitors: string[]
  playbooks: string[]
  alerts: string[]
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type MembershipRole = 'owner' | 'admin' | 'member'

export interface MemberInfo {
  userId: string
  role: MembershipRole
  invitedAt: string
}
