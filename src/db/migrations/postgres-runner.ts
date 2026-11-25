import { Pool, PoolClient } from 'pg';
import { up as extendPlanTierUp } from './010-extend-plan-tier-check';

interface PostgresMigrationDefinition {
  id: string;
  up: (client: PoolClient) => Promise<void>;
}

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
    [table]
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasColumn(client: PoolClient, table: string, column: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    [table, column]
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasIndex(client: PoolClient, indexName: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = $1",
    [indexName]
  );
  return (result.rowCount ?? 0) > 0;
}

async function ledgerContains(client: PoolClient, migrationId: string): Promise<boolean> {
  const result = await client.query(
    'SELECT migration_id FROM schema_migrations WHERE migration_id = $1',
    [migrationId]
  );
  return (result.rowCount ?? 0) > 0;
}

const LEDGER_SEQUENCE = 'schema_migrations_seq_seq';

// The ledger order is carried by seq, not applied_at: every row of one boot
// shares the transaction-start CURRENT_TIMESTAMP, so applied_at cannot order
// them. The sequence is monotonic and total, and every recorded row gets one.
async function ensureLedgerShape(client: PoolClient): Promise<void> {
  await client.query(`CREATE SEQUENCE IF NOT EXISTS ${LEDGER_SEQUENCE} AS bigint START 1`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      seq BIGINT NOT NULL DEFAULT nextval('${LEDGER_SEQUENCE}'),
      applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )
  `);
  // A ledger table created before the sequence column is upgraded in place.
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS seq BIGINT');
  await client.query(`ALTER TABLE schema_migrations ALTER COLUMN seq SET DEFAULT nextval('${LEDGER_SEQUENCE}')`);
  // Backfill in runner order, then any remaining row, so the order stays total.
  for (const migration of POSTGRES_MIGRATIONS) {
    await client.query(
      'UPDATE schema_migrations SET seq = DEFAULT WHERE migration_id = $1 AND seq IS NULL',
      [migration.id]
    );
  }
  await client.query('UPDATE schema_migrations SET seq = DEFAULT WHERE seq IS NULL');
  await client.query('ALTER TABLE schema_migrations ALTER COLUMN seq SET NOT NULL');
}

// Record one entry at its runner position: entries applied before it keep
// their sequence, later entries shift up, so an upgraded destination still
// ends with the ledger in runner order.
async function recordLedgerEntry(client: PoolClient, migrationId: string, position: number): Promise<void> {
  const prior = POSTGRES_MIGRATIONS.slice(0, position).map(m => m.id);
  const targetResult = await client.query(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS target
      FROM schema_migrations
     WHERE migration_id = ANY($1::text[])
  `, [prior]);
  const target = parseInt(targetResult.rows[0].target, 10);
  await client.query('UPDATE schema_migrations SET seq = seq + 1 WHERE seq >= $1', [target]);
  await client.query('INSERT INTO schema_migrations (migration_id, seq) VALUES ($1, $2)', [migrationId, target]);
}

