import * as http from 'http';

process.on('uncaughtException', (err) => {
  console.error('[Nightlamp] UNCAUGHT EXCEPTION:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Nightlamp] UNHANDLED REJECTION:', reason);
});

async function main(): Promise<void> {
  try {
    console.log('[Nightlamp] Node version:', process.version);
    console.log('[Nightlamp] CWD:', process.cwd());
    console.log('[Nightlamp] Env:', JSON.stringify({ NODE_ENV: process.env.NODE_ENV, API_PORT: process.env.API_PORT }));

    const { Database } = await import('sql.js');
    const { default: dotenv } = await import('dotenv');
    const { createDatabase, saveDatabase } = await import('./db');
    const { createStripeClient } = await import('./billing');
    const { startApiServer } = await import('./api');

    dotenv.config();

    const DB_PATH = process.env.DB_PATH || './data/nightlamp.db';
    const PLAYBOOK_DIR = process.env.PLAYBOOK_DIR || './playbook';

    console.log('[Nightlamp] Initializing health check engine...');
    const db = await createDatabase(DB_PATH);
    console.log('[Nightlamp] Database created');

    const apiPort = parseInt(process.env.API_PORT || '3001', 10);
    startApiServer(db, { port: apiPort });
    console.log('[Nightlamp] API server started on port', apiPort);
    console.log('[Nightlamp] Health check engine running. Press Ctrl+C to stop.');
  } catch (err: any) {
    console.error('[Nightlamp] Fatal startup error:', err.message, err.stack);
    console.log('[Nightlamp] Starting fallback health server...');
    http.createServer((q, r) => {
      r.writeHead(200, { 'Content-Type': 'application/json' });
      r.end(JSON.stringify({ status: 'ok', mode: 'fallback', error: err.message }));
    }).listen(parseInt(process.env.API_PORT || '10000'));
  }
}

main();

const POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL_SEC || '60', 10);
const DB_PATH = process.env.DB_PATH || './data/nightlamp.db';
const PLAYBOOK_DIR = process.env.PLAYBOOK_DIR || './playbook';

let db: Database;
let sentryIssueCache: SentryIssue[] = [];
let uptimeRobotMonitorCache: UptimeRobotMonitor[] = [];

async function init(): Promise<void> {
  console.log('[Nightlamp] Initializing health check engine...');
  db = await createDatabase(DB_PATH);

  const sentryToken = process.env.SENTRY_AUTH_TOKEN;
  const sentryOrg = process.env.SENTRY_ORG_SLUG;
  const sentryProject = process.env.SENTRY_PROJECT_SLUG;

  if (sentryToken && sentryOrg && sentryProject) {
    const sentryConfig: SentryConfig = {
      authToken: sentryToken,
      orgSlug: sentryOrg,
      projectSlug: sentryProject,
    };

    const cronExpr = `*/${POLL_INTERVAL_SEC} * * * * *`;
    cron.schedule(cronExpr, async () => {
      console.log(`[Nightlamp] Running Sentry check (every ${POLL_INTERVAL_SEC}s)...`);
      try {
        const result = await runSentryCheck(db, sentryConfig, sentryIssueCache, PLAYBOOK_DIR);

        sentryIssueCache = result.issues;

        console.log(`[Nightlamp] Sentry check complete: ${result.status} - ${result.summary}`);
        if (result.failureEvents > 0) {
          console.log(`[Nightlamp] ${result.failureEvents} failure(s) detected, playbook: ${result.playbookEntries.join(', ')}`);
        }

        saveDatabase(db, DB_PATH);
      } catch (err: any) {
        console.error(`[Nightlamp] Sentry check failed: ${err.message}`);
      }
    });

    console.log(`[Nightlamp] Sentry monitor scheduled: every ${POLL_INTERVAL_SEC}s`);
  } else {
    console.log('[Nightlamp] Sentry not configured (set SENTRY_AUTH_TOKEN, SENTRY_ORG_SLUG, SENTRY_PROJECT_SLUG)');
  }

  const uptimeRobotKey = process.env.UPTIMEROBOT_API_KEY;

  if (uptimeRobotKey) {
    const uptimeRobotConfig: UptimeRobotConfig = {
      apiKey: uptimeRobotKey,
    };

    const cronExpr = `*/${POLL_INTERVAL_SEC} * * * * *`;
    cron.schedule(cronExpr, async () => {
      console.log(`[Nightlamp] Running UptimeRobot check (every ${POLL_INTERVAL_SEC}s)...`);
      try {
        const result = await runUptimeRobotCheck(db, uptimeRobotConfig, uptimeRobotMonitorCache, PLAYBOOK_DIR);

        uptimeRobotMonitorCache = result.monitors;

        console.log(`[Nightlamp] UptimeRobot check complete: ${result.status} - ${result.summary}`);
        if (result.failureEvents > 0) {
          console.log(`[Nightlamp] ${result.failureEvents} failure(s) detected, playbook: ${result.playbookEntries.join(', ')}`);
        }

        saveDatabase(db, DB_PATH);
      } catch (err: any) {
        console.error(`[Nightlamp] UptimeRobot check failed: ${err.message}`);
      }
    });

    console.log(`[Nightlamp] UptimeRobot monitor scheduled: every ${POLL_INTERVAL_SEC}s`);
  } else {
    console.log('[Nightlamp] UptimeRobot not configured (set UPTIMEROBOT_API_KEY)');
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const apiPort = parseInt(process.env.API_PORT || '3001', 10);
  const baseUrl = process.env.BASE_URL || `http://localhost:${apiPort}`;

  if (stripeKey) {
    const stripeClient = createStripeClient({
      secretKey: stripeKey,
      priceBasic: process.env.STRIPE_PRICE_BASIC,
      priceAdvanced: process.env.STRIPE_PRICE_ADVANCED,
      priceWhiteGlove: process.env.STRIPE_PRICE_WHITE_GLOVE,
    });

    startApiServer(db, {
      port: apiPort,
      stripeClient,
      stripeWebhookSecret,
      baseUrl,
    });

    console.log(`[Nightlamp] Billing API configured (port ${apiPort})`);
  } else {
    startApiServer(db, { port: apiPort });
    console.log(`[Nightlamp] API server started without billing (port ${apiPort})`);
    console.log('[Nightlamp] Set STRIPE_SECRET_KEY to enable subscription billing');
  }

  console.log('[Nightlamp] Health check engine running. Press Ctrl+C to stop.');
}

init().catch((err) => {
  console.error('[Nightlamp] Fatal initialization error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('[Nightlamp] Shutting down...');
  if (db) {
    saveDatabase(db, DB_PATH);
  }
  process.exit(0);
});