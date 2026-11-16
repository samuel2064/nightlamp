import { Database } from 'sql.js';
import { v4 as uuid } from 'uuid';
import { tenantFilter } from '../api/tenant';

export class UsageTracker {
  constructor(private db: Database) {}

  recordUsage(customerId: string, metric: string, value: number, teamId: string | null = null): void {
    this.db.run(
      'INSERT INTO usage_records (id, customer_id, metric, value, team_id) VALUES (?, ?, ?, ?, ?)',
      [uuid(), customerId, metric, value, teamId],
    );
  }

  getCurrentUsage(customerId: string, teamId: string | null = null): { monitors: number; reports: number; storageMb: number } {
    const scope = tenantFilter('team_id', teamId);
    const monitorsResult = this.db.exec(
      `SELECT COALESCE(SUM(value), 0) FROM usage_records WHERE customer_id = ? AND ${scope.clause} AND metric = ?`,
      [customerId, ...scope.params, 'monitors'],
    );
    const reportsResult = this.db.exec(
      `SELECT COALESCE(SUM(value), 0) FROM usage_records WHERE customer_id = ? AND ${scope.clause} AND metric = ?`,
      [customerId, ...scope.params, 'reports'],
    );
    const storageResult = this.db.exec(
      `SELECT COALESCE(SUM(value), 0) FROM usage_records WHERE customer_id = ? AND ${scope.clause} AND metric = ?`,
      [customerId, ...scope.params, 'storage_mb'],
    );

    const getVal = (result: any): number => {
      if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values[0][0] as number;
      }
      return 0;
    };

    return {
      monitors: getVal(monitorsResult),
      reports: getVal(reportsResult),
      storageMb: getVal(storageResult),
    };
  }

  resetUsage(customerId: string, teamId: string | null = null): void {
    const scope = tenantFilter('team_id', teamId);
    this.db.run(`DELETE FROM usage_records WHERE customer_id = ? AND ${scope.clause}`, [customerId, ...scope.params]);
  }
}