async function checkSchemaStillApplied(client: PoolClient, migrationId: string): Promise<boolean> {
  if (migrationId === '009-postgres-setup') {
    const teams = await tableExists(client, 'teams');
    const checks = await tableExists(client, 'checks');
    const alerts = await tableExists(client, 'alert_rules');
    const channels = await tableExists(client, 'alert_channels');
    return teams && checks && alerts && channels;
  }
  if (migrationId === '008-tenant-isolation') {
    const checks = await hasColumn(client, 'checks', 'team_id');
    const alerts = await hasColumn(client, 'alert_rules', 'team_id');
    return checks && alerts;
  }
  if (migrationId === '010-monitored-apps') {
    const monitored = await tableExists(client, 'monitored_apps');
    const health = await tableExists(client, 'health_snapshots');
    return monitored && health;
  }
  if (migrationId === '011-analytics-events') {
    const analytics = await tableExists(client, 'analytics_events');
    const feedback = await tableExists(client, 'feedback_responses');
    return analytics && feedback;
  }
  if (migrationId === '012-personal-ownership') {
    const alert = await hasColumn(client, 'alert_channels', 'owner_id');
    const monitored = await hasColumn(client, 'monitored_apps', 'owner_id');
    return alert && monitored;
  }
  if (migrationId === '013-clerk-webhook-events') {
    const clerkWebhook = await tableExists(client, 'clerk_webhook_events');
    const clerkTeamId = await hasColumn(client, 'clerk_webhook_events', 'team_id');
    const leadsTeamId = await hasColumn(client, 'leads', 'team_id');
    const perfRunsTeamId = await hasColumn(client, 'perf_runs', 'team_id');
    const perfRegressionsTeamId = await hasColumn(client, 'perf_regressions', 'team_id');
    const perfDiagnosesTeamId = await hasColumn(client, 'perf_diagnoses', 'team_id');
    const playbookExecutionsTeamId = await hasColumn(client, 'playbook_executions', 'team_id');
    return clerkWebhook && clerkTeamId && leadsTeamId && perfRunsTeamId && perfRegressionsTeamId && perfDiagnosesTeamId && playbookExecutionsTeamId;
  }
  if (migrationId === '010-extend-plan-tier-check') {
    const constraintResult = await client.query(`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'subscriptions'::regclass
         AND conname = 'subscriptions_plan_tier_check'
    `);
    return constraintResult.rows.length > 0 && constraintResult.rows[0].def.includes('pro_monthly');
  }
  return false;
}

