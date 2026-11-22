import type { Database } from 'sql.js';

const EXTENDED_PLAN_TIERS = [
  'free',
  'pro_monthly',
  'pro_yearly',
  'team_monthly',
  'team_yearly',
  'enterprise',
  'basic',
  'advanced',
  'white_glove',
];

const EXTENDED_CHECK = `CHECK(plan_tier IN (${EXTENDED_PLAN_TIERS.map(t => `'${t}'`).join(', ')}))`;

function tableExists(db: Database, table: string): boolean {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return result.length > 0 && result[0].values.length > 0;
}

function hasConstraint(db: Database, table: string, constraintPattern: string): boolean {
  const result = db.exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
  if (result.length === 0 || result[0].values.length === 0) return false;
  const sql = result[0].values[0][0] as string;
  return sql.includes(constraintPattern);
}

export function up(db: Database): void {
  if (!tableExists(db, 'subscriptions')) return;

  // Check if the extended CHECK constraint is already present
  if (hasConstraint(db, 'subscriptions', "plan_tier IN ('free'")) {
    return; // Already migrated
  }

  // Rebuild subscriptions table with extended CHECK constraint
  db.run('DROP TABLE IF EXISTS subscriptions_tenant');
  db.run(`
    CREATE TABLE subscriptions_tenant (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      stripe_subscription_id TEXT UNIQUE,
      plan_tier TEXT NOT NULL ${EXTENDED_CHECK},
      status TEXT NOT NULL DEFAULT 'incomplete' CHECK(status IN ('incomplete', 'active', 'past_due', 'canceled', 'trialing', 'incomplete_expired')),
      current_period_start TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      team_id TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )
  `);

  // Check if team_id column exists in old table
  const hasTeamId = db.exec("PRAGMA table_info(subscriptions)").length > 0 &&
    db.exec("PRAGMA table_info(subscriptions)")[0].values.some((row: any) => row[1] === 'team_id');

  const teamIdCol = hasTeamId ? 'team_id' : 'NULL AS team_id';

  db.run(`
    INSERT INTO subscriptions_tenant (id, customer_id, stripe_subscription_id, plan_tier, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at, team_id)
    SELECT id, customer_id, stripe_subscription_id, plan_tier, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at, ${teamIdCol}
    FROM subscriptions
  `);

  db.run('DROP TABLE subscriptions');
  db.run('ALTER TABLE subscriptions_tenant RENAME TO subscriptions');

  // Recreate indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_team ON subscriptions(team_id)');
}

export function down(db: Database): void {
  if (!tableExists(db, 'subscriptions')) return;

  // Check if we're already at the legacy constraint
  if (hasConstraint(db, 'subscriptions', "plan_tier IN ('basic'")) {
    return; // Already at legacy
  }

  // Rebuild with legacy CHECK constraint
  db.run('DROP TABLE IF EXISTS subscriptions_legacy');
  db.run(`
    CREATE TABLE subscriptions_legacy (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      stripe_subscription_id TEXT UNIQUE,
      plan_tier TEXT NOT NULL CHECK(plan_tier IN ('basic', 'advanced', 'white_glove')),
      status TEXT NOT NULL DEFAULT 'incomplete' CHECK(status IN ('incomplete', 'active', 'past_due', 'canceled', 'trialing', 'incomplete_expired')),
      current_period_start TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      team_id TEXT,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )
  `);

  const hasTeamId = db.exec("PRAGMA table_info(subscriptions)").length > 0 &&
    db.exec("PRAGMA table_info(subscriptions)")[0].values.some((row: any) => row[1] === 'team_id');

  const teamIdCol = hasTeamId ? 'team_id' : 'NULL AS team_id';

  db.run(`
    INSERT INTO subscriptions_legacy (id, customer_id, stripe_subscription_id, plan_tier, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at, team_id)
    SELECT id, customer_id, stripe_subscription_id, plan_tier, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at, ${teamIdCol}
    FROM subscriptions
  `);

  db.run('DROP TABLE subscriptions');
  db.run('ALTER TABLE subscriptions_legacy RENAME TO subscriptions');

  // Recreate indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_team ON subscriptions(team_id)');
}