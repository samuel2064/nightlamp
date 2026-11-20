import { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { createDatabase } from './src/db';

async function runSecondBootProbe() {
  console.log('=== Second Boot Probe ===');
  
  // First boot - create database with all migrations
  console.log('\n--- First Boot ---');
  const db1 = await createDatabase();
  console.log('First boot completed successfully');
  
  // Save database to file
  const dbPath = path.join(__dirname, 'test-second-boot.db');
  const data = db1.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  console.log(`Database saved to ${dbPath}`);
  db1.close();
  
  // Second boot - load from file and run migrations again
  console.log('\n--- Second Boot ---');
  const fileBuffer = fs.readFileSync(dbPath);
  
  const SQL = await import('sql.js');
  const sql = await SQL.default();
  const db2 = new sql.Database(fileBuffer);
  
  // Run tenant isolation migrations again (these are the ones that add team_id columns)
  const migrationFiles = [
    'src/db/migrations/008-tenant-isolation.ts',
    'src/db/migrations/012-playbook-executions-tenant.ts',
    'src/db/migrations/013-perf-tenant.ts',
    'src/db/migrations/014-leads-tenant.ts',
  ];
  
  for (const migrationFile of migrationFiles) {
    try {
      const migration = await import(path.resolve(migrationFile));
      if (migration.up) {
        console.log(`Running migration: ${migrationFile}`);
        migration.up(db2);
      }
    } catch (err: any) {
      console.error(`FAILED on second boot - migration ${migrationFile}:`, err.message);
      process.exit(1);
    }
  }
  
  console.log('Second boot migrations completed successfully');
  
  // Verify team_id columns exist
  const tablesToCheck = [
    'playbook_executions',
    'perf_runs',
    'perf_regressions',
    'perf_diagnoses',
    'leads',
  ];
  
  console.log('\n--- Verification ---');
  for (const table of tablesToCheck) {
    const result = db2.exec(`PRAGMA table_info(${table})`);
    const hasTeamId = result.length > 0 && result[0].values.some((row: any) => row[1] === 'team_id');
    console.log(`${table}: team_id column ${hasTeamId ? 'EXISTS' : 'MISSING'}`);
    if (!hasTeamId) {
      console.error(`ERROR: ${table} is missing team_id column!`);
      process.exit(1);
    }
  }
  
  // Clean up
  fs.unlinkSync(dbPath);
  db2.close();
  
  console.log('\n=== Second Boot Probe PASSED ===');
  process.exit(0);
}

runSecondBootProbe().catch(err => {
  console.error('Second boot probe failed:', err);
  process.exit(1);
});