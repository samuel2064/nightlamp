import type { Database } from 'sql.js';
import { up as tenantIsolationUp } from './008-tenant-isolation';
import { up as monitoredAppsUp } from './010-monitored-apps';
import { up as analyticsEventsUp } from './011-analytics-events';
import { up as personalOwnershipUp } from './012-personal-ownership';

interface MigrationDefinition {
  id: string;
  up: (db: Database) => void;
  isApplied: (db: Database) => boolean;
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
    isApplied: (db) => hasColumn(db, 'checks', 'team_id') && hasColumn(db, 'alert_rules', 'team_id'),
  },
  {
    id: '010-monitored-apps',
    up: monitoredAppsUp,
    isApplied: (db) => tableExists(db, 'monitored_apps') && tableExists(db, 'health_snapshots'),
  },
  {
    id: '011-analytics-events',
    up: analyticsEventsUp,
    isApplied: (db) => tableExists(db, 'analytics_events') && tableExists(db, 'feedback_responses'),
  },
  {
    id: '012-personal-ownership',
    up: personalOwnershipUp,
    isApplied: (db) => hasColumn(db, 'alert_channels', 'owner_id') && hasColumn(db, 'monitored_apps', 'owner_id'),
  },
];

function ledgerContains(db: Database, migrationId: string): boolean {
  const result = db.exec('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId]);
  return result.length > 0 && result[0].values.length > 0;
}

export function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  for (const migration of MIGRATIONS) {
    const alreadyApplied = migration.isApplied(db);

    if (!alreadyApplied) {
      db.exec('BEGIN IMMEDIATE');
      try {
        migration.up(db);
        db.run('INSERT INTO schema_migrations (migration_id) VALUES (?)', [migration.id]);
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

    if (!ledgerContains(db, migration.id)) {
      db.run('INSERT OR IGNORE INTO schema_migrations (migration_id) VALUES (?)', [migration.id]);
    }
  }
}
