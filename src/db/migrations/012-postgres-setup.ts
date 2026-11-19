import { Pool, PoolClient } from 'pg';

export async function up(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS checks (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS check_results (
        id TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        details TEXT,
        raw_data TEXT,
        executed_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (check_id) REFERENCES checks(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS failure_events (
        id TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        failure_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning',
        title TEXT NOT NULL,
        description TEXT,
        raw_data TEXT,
        detected_at TEXT NOT NULL DEFAULT (datetime('now')),
        acknowledged INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (check_id) REFERENCES checks(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS playbook_entries (
        id TEXT PRIMARY KEY,
        failure_type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_occurrence_at TEXT NOT NULL DEFAULT (datetime('now')),
        occurrence_count INTEGER NOT NULL DEFAULT 1
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        stripe_customer_id TEXT UNIQUE,
        email TEXT NOT NULL,
        name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        clerk_user_id TEXT UNIQUE,
        email TEXT NOT NULL,
        name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        stripe_subscription_id TEXT UNIQUE,
        status TEXT NOT NULL,
        price_id TEXT,
        current_period_start TEXT,
        current_period_end TEXT,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        stripe_invoice_id TEXT UNIQUE,
        status TEXT NOT NULL,
        amount_due INTEGER,
        amount_paid INTEGER,
        amount_remaining INTEGER,
        hosted_invoice_url TEXT,
        invoice_pdf TEXT,
        period_start TEXT,
        period_end TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id),
        UNIQUE(team_id, user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_invitations (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL UNIQUE,
        settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitored_apps (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        platform TEXT NOT NULL,
        check_type TEXT NOT NULL,
        check_target TEXT NOT NULL,
        check_interval_sec INTEGER NOT NULL DEFAULT 60,
        check_timeout_sec INTEGER NOT NULL DEFAULT 30,
        keyword TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        alert_channel_id TEXT,
        owner_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitored_apps_team ON monitored_apps(team_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS health_snapshots (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        latency_ms INTEGER,
        error_type TEXT,
        error_detail TEXT,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (app_id) REFERENCES monitored_apps(id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_health_snapshots_app ON health_snapshots(app_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_health_snapshots_checked_at ON health_snapshots(checked_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_channels (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        owner_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_channels_team ON alert_channels(team_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        failure_types TEXT NOT NULL,
        min_severity TEXT NOT NULL DEFAULT 'warning',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_log (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        rule_id TEXT,
        title TEXT NOT NULL,
        failure_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT,
        FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_rate_limits (
        channel_id TEXT PRIMARY KEY,
        max_per_window INTEGER NOT NULL DEFAULT 10,
        window_seconds INTEGER NOT NULL DEFAULT 3600,
        count INTEGER NOT NULL DEFAULT 0,
        window_start TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_deduplication (
        fingerprint TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS remediation_policies (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        failure_type TEXT NOT NULL,
        action TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS remediation_runs (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        action TEXT NOT NULL,
        config TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (policy_id) REFERENCES remediation_policies(id),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'stripe',
        event_type TEXT NOT NULL,
        livemode INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'processed', 'failed', 'skipped')),
        error TEXT,
        payload TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events(event_type);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events(received_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        event_name TEXT NOT NULL,
        plan TEXT,
        properties TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_team ON analytics_events(team_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_event_id ON analytics_events(event_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_timestamp ON analytics_events(timestamp DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback_responses (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        survey_id TEXT NOT NULL,
        feedback_type TEXT NOT NULL,
        properties TEXT,
        free_text TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS x_tokens (
        id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS x_scheduled_posts (
        id TEXT PRIMARY KEY,
        tweets TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        posted_at TEXT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_playbooks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_playbook_versions (
        id TEXT PRIMARY KEY,
        playbook_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (playbook_id) REFERENCES custom_playbooks(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS playbook_executions (
        id TEXT PRIMARY KEY,
        playbook_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        context TEXT,
        current_node_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (playbook_id) REFERENCES custom_playbooks(id),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_playbook_executions_team ON playbook_executions(team_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS performance_runs (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        config TEXT,
        metrics TEXT,
        regressions TEXT,
        diagnoses TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS metric_history (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_metric_history_team_metric ON metric_history(team_id, metric_name);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS perf_regressions (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        current_value REAL NOT NULL,
        baseline_mean REAL NOT NULL,
        baseline_std REAL NOT NULL,
        p_value REAL NOT NULL,
        severity TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS perf_diagnoses (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        diagnosis TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS onboarding_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        step TEXT NOT NULL DEFAULT 'welcome',
        data TEXT NOT NULL DEFAULT '{}',
        team_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function down(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP TABLE IF EXISTS onboarding_sessions CASCADE');
    await client.query('DROP TABLE IF EXISTS perf_diagnoses CASCADE');
    await client.query('DROP TABLE IF EXISTS perf_regressions CASCADE');
    await client.query('DROP TABLE IF EXISTS metric_history CASCADE');
    await client.query('DROP TABLE IF EXISTS performance_runs CASCADE');
    await client.query('DROP TABLE IF EXISTS playbook_executions CASCADE');
    await client.query('DROP TABLE IF EXISTS custom_playbook_versions CASCADE');
    await client.query('DROP TABLE IF EXISTS custom_playbooks CASCADE');
    await client.query('DROP TABLE IF EXISTS x_scheduled_posts CASCADE');
    await client.query('DROP TABLE IF EXISTS x_tokens CASCADE');
    await client.query('DROP TABLE IF EXISTS feedback_responses CASCADE');
    await client.query('DROP TABLE IF EXISTS analytics_events CASCADE');
    await client.query('DROP TABLE IF EXISTS webhook_events CASCADE');
    await client.query('DROP TABLE IF EXISTS remediation_runs CASCADE');
    await client.query('DROP TABLE IF EXISTS remediation_policies CASCADE');
    await client.query('DROP TABLE IF EXISTS notification_deduplication CASCADE');
    await client.query('DROP TABLE IF EXISTS notification_rate_limits CASCADE');
    await client.query('DROP TABLE IF EXISTS alert_log CASCADE');
    await client.query('DROP TABLE IF EXISTS alert_rules CASCADE');
    await client.query('DROP TABLE IF EXISTS alert_channels CASCADE');
    await client.query('DROP TABLE IF EXISTS health_snapshots CASCADE');
    await client.query('DROP TABLE IF EXISTS monitored_apps CASCADE');
    await client.query('DROP TABLE IF EXISTS workspaces CASCADE');
    await client.query('DROP TABLE IF EXISTS team_invitations CASCADE');
    await client.query('DROP TABLE IF EXISTS team_members CASCADE');
    await client.query('DROP TABLE IF EXISTS teams CASCADE');
    await client.query('DROP TABLE IF EXISTS invoices CASCADE');
    await client.query('DROP TABLE IF EXISTS subscriptions CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    await client.query('DROP TABLE IF EXISTS customers CASCADE');
    await client.query('DROP TABLE IF EXISTS playbook_entries CASCADE');
    await client.query('DROP TABLE IF EXISTS failure_events CASCADE');
    await client.query('DROP TABLE IF EXISTS check_results CASCADE');
    await client.query('DROP TABLE IF EXISTS checks CASCADE');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}