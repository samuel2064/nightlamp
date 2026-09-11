import type { Database } from 'sql.js'

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
      invited_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(team_id, user_id),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS team_workspaces (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL UNIQUE,
      monitors TEXT NOT NULL DEFAULT '[]',
      playbooks TEXT NOT NULL DEFAULT '[]',
      alerts TEXT NOT NULL DEFAULT '[]',
      settings TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_invitations_team ON invitations(team_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token)')
}

export function down(db: Database): void {
  db.run('DROP TABLE IF EXISTS team_workspaces')
  db.run('DROP TABLE IF EXISTS invitations')
  db.run('DROP TABLE IF EXISTS memberships')
  db.run('DROP TABLE IF EXISTS teams')
}
