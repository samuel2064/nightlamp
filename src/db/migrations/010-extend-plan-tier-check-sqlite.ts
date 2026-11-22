/**
 * Migration 010 (SQLite): Extend plan_tier CHECK constraint on subscriptions table
 * to include the new catalogue tiers (free, pro_monthly, pro_yearly,
 * team_monthly, team_yearly, enterprise) alongside legacy aliases.
 *
 * SQLite does not support ALTER CHECK constraint, so we rebuild the table.
 * Applied at boot by src/db/migrations/008-tenant-isolation.ts.
 */
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

function getConstraint(db: Database, table: string): string | null {
  const result = db.exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  const sql = result[0].values[0][0] as string;
  const match = sql.match(/CHECK\(plan_tier\s+IN\s+\([^)]+\)\)/i);
  return match ? match[0] : null;
}

export function up(db: Database): void {
  if (!tableExists(db, 'subscriptions')) return;

  const currentConstraint = getConstraint(db, 'subscriptions');
  const expectedConstraint = EXTENDED_CHECK;

  // If the constraint already matches, nothing to do
  if (currentConstraint === expectedConstraint) return;

  // Rebuild the subscriptions table with the extended CHECK constraint
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
    );
  `);

  // Copy data from old table to new table
  db.run(`
    INSERT INTO subscriptions_tenant (id, customer_id, stripe_subscription_id, plan_tier, status,
      current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at, team_id)
    SELECT id, customer_id, stripe_subscription_id, plan_tier, status,
      current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at,
      COALESCE(team_id, '')
    FROM subscriptions;
  `);

  db.run('DROP TABLE subscriptions');
  db.run('ALTER TABLE subscriptions_tenant RENAME TO subscriptions');

  // Recreate the customer index
  db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id)');
}

export function down(db: Database): void {
  if (!tableExists(db, 'subscriptions')) return;

  // Revert to the original CHECK constraint with only legacy tiers
  db.run('DROP TABLE IF EXISTS subscriptions_tenant');

  db.run(`
    CREATE TABLE subscriptions_tenant (
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
    );
  `);

  db.run(`
    INSERT INTO subscriptions_tenant (id, customer_id, stripe_subscription_id, plan_tier, status,
      current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at, team_id)
    SELECT id, customer_id, stripe_subscription_id, plan_tier, status,
      current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at,
      COALESCE(team_id, '')
    FROM subscriptions;
  `);

  db.run('DROP TABLE subscriptions');
  db.run('ALTER TABLE subscriptions_tenant RENAME TO subscriptions');

  db.run('CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id)');
}