export const POSTGRES_MIGRATIONS = [
  {
    id: '009-postgres-setup',
    up: async (client: PoolClient) => {
      // Base schema - creates all tables including teams
      await client.query(`
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL,
          plan TEXT NOT NULL DEFAULT 'free',
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // memberships
      await client.query(`
        CREATE TABLE IF NOT EXISTS memberships (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
          invited_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          UNIQUE(team_id, user_id),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // invitations
      await client.query(`
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          email TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
          token TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // team_workspaces
      await client.query(`
        CREATE TABLE IF NOT EXISTS team_workspaces (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL UNIQUE,
          monitors TEXT NOT NULL DEFAULT '[]',
          playbooks TEXT NOT NULL DEFAULT '[]',
          alerts TEXT NOT NULL DEFAULT '[]',
          settings TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // checks
      await client.query(`
        CREATE TABLE IF NOT EXISTS checks (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          name TEXT NOT NULL,
          config TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // check_results
      await client.query(`
        CREATE TABLE IF NOT EXISTS check_results (
          id TEXT PRIMARY KEY,
          check_id TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT,
          details TEXT,
          raw_data TEXT,
          executed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (check_id) REFERENCES checks(id)
        );
      `);

      // failure_events
      await client.query(`
        CREATE TABLE IF NOT EXISTS failure_events (
          id TEXT PRIMARY KEY,
          check_id TEXT NOT NULL,
          failure_type TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'warning',
          title TEXT NOT NULL,
          description TEXT,
          raw_data TEXT,
          detected_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          acknowledged INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (check_id) REFERENCES checks(id)
        );
      `);

      // playbook_entries
      await client.query(`
        CREATE TABLE IF NOT EXISTS playbook_entries (
          id TEXT PRIMARY KEY,
          failure_type TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          first_seen_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          last_occurrence_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          occurrence_count INTEGER NOT NULL DEFAULT 1
        );
      `);

      // customers
      await client.query(`
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          stripe_customer_id TEXT UNIQUE,
          email TEXT NOT NULL,
          name TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // users
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          clerk_user_id TEXT UNIQUE,
          email TEXT NOT NULL,
          name TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // subscriptions
      await client.query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          stripe_subscription_id TEXT UNIQUE,
          plan_tier TEXT NOT NULL CHECK(plan_tier IN ('basic', 'advanced', 'white_glove')),
          status TEXT NOT NULL DEFAULT 'incomplete' CHECK(status IN ('incomplete', 'active', 'past_due', 'canceled', 'trialing', 'incomplete_expired')),
          current_period_start TEXT,
          current_period_end TEXT,
          cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (customer_id) REFERENCES customers(id)
        );
      `);

      // usage_records
      await client.query(`
        CREATE TABLE IF NOT EXISTS usage_records (
          id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL,
          metric TEXT NOT NULL,
          value REAL NOT NULL DEFAULT 0,
          recorded_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (customer_id) REFERENCES customers(id)
        );
      `);

      // dependencies
      await client.query(`
        CREATE TABLE IF NOT EXISTS dependencies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          current_version TEXT NOT NULL,
          specified_range TEXT NOT NULL,
          is_dev INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // dependency_updates
      await client.query(`
        CREATE TABLE IF NOT EXISTS dependency_updates (
          id TEXT PRIMARY KEY,
          dependency_id TEXT NOT NULL,
          available_version TEXT NOT NULL,
          current_version TEXT NOT NULL,
          change_type TEXT NOT NULL CHECK(change_type IN ('major', 'minor', 'patch', 'unknown')),
          is_breaking INTEGER NOT NULL DEFAULT 0,
          changelog_url TEXT,
          detected_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (dependency_id) REFERENCES dependencies(id)
        );
      `);

      // remediation_log
      await client.query(`
        CREATE TABLE IF NOT EXISTS remediation_log (
          id TEXT PRIMARY KEY,
          playbook_entry_id TEXT NOT NULL,
          failure_type TEXT NOT NULL,
          script TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'success', 'failed', 'skipped')),
          output TEXT,
          executed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (playbook_entry_id) REFERENCES playbook_entries(id)
        );
      `);

      // remediation_actions
      await client.query(`
        CREATE TABLE IF NOT EXISTS remediation_actions (
          id TEXT PRIMARY KEY,
          failure_type TEXT NOT NULL,
          action_name TEXT NOT NULL,
          description TEXT,
          risk_level TEXT NOT NULL DEFAULT 'medium',
          enabled INTEGER NOT NULL DEFAULT 1
        );
      `);

      // remediation_runs
      await client.query(`
        CREATE TABLE IF NOT EXISTS remediation_runs (
          id TEXT PRIMARY KEY,
          playbook_entry_id TEXT REFERENCES playbook_entries(id),
          action_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          initiated_by TEXT,
          approved_by TEXT,
          output TEXT,
          error TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // remediation_policies
      await client.query(`
        CREATE TABLE IF NOT EXISTS remediation_policies (
          id TEXT PRIMARY KEY,
          failure_type TEXT NOT NULL,
          auto_approve INTEGER NOT NULL DEFAULT 0,
          require_dry_run INTEGER NOT NULL DEFAULT 1,
          cooldown_minutes INTEGER NOT NULL DEFAULT 60,
          UNIQUE(failure_type)
        );
      `);

      // x_tokens
      await client.query(`
        CREATE TABLE IF NOT EXISTS x_tokens (
          id TEXT PRIMARY KEY,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          scope TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // x_scheduled_posts
      await client.query(`
        CREATE TABLE IF NOT EXISTS x_scheduled_posts (
          id TEXT PRIMARY KEY,
          tweet_text TEXT NOT NULL,
          position INTEGER NOT NULL,
          in_reply_to_id TEXT,
          tweet_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'posted', 'failed')),
          error TEXT,
          scheduled_at TEXT,
          posted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // perf_runs
      await client.query(`
        CREATE TABLE IF NOT EXISTS perf_runs (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
          lcp REAL,
          tbt REAL,
          cls REAL,
          fcp REAL,
          inp REAL,
          score REAL,
          raw_output TEXT,
          started_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          completed_at TEXT
        );
      `);

      // perf_metrics
      await client.query(`
        CREATE TABLE IF NOT EXISTS perf_metrics (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          name TEXT NOT NULL,
          value REAL NOT NULL,
          unit TEXT NOT NULL DEFAULT 'ms',
          score REAL,
          FOREIGN KEY (run_id) REFERENCES perf_runs(id)
        );
      `);

      // perf_regressions
      await client.query(`
        CREATE TABLE IF NOT EXISTS perf_regressions (
          id TEXT PRIMARY KEY,
          metric TEXT NOT NULL,
          current_value REAL NOT NULL,
          baseline_mean REAL NOT NULL,
          baseline_stddev REAL NOT NULL,
          p_value REAL NOT NULL,
          direction TEXT NOT NULL CHECK(direction IN ('degradation', 'improvement')),
          trend TEXT NOT NULL DEFAULT 'declining' CHECK(trend IN ('improving', 'declining', 'stable')),
          url TEXT NOT NULL,
          run_id TEXT NOT NULL,
          detected_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          acknowledged INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (run_id) REFERENCES perf_runs(id)
        );
      `);

      // perf_diagnoses
      await client.query(`
        CREATE TABLE IF NOT EXISTS perf_diagnoses (
          id TEXT PRIMARY KEY,
          regression_id TEXT NOT NULL,
          diagnosis TEXT NOT NULL,
          recommendation TEXT NOT NULL,
          impact TEXT NOT NULL CHECK(impact IN ('high', 'medium', 'low')),
          category TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (regression_id) REFERENCES perf_regressions(id)
        );
      `);

      // teams
      await client.query(`
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL,
          plan TEXT NOT NULL DEFAULT 'free',
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // memberships
      await client.query(`
        CREATE TABLE IF NOT EXISTS memberships (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
          invited_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          UNIQUE(team_id, user_id),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // invitations
      await client.query(`
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          email TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
          token TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // team_workspaces
      await client.query(`
        CREATE TABLE IF NOT EXISTS team_workspaces (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL UNIQUE,
          monitors TEXT NOT NULL DEFAULT '[]',
          playbooks TEXT NOT NULL DEFAULT '[]',
          alerts TEXT NOT NULL DEFAULT '[]',
          settings TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // alert_channels
      await client.query(`
        CREATE TABLE IF NOT EXISTS alert_channels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('slack', 'email', 'pagerduty', 'in-app-websocket')),
          config TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          team_id TEXT,
          owner_id TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // alert_rules
      await client.query(`
        CREATE TABLE IF NOT EXISTS alert_rules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          failure_types TEXT NOT NULL,
          min_severity TEXT NOT NULL DEFAULT 'info' CHECK(min_severity IN ('critical', 'warning', 'info')),
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
        );
      `);

      // onboarding_sessions
      await client.query(`
        CREATE TABLE IF NOT EXISTS onboarding_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          current_step TEXT NOT NULL DEFAULT 'app-detection' CHECK(current_step IN ('app-detection', 'monitor-selection', 'alert-config', 'team-invite')),
          step_data TEXT NOT NULL DEFAULT '{}',
          completed_at TEXT,
          created_team_id TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // alert_log
      await client.query(`
        CREATE TABLE IF NOT EXISTS alert_log (
          id TEXT PRIMARY KEY,
          rule_id TEXT,
          channel_id TEXT NOT NULL,
          failure_event_id TEXT,
          failure_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          channel_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'skipped', 'pending', 'delivered')),
          error_message TEXT,
          sent_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // custom_playbooks
      await client.query(`
        CREATE TABLE IF NOT EXISTS custom_playbooks (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
          version INTEGER NOT NULL DEFAULT 1,
          variables TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // playbook_nodes
      await client.query(`
        CREATE TABLE IF NOT EXISTS playbook_nodes (
          id TEXT PRIMARY KEY,
          playbook_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('trigger', 'condition', 'action', 'notification')),
          subtype TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          position_x REAL NOT NULL DEFAULT 0,
          position_y REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (playbook_id) REFERENCES custom_playbooks(id) ON DELETE CASCADE
        );
      `);

      // playbook_edges
      await client.query(`
        CREATE TABLE IF NOT EXISTS playbook_edges (
          id TEXT PRIMARY KEY,
          playbook_id TEXT NOT NULL,
          source_node_id TEXT NOT NULL,
          target_node_id TEXT NOT NULL,
          source_port TEXT NOT NULL DEFAULT 'out',
          target_port TEXT NOT NULL DEFAULT 'in',
          edge_type TEXT NOT NULL DEFAULT 'next' CHECK(edge_type IN ('next', 'failure')),
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (playbook_id) REFERENCES custom_playbooks(id) ON DELETE CASCADE,
          FOREIGN KEY (source_node_id) REFERENCES playbook_nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (target_node_id) REFERENCES playbook_nodes(id) ON DELETE CASCADE
        );
      `);

      // playbook_versions
      await client.query(`
        CREATE TABLE IF NOT EXISTS playbook_versions (
          id TEXT PRIMARY KEY,
          playbook_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          node_snapshot TEXT NOT NULL DEFAULT '[]',
          edge_snapshot TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (playbook_id) REFERENCES custom_playbooks(id) ON DELETE CASCADE
        );
      `);

      // playbook_executions
      await client.query(`
        CREATE TABLE IF NOT EXISTS playbook_executions (
          id TEXT PRIMARY KEY,
          playbook_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'waiting_decision', 'completed', 'failed', 'cancelled')),
          current_step_id TEXT,
          context TEXT NOT NULL DEFAULT '{}',
          step_results TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          completed_at TEXT,
          error TEXT,
          FOREIGN KEY (playbook_id) REFERENCES custom_playbooks(id) ON DELETE CASCADE
        );
      `);

      // notification_rate_limits
      await client.query(`
        CREATE TABLE IF NOT EXISTS notification_rate_limits (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          max_per_minute INTEGER NOT NULL DEFAULT 10,
          max_per_hour INTEGER NOT NULL DEFAULT 100,
          window_start TEXT NOT NULL,
          current_count INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
        );
      `);

      // notification_deduplication
      await client.query(`
        CREATE TABLE IF NOT EXISTS notification_deduplication (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          first_seen_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          last_seen_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          suppress_until TEXT,
          suppression_count INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
        );
      `);

      // leads
      await client.query(`
        CREATE TABLE IF NOT EXISTS leads (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'webinar',
          name TEXT,
          team_id TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // webhook_events
      await client.query(`
        CREATE TABLE IF NOT EXISTS webhook_events (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL DEFAULT 'stripe',
          event_type TEXT NOT NULL,
          livemode INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'processed', 'failed', 'skipped')),
          error TEXT,
          payload TEXT,
          received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          processed_at TEXT
        );
      `);

      // monitored_apps
      await client.query(`
        CREATE TABLE IF NOT EXISTS monitored_apps (
          id TEXT PRIMARY KEY,
          team_id TEXT,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
          url TEXT NOT NULL,
          platform TEXT NOT NULL CHECK(platform IN ('vercel', 'railway', 'heroku', 'aws', 'gcp', 'azure', 'custom')),
          check_type TEXT NOT NULL CHECK(check_type IN ('http', 'tcp', 'keyword')),
          check_target TEXT NOT NULL,
          check_interval_sec INTEGER NOT NULL DEFAULT 60 CHECK(check_interval_sec BETWEEN 10 AND 86400),
          check_timeout_sec INTEGER NOT NULL DEFAULT 10 CHECK(check_timeout_sec BETWEEN 1 AND 30),
          keyword TEXT,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          alert_channel_id TEXT NOT NULL,
          owner_id TEXT,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (team_id) REFERENCES teams(id),
          FOREIGN KEY (alert_channel_id) REFERENCES alert_channels(id)
        );
      `);

      // health_snapshots
      await client.query(`
        CREATE TABLE IF NOT EXISTS health_snapshots (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          team_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('pass', 'fail')),
          status_code INTEGER,
          latency_ms REAL NOT NULL,
          error_type TEXT,
          error_detail TEXT,
          checked_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          FOREIGN KEY (app_id) REFERENCES monitored_apps(id) ON DELETE CASCADE,
          FOREIGN KEY (team_id) REFERENCES teams(id)
        );
      `);

      // analytics_events
      await client.query(`
        CREATE TABLE IF NOT EXISTS analytics_events (
          id TEXT NOT NULL,
          dedup_key TEXT NOT NULL UNIQUE,
          team_id TEXT,
          user_id TEXT NOT NULL,
          event TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          properties TEXT NOT NULL,
          received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          forwarded INTEGER NOT NULL DEFAULT 0,
          forward_attempts INTEGER NOT NULL DEFAULT 0,
          forward_error TEXT
        );
      `);

      // feedback_responses
      await client.query(`
        CREATE TABLE IF NOT EXISTS feedback_responses (
          id TEXT NOT NULL,
          dedup_key TEXT NOT NULL UNIQUE,
          team_id TEXT,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('feedback', 'survey')),
          feedback_type TEXT,
          survey_id TEXT,
          score REAL,
          response TEXT NOT NULL,
          event_id TEXT,
          received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
        );
      `);

      // schema_migrations
      await ensureLedgerShape(client);

      // Indexes
      await client.query('CREATE INDEX IF NOT EXISTS idx_failure_events_detected ON failure_events(detected_at)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_failure_events_type_detected ON failure_events(failure_type, detected_at)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_failure_events_severity_detected ON failure_events(severity, detected_at)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_check_results_executed ON check_results(executed_at)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_check_results_check_executed ON check_results(check_id, executed_at)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_remediation_runs_status ON remediation_runs(status)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_remediation_runs_action ON remediation_runs(action_name)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_remediation_actions_failure ON remediation_actions(failure_type)');

      await client.query('CREATE INDEX IF NOT EXISTS idx_playbook_nodes_playbook ON playbook_nodes(playbook_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_playbook_edges_playbook ON playbook_edges(playbook_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_playbook_versions_playbook ON playbook_versions(playbook_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_custom_playbooks_team ON custom_playbooks(team_id)');

      await client.query('CREATE INDEX IF NOT EXISTS idx_dedup_fingerprint ON notification_deduplication(channel_id, fingerprint)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_rate_limit_channel ON notification_rate_limits(channel_id, window_start)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_alert_channels_team ON alert_channels(team_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id)');

      // Hot-path indexes for performance optimization
      await client.query('CREATE INDEX IF NOT EXISTS idx_perf_runs_url_started ON perf_runs(url, started_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_perf_metrics_run_name ON perf_metrics(run_id, name)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_perf_regressions_url_detected ON perf_regressions(url, detected_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_perf_diagnoses_regression ON perf_diagnoses(regression_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_dep_updates_dep_detected ON dependency_updates(dependency_id, detected_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_usage_customer_recorded ON usage_records(customer_id, recorded_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_failure_check_detected ON failure_events(check_id, detected_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_playbook_failure_type ON playbook_entries(failure_type)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_x_posts_schedule ON x_scheduled_posts(status, scheduled_at)');

      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_email_team ON leads(email, team_id)');

      await client.query('CREATE INDEX IF NOT EXISTS idx_failure_events_severity ON failure_events(severity)');

      await client.query('CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events(event_type)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at DESC)');

      await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_team ON monitored_apps(team_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_channel ON monitored_apps(alert_channel_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_team ON health_snapshots(team_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_app ON health_snapshots(app_id, checked_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_team ON analytics_events(team_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON analytics_events(event)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_received ON analytics_events(received_at DESC)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_responses_team ON feedback_responses(team_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_responses_received ON feedback_responses(received_at DESC)');
    },
  },
  {
    id: '008-tenant-isolation',
    up: async (client: PoolClient) => {
      const tables = [
        'checks', 'check_results', 'failure_events', 'playbook_entries',
        'dependencies', 'dependency_updates', 'customers', 'subscriptions',
        'remediation_log', 'remediation_runs', 'remediation_policies',
        'alert_channels', 'alert_rules', 'onboarding_sessions',
        'x_scheduled_posts', 'usage_records', 'webhook_events',
        'clerk_webhook_events'
      ];

      for (const table of tables) {
        if (await tableExists(client, table)) {
          if (!(await hasColumn(client, table, 'team_id'))) {
            await client.query(`ALTER TABLE ${table} ADD COLUMN team_id TEXT`);
          }
          if (!(await hasIndex(client, `idx_${table}_team`))) {
            await client.query(`CREATE INDEX IF NOT EXISTS idx_${table}_team ON ${table}(team_id)`);
          }
        }
      }

      if (await tableExists(client, 'remediation_policies')) {
        if (!(await hasColumn(client, 'remediation_policies', 'team_id'))) {
          await client.query('ALTER TABLE remediation_policies ADD COLUMN team_id TEXT');
        }
        await client.query(`
          CREATE TABLE IF NOT EXISTS remediation_policies_tenant (
            id TEXT PRIMARY KEY,
            team_id TEXT,
            failure_type TEXT NOT NULL,
            auto_approve INTEGER NOT NULL DEFAULT 0,
            require_dry_run INTEGER NOT NULL DEFAULT 1,
            cooldown_minutes INTEGER NOT NULL DEFAULT 60,
            UNIQUE(team_id, failure_type)
          )
        `);
        await client.query(`
          INSERT INTO remediation_policies_tenant (id, team_id, failure_type, auto_approve, require_dry_run, cooldown_minutes)
          SELECT id, team_id, failure_type, auto_approve, require_dry_run, cooldown_minutes
          FROM remediation_policies
          ON CONFLICT (id) DO NOTHING
        `);
        await client.query('DROP TABLE remediation_policies');
        await client.query('ALTER TABLE remediation_policies_tenant RENAME TO remediation_policies');
      }
    },
  },
  {
    id: '010-monitored-apps',
    up: async (client: PoolClient) => {
      if (!(await tableExists(client, 'monitored_apps'))) {
        await client.query(`
          CREATE TABLE monitored_apps (
            id TEXT PRIMARY KEY,
            team_id TEXT,
            name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
            url TEXT NOT NULL,
            platform TEXT NOT NULL CHECK(platform IN ('vercel', 'railway', 'heroku', 'aws', 'gcp', 'azure', 'custom')),
            check_type TEXT NOT NULL CHECK(check_type IN ('http', 'tcp', 'keyword')),
            check_target TEXT NOT NULL,
            check_interval_sec INTEGER NOT NULL DEFAULT 60 CHECK(check_interval_sec BETWEEN 10 AND 86400),
            check_timeout_sec INTEGER NOT NULL DEFAULT 10 CHECK(check_timeout_sec BETWEEN 1 AND 30),
            keyword TEXT,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
            alert_channel_id TEXT NOT NULL,
            owner_id TEXT,
            created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            FOREIGN KEY (team_id) REFERENCES teams(id),
            FOREIGN KEY (alert_channel_id) REFERENCES alert_channels(id)
          )
        `);
      }
      if (!(await tableExists(client, 'health_snapshots'))) {
        await client.query(`
          CREATE TABLE health_snapshots (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL,
            team_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('pass', 'fail')),
            status_code INTEGER,
            latency_ms REAL NOT NULL,
            error_type TEXT,
            error_detail TEXT,
            checked_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            FOREIGN KEY (app_id) REFERENCES monitored_apps(id) ON DELETE CASCADE,
            FOREIGN KEY (team_id) REFERENCES teams(id)
          )
        `);
      }

      if (!(await hasIndex(client, 'idx_monitored_apps_team'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_team ON monitored_apps(team_id)');
      }
      if (!(await hasIndex(client, 'idx_monitored_apps_channel'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_channel ON monitored_apps(alert_channel_id)');
      }
      if (!(await hasIndex(client, 'idx_health_snapshots_team'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_team ON health_snapshots(team_id)');
      }
      if (!(await hasIndex(client, 'idx_health_snapshots_app'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_app ON health_snapshots(app_id, checked_at DESC)');
      }
      if (!(await hasIndex(client, 'idx_monitored_apps_owner'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
      }
    },
  },
  {
    id: '010-extend-plan-tier-check',
    up: extendPlanTierUp,
  },
  {
    id: '011-analytics-events',
    up: async (client: PoolClient) => {
      if (!(await tableExists(client, 'analytics_events'))) {
        await client.query(`
          CREATE TABLE analytics_events (
            id TEXT NOT NULL,
            dedup_key TEXT NOT NULL UNIQUE,
            team_id TEXT,
            user_id TEXT NOT NULL,
            event TEXT NOT NULL,
            schema_version TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            properties TEXT NOT NULL,
            received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
            forwarded INTEGER NOT NULL DEFAULT 0,
            forward_attempts INTEGER NOT NULL DEFAULT 0,
            forward_error TEXT
          )
        `);
      }
      if (!(await tableExists(client, 'feedback_responses'))) {
        await client.query(`
          CREATE TABLE feedback_responses (
            id TEXT NOT NULL,
            dedup_key TEXT NOT NULL UNIQUE,
            team_id TEXT,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('feedback', 'survey')),
            feedback_type TEXT,
            survey_id TEXT,
            score REAL,
            response TEXT NOT NULL,
            event_id TEXT,
            received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
          )
        `);
      }

      if (!(await hasIndex(client, 'idx_analytics_events_team'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_team ON analytics_events(team_id)');
      }
      if (!(await hasIndex(client, 'idx_analytics_events_event'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON analytics_events(event)');
      }
      if (!(await hasIndex(client, 'idx_analytics_events_received'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_received ON analytics_events(received_at DESC)');
      }
      if (!(await hasIndex(client, 'idx_feedback_responses_team'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_responses_team ON feedback_responses(team_id)');
      }
      if (!(await hasIndex(client, 'idx_feedback_responses_received'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_responses_received ON feedback_responses(received_at DESC)');
      }
    },
  },
  {
    id: '012-personal-ownership',
    up: async (client: PoolClient) => {
      if (await tableExists(client, 'alert_channels') && !(await hasColumn(client, 'alert_channels', 'owner_id'))) {
        await client.query('ALTER TABLE alert_channels ADD COLUMN owner_id TEXT');
      }
      if (await tableExists(client, 'monitored_apps') && !(await hasColumn(client, 'monitored_apps', 'owner_id'))) {
        await client.query('ALTER TABLE monitored_apps ADD COLUMN owner_id TEXT');
      }

      await client.query(`
        UPDATE alert_channels
        SET owner_id = (
          SELECT teams.owner_id FROM teams WHERE teams.id = alert_channels.team_id
        )
        WHERE owner_id IS NULL
          AND team_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM teams WHERE teams.id = alert_channels.team_id AND teams.owner_id IS NOT NULL)
      `);

      await client.query(`
        UPDATE monitored_apps
        SET owner_id = (
          SELECT teams.owner_id FROM teams WHERE teams.id = monitored_apps.team_id
        )
        WHERE owner_id IS NULL
          AND team_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM teams WHERE teams.id = monitored_apps.team_id AND teams.owner_id IS NOT NULL)
      `);

      if (!(await hasIndex(client, 'idx_monitored_apps_owner'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
      }
      if (!(await hasIndex(client, 'idx_alert_channels_owner'))) {
        await client.query('CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id)');
      }
    },
  },
  {
    id: '013-clerk-webhook-events',
    up: async (client: PoolClient) => {
      const { up: upClerkWebhookEvents } = await import('./013-clerk-webhook-events-postgres');
      await upClerkWebhookEvents(client);
    },
  },
];

export async function runPostgresMigrations(pool: any): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // First ensure the ledger table exists, upgraded with its sequence column
    await ensureLedgerShape(client);

    for (let position = 0; position < POSTGRES_MIGRATIONS.length; position++) {
      const migration = POSTGRES_MIGRATIONS[position];
      const alreadyInLedger = await ledgerContains(client, migration.id);

      if (!alreadyInLedger) {
        await client.query('SAVEPOINT sp_migration');
        try {
          await migration.up(client);
          await recordLedgerEntry(client, migration.id, position);
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT sp_migration');
          throw error;
        }
        continue;
      }

      const stillApplied = await checkSchemaStillApplied(client, migration.id);

      if (!stillApplied) {
        throw new Error(`Migration ${migration.id} recorded in ledger but schema not present - manual intervention required`);
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}