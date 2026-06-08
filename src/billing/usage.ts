import { Database } from 'sql.js';
import { v4 as uuid } from 'uuid';

export class UsageTracker {
  constructor(private db: Database) {}

  recordUsage(customerId: string, metric: string, value: number): void {
    this.db.run(
      'INSERT INTO usage_records (id, customer_id, metric, value) VALUES (?, ?, ?, ?)',
      [uuid(), customerId, metric, value],
    );
  }

  getCurrentUsage(customerId: string): { monitors: number; reports: number; storageMb: number } {
    const monitorsResult = this.db.exec(
      'SELECT COALESCE(SUM(value), 0) FROM usage_records WHERE customer_id = ? AND metric = ?',
      [customerId, 'monitors'],
    );
    const reportsResult = this.db.exec(
      'SELECT COALESCE(SUM(value), 0) FROM usage_records WHERE customer_id = ? AND metric = ?',
      [customerId, 'reports'],
    );
    const storageResult = this.db.exec(
      'SELECT COALESCE(SUM(value), 0) FROM usage_records WHERE customer_id = ? AND metric = ?',
      [customerId, 'storage_mb'],
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

  resetUsage(customerId: string): void {
    this.db.run('DELETE FROM usage_records WHERE customer_id = ?', [customerId]);
  }
}