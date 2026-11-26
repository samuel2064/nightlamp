import type { Database } from 'sql.js';
import { up as tenantIsolationUp } from './008-tenant-isolation';
import { up as monitoredAppsUp } from './010-monitored-apps';
import { up as analyticsEventsUp } from './011-analytics-events';
import { up as personalOwnershipUp } from './012-personal-ownership';

interface MigrationDefinition {
  id: string;
  up: (db: Database) => void;
}

function tableExists(db: Database, table: string): boolean {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return result.length > 0 && result[0].values.length > 0;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 && result[0].values.some((row: any) => row[1] === column);
}

const MIGRATIONS: MigrationDefinition[] = [
  {
    id: '008-tenant-isolation',
    up: tenantIsolationUp,
  },
  {
    id: '010-monitored-apps',
    up: monitoredAppsUp,
  },
  {
    id: '011-analytics-events',
    up: analyticsEventsUp,
  },
  {
    id: '012-personal-ownership',
    up: personalOwnershipUp,
  },
];

function ledgerContains(db: Database, migrationId: string): boolean {
  const result = db.exec('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId]);
  return result.length > 0 && result[0].values.length > 0;
}

// The ledger order is carried by seq, not applied_at: datetime('now') has
// one-second resolution, so migrations applied inside the same second tie.
// Every recorded row gets a monotonic seq, so the order is total.
function ensureLedgerSeq(db: Database): void {
  if (!hasColumn(db, 'schema_migrations', 'seq')) {
    db.run('ALTER TABLE schema_migrations ADD COLUMN seq INTEGER');
  }
  for (const migration of MIGRATIONS) {
    db.run(`
      UPDATE schema_migrations
         SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM schema_migrations)
       WHERE migration_id = ? AND seq IS NULL
    `, [migration.id]);
  }
  const seqless = db.exec('SELECT migration_id FROM schema_migrations WHERE seq IS NULL');
  for (const row of seqless[0]?.values ?? []) {
    db.run(`
      UPDATE schema_migrations
         SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM schema_migrations)
       WHERE migration_id = ?
    `, [row[0]]);
  }
}

export function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      seq INTEGER,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  ensureLedgerSeq(db);

  for (const migration of MIGRATIONS) {
    const alreadyInLedger = ledgerContains(db, migration.id);

    if (!alreadyInLedger) {
      db.exec('BEGIN IMMEDIATE');
      try {
        migration.up(db);
        db.run(`
          INSERT INTO schema_migrations (migration_id, seq)
          VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM schema_migrations))
        `, [migration.id]);
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The failed transaction is already rolled back by SQLite.
        }
        throw error;
      }
      continue;
    }

    const stillApplied = migration.id === '008-tenant-isolation'
      ? hasColumn(db, 'checks', 'team_id') && hasColumn(db, 'alert_rules', 'team_id')
      : migration.id === '010-monitored-apps'
        ? tableExists(db, 'monitored_apps') && tableExists(db, 'health_snapshots')
        : migration.id === '011-analytics-events'
          ? tableExists(db, 'analytics_events') && tableExists(db, 'feedback_responses')
          : migration.id === '012-personal-ownership'
            ? hasColumn(db, 'alert_channels', 'owner_id') && hasColumn(db, 'monitored_apps', 'owner_id')
            : false;

    if (!stillApplied) {
      throw new Error(`Migration ${migration.id} recorded in ledger but schema not present - manual intervention required`);
    }
  }
}
