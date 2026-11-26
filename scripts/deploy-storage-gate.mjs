#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_ATTEMPTS = 6;
const DEFAULT_RETRY_INTERVAL_SEC = 20;
const MAX_WAIT_AFTER_PERSIST_SEC = 30;
const FIX_FORWARD = 'Fix forward on nightlamp-api, do not roll back.';

function parseArgs(argv) {
  const args = {
    url: null,
    files: [],
    attempts: DEFAULT_ATTEMPTS,
    retryIntervalSec: DEFAULT_RETRY_INTERVAL_SEC,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') {
      args.url = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--attempts') {
      args.attempts = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--retry-interval-sec') {
      args.retryIntervalSec = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    args.files.push(arg);
  }
  return args;
}

function readHealthFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function fetchHealth(url, attempts, retryIntervalSec) {
  let lastError = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json', connection: 'close' } });
      const text = await response.text();
      if (response.status !== 200) {
        lastError = `HTTP ${response.status}`;
        console.log(`Attempt ${attempt}: ${url} answered ${lastError}`);
      } else {
        try {
          return JSON.parse(text);
        } catch (err) {
          lastError = `the response was not JSON (${err.message})`;
          console.log(`Attempt ${attempt}: ${lastError}`);
        }
      }
    } catch (err) {
      lastError = err.message;
      console.log(`Attempt ${attempt}: ${url} failed (${lastError})`);
    }
    if (attempt < attempts) {
      await sleep(retryIntervalSec * 1000);
    }
  }
  throw new Error(`the backend health endpoint did not answer a readable JSON body: ${lastError}`);
}

function evaluateHealth(health) {
  const failures = [];
  const storageMode = health?.storageMode;
  const configuredStorageMode = health?.configuredStorageMode;
  const storagePath = health?.storagePath;
  const persistentMountPath = health?.persistentMountPath;
  const persistence = health?.persistence ?? {};

  if (storageMode !== 'sqlite') {
    failures.push(
      `the deployed backend is serving the ${String(storageMode)} adapter (storageMode=${String(storageMode)}) ` +
      `while the release requires the SQLite route. ${FIX_FORWARD}`
    );
  }

  if (configuredStorageMode !== 'sqlite') {
    failures.push(
      `the deployed backend is configured for the ${String(configuredStorageMode)} route ` +
      `(configuredStorageMode=${String(configuredStorageMode)}) while the sqlite adapter serves the requests - ` +
      `DATABASE_URL must stay unset on nightlamp-api, because with it set the boot flush overwrites the durable file. ` +
      `Unset DATABASE_URL and redeploy. ${FIX_FORWARD}`
    );
  }

  const bound = persistence.persistIntervalSeconds;
  if (typeof bound !== 'number' || !Number.isInteger(bound) || bound < 1) {
    failures.push(
      `/api/health does not publish a persistence bound (persistence.persistIntervalSeconds=${JSON.stringify(bound)}) - ` +
      `the bounded-flush build is not deployed and an older build is serving. ${FIX_FORWARD}`
    );
  }

  if (typeof persistence.lastPersistedAt !== 'string' || persistence.lastPersistedAt.length === 0) {
    failures.push(
      `/api/health does not publish persistence.lastPersistedAt - the bounded flush has never reported a successful write. ` +
      `${FIX_FORWARD}`
    );
  }

  if (typeof storagePath !== 'string' || typeof persistentMountPath !== 'string' || persistentMountPath.length === 0) {
    failures.push(
      `the health surface does not publish the storage path facts ` +
      `(storagePath=${JSON.stringify(storagePath)}, persistentMountPath=${JSON.stringify(persistentMountPath)}) - ` +
      `the build that reports the storage state is not deployed. ${FIX_FORWARD}`
    );
  }

  if (persistence.storageOnPersistentMount !== true) {
    failures.push(
      `the deployed database file is not on the declared persistent mount ` +
      `(persistence.storageOnPersistentMount=${JSON.stringify(persistence.storageOnPersistentMount)}, ` +
      `storagePath=${JSON.stringify(storagePath)}, persistentMountPath=${JSON.stringify(persistentMountPath)}) - ` +
      `attach the Render persistent disk and set DB_PATH to ${String(persistentMountPath)}/nightlamp.db, then redeploy. ` +
      `${FIX_FORWARD}`
    );
  }

  if (persistence.storageOnPersistentMount === true && typeof storagePath === 'string' && typeof persistentMountPath === 'string' && persistentMountPath.length > 0) {
    const onMount = storagePath === persistentMountPath || storagePath.startsWith(`${persistentMountPath}/`);
    if (!onMount) {
      failures.push(
        `the published storage facts disagree - storagePath=${JSON.stringify(storagePath)} is not under ` +
        `persistentMountPath=${JSON.stringify(persistentMountPath)} although /api/health reports ` +
        `storageOnPersistentMount=true. ${FIX_FORWARD}`
      );
    }
  }

  return failures;
}

