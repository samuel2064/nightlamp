import assert from 'assert';
import { Server } from 'http';
import { createDatabase } from '../db/schema';
import { isPathOnPersistentMount } from '../db';
import { startApiServer } from '../api/server';

/**
 * NOC-425: the deploy storage gate reads the public /api/health response, so
 * the health surface must publish the deployed storage state - the configured
 * mode, the sqlite path, the declared persistent mount and the product's own
 * on-mount decision. Each case boots a real server on an ephemeral port with
 * the environment set before the database and the server exist, probes the
 * public endpoint, and restores the environment afterwards.
 */
describe('NOC-425 health storage state', () => {
  const MANAGED_KEYS = ['DB_PATH', 'PERSISTENT_MOUNT_PATH', 'DATABASE_URL'];

  async function probeHealthWithEnv(env: Record<string, string | undefined>): Promise<any> {
    const original: Record<string, string | undefined> = {};
    for (const key of MANAGED_KEYS) {
      original[key] = process.env[key];
    }
    for (const key of Object.keys(env)) {
      const value = env[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    let db: any;
    let server: Server | undefined;
    try {
      // The environment is set before the database and the server exist, so
      // the published facts are the ones this process booted with.
      db = await createDatabase(env.DB_PATH);
      server = startApiServer(db, { port: 0 });
      if (!server.listening) {
        await new Promise<void>((resolve) => server!.once('listening', resolve));
      }
      const port = (server.address() as any).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.strictEqual(response.status, 200, 'the health endpoint must stay public');
      return (await response.json()) as any;
    } finally {
      if (server) server.close();
      if (db) db.close();
      for (const key of MANAGED_KEYS) {
        const value = original[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  it('publishes the on-mount storage state when DB_PATH is under the persistent mount', async () => {
    const health = await probeHealthWithEnv({
      DB_PATH: '/mnt/data/nightlamp.db',
      PERSISTENT_MOUNT_PATH: '/mnt/data',
      DATABASE_URL: undefined,
    });

    assert.strictEqual(health.storageMode, 'sqlite', 'the sql.js adapter serves the requests');
    assert.strictEqual(health.configuredStorageMode, 'sqlite', 'the environment configures the sqlite route');
    assert.strictEqual(health.storagePath, '/mnt/data/nightlamp.db');
    assert.strictEqual(health.persistentMountPath, '/mnt/data');
    assert.strictEqual(health.persistence.storageOnPersistentMount, true);
    assert.strictEqual(health.persistence.persistIntervalSeconds, null, 'the in-process probe wires no persistence controller');
    assert.ok(typeof health.bootId === 'string' && health.bootId.length > 0);
  });

  it('publishes the actual path and reports off-mount when DB_PATH is outside the mount', async () => {
    const health = await probeHealthWithEnv({
      DB_PATH: '/var/lib/nightlamp/nightlamp.db',
      PERSISTENT_MOUNT_PATH: '/mnt/data',
      DATABASE_URL: undefined,
    });

    assert.strictEqual(health.storageMode, 'sqlite');
    assert.strictEqual(health.configuredStorageMode, 'sqlite');
    assert.strictEqual(health.storagePath, '/var/lib/nightlamp/nightlamp.db', 'the published path is the actual path');
    assert.strictEqual(health.persistentMountPath, '/mnt/data');
    assert.strictEqual(
      health.persistence.storageOnPersistentMount,
      false,
      'a path outside the declared mount is not on the mount',
    );
  });

  it('publishes configuredStorageMode postgres while the sqlite adapter serves', async () => {
    // A URL where nothing listens: boot never selects the Postgres adapter on
    // this tree, so the health surface must not claim postgres.
    const health = await probeHealthWithEnv({
      DB_PATH: '/mnt/data/nightlamp.db',
      PERSISTENT_MOUNT_PATH: '/mnt/data',
      DATABASE_URL: 'postgresql://nightlamp:nightlamp@127.0.0.1:1/nightlamp',
    });

    assert.strictEqual(
      health.storageMode,
      'sqlite',
      'the adapter actually serving the requests is sqlite',
    );
    assert.strictEqual(
      health.configuredStorageMode,
      'postgres',
      'the configured mode must reveal DATABASE_URL even while the sqlite adapter serves',
    );
    assert.strictEqual(health.storagePath, '/mnt/data/nightlamp.db');
  });

  it('treats the mount boundary as a path segment, not a raw prefix', async () => {
    const health = await probeHealthWithEnv({
      DB_PATH: '/mnt/data-other/nightlamp.db',
      PERSISTENT_MOUNT_PATH: '/mnt/data',
      DATABASE_URL: undefined,
    });

    assert.strictEqual(health.persistentMountPath, '/mnt/data');
    assert.strictEqual(
      health.persistence.storageOnPersistentMount,
      false,
      '/mnt/data-other/nightlamp.db is a sibling mount, not a path under /mnt/data',
    );

    const originalMount = process.env.PERSISTENT_MOUNT_PATH;
    delete process.env.PERSISTENT_MOUNT_PATH;
    try {
      assert.strictEqual(
        isPathOnPersistentMount('/mnt/data-other/nightlamp.db'),
        false,
        'the default mount /mnt/data does not own the /mnt/data-other prefix',
      );
      assert.strictEqual(
        isPathOnPersistentMount('/mnt/data/nightlamp.db'),
        true,
        'the default mount /mnt/data owns its own file',
      );
    } finally {
      if (originalMount === undefined) {
        delete process.env.PERSISTENT_MOUNT_PATH;
      } else {
        process.env.PERSISTENT_MOUNT_PATH = originalMount;
      }
    }
  });
});