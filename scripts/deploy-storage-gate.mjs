#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_ATTEMPTS = 6;
const DEFAULT_RETRY_INTERVAL_SEC = 20;
const DURABILITY_PROBE_GRACE_SEC = 15;
const DURABILITY_PROBE_POLL_MS = 500;
const FIX_FORWARD = 'Fix forward on nightlamp-api, do not roll back.';

const ROOT_MOUNT_REFUSAL = 'the declared persistent mount path is the root filesystem';
const MISSING_DURABLE_FILE = 'the health surface does not publish the durable-file identity';
const UNDECIDABLE_DURABLE_FILE = 'the durable-file identity could not be decided';
const NOT_A_VERDICT = 'the durable-file identity publishes a value that is not a verdict';
const OFF_MOUNT_DEVICE = 'the deployed database file is not on the declared persistent mount device';

function parseArgs(argv) {
  const args = {
    url: null,
    files: [],
    attempts: DEFAULT_ATTEMPTS,
    retryIntervalSec: DEFAULT_RETRY_INTERVAL_SEC,
    expectedCommit: null,
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
    if (arg === '--expected-commit') {
      args.expectedCommit = argv[i + 1];
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

function isRootMountPath(mountPath) {
  return mountPath.replace(/\/+$/, '') === '';
}

function isPathUnderMount(filePath, mountPath) {
  const prefix = mountPath.endsWith('/') ? mountPath : `${mountPath}/`;
  return filePath === mountPath || filePath.startsWith(prefix);
}

function evaluateHealth(health, expectedCommit = null) {
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

  const pathFactsMissing = typeof storagePath !== 'string' || typeof persistentMountPath !== 'string';
  if (pathFactsMissing) {
    failures.push(
      `the health surface does not publish the storage path facts ` +
      `(storagePath=${JSON.stringify(storagePath)}, persistentMountPath=${JSON.stringify(persistentMountPath)}) - ` +
      `the build that reports the storage state is not deployed. ${FIX_FORWARD}`
    );
  }

  const mountIsRoot = !pathFactsMissing && isRootMountPath(persistentMountPath);
  if (mountIsRoot) {
    failures.push(
      `${ROOT_MOUNT_REFUSAL} (persistentMountPath=${JSON.stringify(persistentMountPath)}) - the root filesystem is ` +
      `not a persistent disk, so the database file cannot survive a deploy. Attach the Render persistent disk and set ` +
      `DB_PATH to a path under it, then redeploy. ${FIX_FORWARD}`
    );
  }

  // The device identity decides whether the file is on the disk. The path prefix
  // is advisory only: a directory the product creates itself satisfies a prefix
  // check, so the verdict comes from the mount point that carries the file's
  // device. An undecided verdict is a failure, never a pass.
  const durableFile = persistence.durableFile;
  if (durableFile === undefined || durableFile === null) {
    failures.push(
      `${MISSING_DURABLE_FILE} (persistence.durableFile=${JSON.stringify(durableFile)}) - the build that reports the ` +
      `mount device is not deployed. ${FIX_FORWARD}`
    );
  } else {
    const verdict = durableFile.onExpectedMountDevice;
    if (verdict === null || verdict === undefined) {
      failures.push(
        `${UNDECIDABLE_DURABLE_FILE} (persistence.durableFile.onExpectedMountDevice=${JSON.stringify(verdict)}, ` +
        `mountInfoReadable=${JSON.stringify(durableFile.mountInfoReadable)}, ` +
        `resolvedMountPoint=${JSON.stringify(durableFile.resolvedMountPoint)}) - the device of the database file ` +
        `could not be resolved, so the durable state is unknown. ${FIX_FORWARD}`
      );
    } else if (typeof verdict !== 'boolean') {
      failures.push(
        `${NOT_A_VERDICT} (persistence.durableFile.onExpectedMountDevice=${JSON.stringify(verdict)}) - ${FIX_FORWARD}`
      );
    } else if (verdict === false) {
      failures.push(
        `${OFF_MOUNT_DEVICE} (persistence.durableFile.onExpectedMountDevice=false, ` +
        `resolvedMountPoint=${JSON.stringify(durableFile.resolvedMountPoint)}, ` +
        `fileDevice=${JSON.stringify(durableFile.fileDevice)}, ` +
        `storagePath=${JSON.stringify(storagePath)}, persistentMountPath=${JSON.stringify(persistentMountPath)}) - ` +
        `attach the Render persistent disk and set DB_PATH to ${String(persistentMountPath)}/nightlamp.db, then ` +
        `redeploy. ${FIX_FORWARD}`
      );
    } else if (!pathFactsMissing && !mountIsRoot && !isPathUnderMount(storagePath, persistentMountPath)) {
      failures.push(
        `the published storage facts disagree - storagePath=${JSON.stringify(storagePath)} is not under ` +
        `persistentMountPath=${JSON.stringify(persistentMountPath)} although /api/health reports the file on the ` +
        `declared mount device. ${FIX_FORWARD}`
      );
    }
  }

  if (expectedCommit) {
    const build = health?.build;
    const commit = build?.commit;
    const source = build?.source;
    if (!build || typeof commit !== 'string' || commit.length === 0 || source === 'unset') {
      failures.push(
        `the deployed build publishes no build identity (health.build=${JSON.stringify(build)}) - the build that reports ` +
        `the serving commit is not deployed, or RENDER_GIT_COMMIT is unset on it. ${FIX_FORWARD}`
      );
    } else if (commit !== expectedCommit) {
      failures.push(
        `the deployed build commit does not match the expected commit (deployed=${commit}, expected=${expectedCommit}) - ` +
        `the commit that is serving is not the commit that was pushed. ${FIX_FORWARD}`
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

async function writeAcknowledgedMarker(origin) {
  const marker = `nl-dur-${randomBytes(16).toString('hex')}@durability.invalid`;
  let status = null;
  let body = null;
  try {
    const response = await fetch(`${origin}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', connection: 'close' },
      body: JSON.stringify({ email: marker, name: 'deploy-storage-gate', source: 'deploy-storage-gate' }),
    });
    status = response.status;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  } catch (err) {
    return {
      marker,
      failures: [
        `the acknowledged write could not be sent (${err.message}) - the durable write path did not answer, so the ` +
        `deploy gate cannot prove that an acknowledged write reaches the file. ${FIX_FORWARD}`
      ],
    };
  }
  if (status !== 200 || body?.success !== true) {
    return {
      marker,
      failures: [
        `the acknowledged write was refused (HTTP ${status}, success=${JSON.stringify(body?.success ?? null)}) - the ` +
        `public lead write path did not acknowledge the durability marker. ${FIX_FORWARD}`
      ],
    };
  }
  return { marker, failures: [] };
}

async function readMarkerBack(origin, marker, boundSec) {
  const deadlineSec = Math.max(boundSec, 1) + DURABILITY_PROBE_GRACE_SEC;
  const deadline = Date.now() + deadlineSec * 1000;
  let lastStatus = null;
  let lastPresent = null;
  let lastSource = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${origin}/api/health/durability-check?marker=${encodeURIComponent(marker)}`,
        { headers: { accept: 'application/json', connection: 'close' } }
      );
      lastStatus = response.status;
      if (response.status === 404) {
        return {
          failures: [
            `the durable-check probe is not published (GET /api/health/durability-check answered HTTP 404) - the build ` +
            `that publishes the file-derived probe is not deployed. ${FIX_FORWARD}`
          ],
        };
      }
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (response.status === 200 && body) {
        lastPresent = body.present;
        lastSource = body.source;
        if (body.present === true) {
          if (body.source === 'file') {
            return { failures: [] };
          }
          return {
            failures: [
              `the durable-check probe did not answer from the file (source=${JSON.stringify(body.source)}) - the probe ` +
              `answered from the in-memory image, so it cannot prove that the durable file holds the acknowledged ` +
              `write. ${FIX_FORWARD}`
            ],
          };
        }
      }
    } catch {
      // A transient probe error is not proof of failure: keep polling until the deadline.
    }
    await sleep(DURABILITY_PROBE_POLL_MS);
  }
  return {
    failures: [
      `the acknowledged write did not reach the durable file within ${deadlineSec}s ` +
      `(last probe status=${JSON.stringify(lastStatus)}, present=${JSON.stringify(lastPresent)}, ` +
      `source=${JSON.stringify(lastSource)}) - an acknowledged write is not durable on the deployed service. ${FIX_FORWARD}`
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.url) {
    const origin = new URL(args.url).origin;
    const health = await fetchHealth(args.url, args.attempts, args.retryIntervalSec);
    const failures = evaluateHealth(health, args.expectedCommit);
    if (failures.length > 0) {
      report(failures);
      return 1;
    }

    const bound = health.persistence.persistIntervalSeconds;
    const write = await writeAcknowledgedMarker(origin);
    if (write.failures.length > 0) {
      report(write.failures);
      return 1;
    }
    const readBack = await readMarkerBack(origin, write.marker, bound);
    if (readBack.failures.length > 0) {
      report(readBack.failures);
      return 1;
    }

    accepted(
      `Backend storage state accepted: sqlite adapter, configured sqlite route, ` +
      `bounded flush bound ${bound}s, database file ${health.storagePath} on the declared mount device ` +
      `${health.persistentMountPath}, and an acknowledged write was read back from the durable file.`
    );
    return 0;
  }

  if (args.files.length === 0) {
    console.error(
      'usage: node scripts/deploy-storage-gate.mjs --url <health-url> [--expected-commit <sha>] | ' +
      '<health.json> [<health2.json>] [--expected-commit <sha>]'
    );
    return 2;
  }

  const first = readHealthFile(args.files[0]);
  const failures = [...evaluateHealth(first, args.expectedCommit)];
  if (args.files[1]) {
    const second = readHealthFile(args.files[1]);
    failures.push(...evaluateHealth(second, args.expectedCommit), ...evaluateAdvance(first, second));
  }
  if (failures.length > 0) {
    report(failures);
    return 1;
  }
  accepted(
    `Backend storage state accepted: sqlite adapter, configured sqlite route, bounded flush bound ` +
    `${first.persistence.persistIntervalSeconds}s, database file ${first.storagePath} on the declared mount device ` +
    `${first.persistentMountPath}. The write-then-read-back probe runs only against a live service, so this run ` +
    `proved the published facts and the flush advance only.`
  );
  return 0;
}

const exitCode = await main();
process.exitCode = exitCode;
