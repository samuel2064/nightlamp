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

function getCheckConstraint(db: Database, table: string): string | null {
  const result = db.exec(`
    SELECT sql FROM sqlite_master 
    WHERE type = 'table' AND name = ?
  `, [table]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  const sql = result[0].values[0][0] as string;
  const match = sql.match(/CHECK\s*\([^)]*plan_tier[^)]*\)/i);
  return match ? match[0] : null;
}

function hasExtendedCheck(db: Database): boolean {
  const constraint = getCheckConstraint(db, 'subscriptions');
  if (!constraint) return false;
  return EXTENDED_PLAN_TIERS.every(tier => constraint.includes(`'${tier}'`));
}

export function up(db: Database): void {
  if (!tableExists(db, 'subscriptions')) return;
  if (hasExtendedCheck(db)) return;

  // Rebuild subscriptions table with extended CHECK constraint
  db.run('DROP TABLE IF EXISTS subscriptions_extended');
  db.run(`
    CREATE TABLE subscriptions_extended (
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
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )
  `);

  db.run(`
    INSERT INTO subscriptions_extended (
      id, customer_id, stripe_subscription_id, plan_tier, status,
      current_period_start, current_period_end, cancel_at_period_end,
      created_at, updated_at
    )
    SELECT
      id, customer_id, stripe_subscription_id, plan_tier, status,
      current_period_start, current_period_end, cancel_at_period_end,
      created_at, updated_at
    FROM subscriptions
  `);

  db.run('DROP TABLE subscriptions');
  db.run('ALTER TABLE subscriptions_extended RENAME TO subscriptions');
}

export function down(db: Database): void {
  if (!tableExists(db, 'subscriptions')) return;

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
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )
  `);

  db.run(`
    INSERT INTO subscriptions_legacy (
      id, customer_id, stripe_subscription_id, plan_tier, status,
      current_period_start, current_period_end, cancel_at_period_end,
      created_at, updated_at
    )
    SELECT
      id, customer_id, stripe_subscription_id, plan_tier, status,
      current_period_start, current_period_end, cancel_at_period_end,
      created_at, updated_at
    FROM subscriptions
    WHERE plan_tier IN ('basic', 'advanced', 'white_glove')
  `);

  db.run('DROP TABLE subscriptions');
  db.run('ALTER TABLE subscriptions_legacy RENAME TO subscriptions');
}