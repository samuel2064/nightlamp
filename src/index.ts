import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as cron from 'node-cron';
import { Database } from 'sql.js';
import * as dotenv from 'dotenv';
import { createDatabase, saveDatabase } from './db';
import { SentryConfig, SentryIssue, UptimeRobotConfig, UptimeRobotMonitor, XConfig, buildAuthorizeUrl, postThread, verifyCredentials, refreshAccessToken, exchangeCodeForToken } from './connectors';
import { runSentryCheck, runUptimeRobotCheck } from './engine';
import { createStripeClient } from './billing';
import { startApiServer } from './api';
import { initEngine, setDb } from './remediation/engine';

process.on('uncaughtException', (err) => {
  console.error('[Nightlamp] UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Nightlamp] UNHANDLED REJECTION:', reason);
});

dotenv.config();

const POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL_SEC || '60', 10);
const DB_PATH = process.env.DB_PATH || './data/nightlamp.db';
const PLAYBOOK_DIR = process.env.PLAYBOOK_DIR || './playbook';
const API_PORT = parseInt(process.env.PORT || process.env.API_PORT || '3001', 10);

let db: Database;
let sentryIssueCache: SentryIssue[] = [];
let uptimeRobotMonitorCache: UptimeRobotMonitor[] = [];

async function init(): Promise<void> {
  console.log('[Nightlamp] Initializing health check engine...');
  db = await createDatabase(DB_PATH);
  setDb(db);
  initEngine();

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
  const baseUrl = process.env.BASE_URL || `http://localhost:${API_PORT}`;

  if (stripeKey) {
    const stripeClient = createStripeClient({
      secretKey: stripeKey,
      priceBasic: process.env.STRIPE_PRICE_BASIC,
      priceAdvanced: process.env.STRIPE_PRICE_ADVANCED,
      priceWhiteGlove: process.env.STRIPE_PRICE_WHITE_GLOVE,
    });

    startApiServer(db, {
      port: API_PORT,
      stripeClient,
      stripeWebhookSecret,
      baseUrl,
    });
    console.log(`[Nightlamp] Billing API configured (port ${API_PORT})`);
  } else {
    startApiServer(db, { port: API_PORT });
    console.log(`[Nightlamp] API server started without billing (port ${API_PORT})`);
    console.log('[Nightlamp] Set STRIPE_SECRET_KEY to enable subscription billing');
  }

  const xClientId = process.env.X_CLIENT_ID;
  const xClientSecret = process.env.X_CLIENT_SECRET;
  const xCallbackUrl = process.env.X_CALLBACK_URL || 'http://localhost:3001/api/x/callback';
  const xPostOnStartup = process.env.X_POST_ON_STARTUP === 'true';

  if (xClientId && xClientSecret) {
    const xConfig: XConfig = { clientId: xClientId, clientSecret: xClientSecret, callbackUrl: xCallbackUrl };

    const tokenResult = db.exec('SELECT access_token, refresh_token FROM x_tokens WHERE id = ?', ['active']);

    if (tokenResult.length > 0 && tokenResult[0].values.length > 0) {
      const accessToken = tokenResult[0].values[0][0] as string;
      const storedRefreshToken = tokenResult[0].values[0][1] as string;

      verifyCredentials(accessToken).then(async (valid) => {
        if (!valid && storedRefreshToken) {
          try {
            const refreshed = await refreshAccessToken(xConfig, storedRefreshToken);
            const expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
            db.run('DELETE FROM x_tokens WHERE id = ?', ['active']);
            db.run(
              `INSERT INTO x_tokens (id, access_token, refresh_token, scope, expires_at) VALUES (?, ?, ?, ?, ?)`,
              ['active', refreshed.accessToken, refreshed.refreshToken, refreshed.scope, expiresAt]
            );
            saveDatabase(db, DB_PATH);
            console.log('[Nightlamp] X/Twitter token refreshed');
          } catch (err: any) {
            console.error(`[Nightlamp] X/Twitter token refresh failed: ${err.message}`);
          }
        }
      });
    }

    if (xPostOnStartup) {
      const threadFile = process.env.X_LAUNCH_THREAD_FILE || './docs/marketing/build-in-public-content.md';
      const fullPath = path.resolve(threadFile);

      if (fs.existsSync(fullPath)) {
        console.log(`[Nightlamp] Loading launch thread from ${fullPath}`);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const tweets: string[] = [];
        let currentTweet = '';

        for (const line of content.split('\n')) {
          const tweetMatch = line.match(/^### Tweet (\d+)/);
          if (tweetMatch) {
            if (currentTweet) tweets.push(currentTweet.trim());
            currentTweet = '';
          } else if (line.trim() && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('`')) {
            if (currentTweet) currentTweet += '\n' + line.trim();
            else currentTweet = line.trim();
          }
        }
        if (currentTweet) tweets.push(currentTweet.trim());

        console.log(`[Nightlamp] Extracted ${tweets.length} tweets for launch thread`);

        const tokenResult = db.exec('SELECT access_token FROM x_tokens WHERE id = ?', ['active']);
        if (tokenResult.length > 0 && tokenResult[0].values.length > 0) {
          const accessToken = tokenResult[0].values[0][0] as string;
          postThread(accessToken, tweets).then((results) => {
            console.log(`[Nightlamp] Launch thread posted: ${results.length} tweets`);
            for (const r of results) {
              const postId = require('uuid').v4();
              db.run(
                `INSERT INTO x_scheduled_posts (id, tweet_text, position, tweet_id, status, posted_at) VALUES (?, ?, ?, ?, 'posted', datetime('now'))`,
                [postId, r.text, results.indexOf(r) + 1, r.tweetId]
              );
            }
            saveDatabase(db, DB_PATH);
          }).catch((err: any) => {
            console.error(`[Nightlamp] Failed to post launch thread: ${err.message}`);
          });
        } else {
          console.log('[Nightlamp] X/Twitter not authenticated. Generate auth URL at /api/x/auth');
        }
      } else {
        console.log(`[Nightlamp] Launch thread file not found: ${fullPath}`);
      }
    }
  } else {
    console.log('[Nightlamp] X/Twitter not configured (set X_CLIENT_ID, X_CLIENT_SECRET)');
  }

  console.log('[Nightlamp] Health check engine running. Press Ctrl+C to stop.');
}

init().catch((err) => {
  console.error('[Nightlamp] Fatal initialization error:', err.message, err.stack);
  console.log('[Nightlamp] Starting fallback health server...');
  http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ status: 'ok', mode: 'fallback', error: err.message }));
  }).listen(API_PORT);
});

process.on('SIGINT', () => {
  console.log('[Nightlamp] Shutting down...');
  if (db) {
    saveDatabase(db, DB_PATH);
  }
  process.exit(0);
});