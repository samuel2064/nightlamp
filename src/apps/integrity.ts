import type { Database } from 'sql.js';

export interface AppIntegrityReport {
  orphanedSnapshotsRemoved: number;
  orphanedAppsDisabled: number;
}

/**
 * Restore referential integrity for the monitored app feature.
 *
 * `monitored_apps.alert_channel_id` must reference an existing channel and
 * `health_snapshots.app_id` must reference an existing application. Rows that
 * lost their parent (for example after a channel was removed outside the API)
 * are repaired instead of being served as broken records.
 */
export function repairAppIntegrity(db: Database): AppIntegrityReport {
  const snapshots = db.run(
    'DELETE FROM health_snapshots WHERE app_id NOT IN (SELECT id FROM monitored_apps)',
  );
  const apps = db.run(
    `UPDATE monitored_apps
     SET enabled = 0, updated_at = datetime('now')
     WHERE alert_channel_id NOT IN (SELECT id FROM alert_channels)`,
  );

  return {
    orphanedSnapshotsRemoved: snapshots.getRowsModified(),
    orphanedAppsDisabled: apps.getRowsModified(),
  };
}