function evaluateAdvance(first, second) {
  const firstAt = first?.persistence?.lastPersistedAt;
  const secondAt = second?.persistence?.lastPersistedAt;
  if (typeof firstAt !== 'string' || typeof secondAt !== 'string') {
    return [];
  }
  const firstMs = Date.parse(firstAt);
  const secondMs = Date.parse(secondAt);
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) {
    return [
      `the bounded flush timestamps are not readable ` +
      `(persistence.lastPersistedAt=${firstAt} -> ${secondAt}). ${FIX_FORWARD}`
    ];
  }
  if (secondMs <= firstMs) {
    return [
      `the bounded flush is not advancing (persistence.lastPersistedAt=${firstAt} -> ${secondAt}) - ` +
      `acknowledged writes are not reaching the file. ${FIX_FORWARD}`
    ];
  }
  return [];
}

function report(failures) {
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  console.error(
    `::error::the deployed backend storage state is not the durable state the release requires ` +
    `(${failures.length} failed check(s)). ${FIX_FORWARD}`
  );
}

function accepted(message) {
  console.log(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.url) {
    const first = await fetchHealth(args.url, args.attempts, args.retryIntervalSec);
    const firstFailures = evaluateHealth(first);
    if (firstFailures.length > 0) {
      report(firstFailures);
      return 1;
    }
    const bound = first.persistence.persistIntervalSeconds;
    const waitSec = Math.min(Math.max(bound, 1), MAX_WAIT_AFTER_PERSIST_SEC) + 2;
    accepted(
      `Backend storage state accepted: sqlite adapter, configured sqlite route, ` +
      `bounded flush bound ${bound}s, database file ${first.storagePath} on the declared mount ` +
      `${first.persistentMountPath}. Waiting ${waitSec}s for the bounded flush to advance.`
    );
    await sleep(waitSec * 1000);
    const second = await fetchHealth(args.url, args.attempts, args.retryIntervalSec);
    const failures = [...evaluateHealth(second), ...evaluateAdvance(first, second)];
    if (failures.length > 0) {
      report(failures);
      return 1;
    }
    accepted(
      `Backend storage state accepted: the bounded flush advanced from ` +
      `${first.persistence.lastPersistedAt} to ${second.persistence.lastPersistedAt}.`
    );
    return 0;
  }

  if (args.files.length === 0) {
    console.error(
      'usage: node scripts/deploy-storage-gate.mjs --url <health-url> | <health.json> [<health2.json>]'
    );
    return 2;
  }

  const first = readHealthFile(args.files[0]);
  const failures = [...evaluateHealth(first)];
  if (args.files[1]) {
    const second = readHealthFile(args.files[1]);
    failures.push(...evaluateHealth(second), ...evaluateAdvance(first, second));
  }
  if (failures.length > 0) {
    report(failures);
    return 1;
  }
  accepted(
    `Backend storage state accepted: sqlite adapter, configured sqlite route, bounded flush bound ` +
    `${first.persistence.persistIntervalSeconds}s, database file ${first.storagePath} on the declared mount ` +
    `${first.persistentMountPath}.`
  );
  return 0;
}

const exitCode = await main();
process.exitCode = exitCode;
