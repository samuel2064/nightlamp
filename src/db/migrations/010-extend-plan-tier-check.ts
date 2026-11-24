/**
 * Migration 010: Extend plan_tier CHECK constraint on subscriptions table
 * to include the new catalogue tiers (free, pro_monthly, pro_yearly,
 * team_monthly, team_yearly, enterprise) alongside legacy aliases.
 *
 * This migration is Postgres-only. SQLite schema is defined in schema.ts
 * and already includes the extended CHECK constraint.
 */
import { PoolClient } from 'pg';

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

export async function up(client: PoolClient): Promise<void> {
  // Postgres doesn't support ALTER CHECK constraint directly.
  // We need to drop the existing constraint and add a new one.
  // First, find the constraint name.
  const constraintResult = await client.query(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'subscriptions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%plan_tier%';
  `);

  if (constraintResult.rows.length > 0) {
    const constraintName = constraintResult.rows[0].conname;
    await client.query(`ALTER TABLE subscriptions DROP CONSTRAINT ${constraintName}`);
  }

  // Add the new extended CHECK constraint
  await client.query(`ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_tier_check ${EXTENDED_CHECK}`);
}

export async function down(client: PoolClient): Promise<void> {
  // Revert to the original CHECK constraint with only legacy tiers
  const constraintResult = await client.query(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'subscriptions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%plan_tier%';
  `);

  if (constraintResult.rows.length > 0) {
    const constraintName = constraintResult.rows[0].conname;
    await client.query(`ALTER TABLE subscriptions DROP CONSTRAINT ${constraintName}`);
  }

  await client.query(`
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_tier_check
    CHECK(plan_tier IN ('basic', 'advanced', 'white_glove'))
  `);
}