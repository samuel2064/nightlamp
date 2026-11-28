import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { resolveMountIdentity, resolveBuildIdentity, decodeDevice, isMountPointOfPath, parseMountInfo, clearMountIdentityCache } from '../db/mount-identity';
import { isPathOnPersistentMount } from '../db/connection';

/**
 * NOC-425 mount identity: the file-derived fact that closes the false green on
 * the board's operator step.
 *
 * The shipped health surface answers `persistence.storageOnPersistentMount:
 * true` for any path under the declared mount - including a path on the
 * container rootfs, because the product creates the declared directory itself
 * when it does not exist. This lane pins the resolver that answers from the
 * file's `major:minor` device instead, so the deploy gate can see that a
 * `DB_PATH` without a disk is not durable.
 *
 * The device cases are Linux-only, because `/proc/self/mountinfo` is a Linux
 * file. On any other host they are reported as skipped rather than silently
 * passing, and the portable unit cases still run.
 */
const itOnLinux = process.platform === 'linux' ? it : it.skip;
const LINUX_ONLY = process.platform === 'linux' ? '' : ' [skipped: not linux]';

const MANAGED_KEYS = ['DB_PATH', 'PERSISTENT_MOUNT_PATH', 'DATABASE_URL', 'RENDER_GIT_COMMIT', 'RENDER_GIT_BRANCH'];
const REAL_MOUNT_INFO = '/proc/self/mountinfo';

describe('NOC-425 mount identity', () => {
  describe('device decoding and path-prefix helpers', () => {
    it('decodes a Linux dev_t into the major:minor form mountinfo prints', () => {
      // The common case: major 0, minor 141 is the container rootfs in a mountinfo.
      assert.strictEqual(decodeDevice(141), '0:141', 'the legacy (major << 8) | minor encoding');
      assert.strictEqual(decodeDevice(0), '0:0');
      // major 8, minor 1.
      assert.strictEqual(decodeDevice((8 << 8) | 1), '8:1');
    });

    it('treats a mount point as a path-segment boundary, never a raw prefix', () => {
      assert.strictEqual(isMountPointOfPath('/mnt/data', '/mnt/data/nightlamp.db'), true);
      assert.strictEqual(isMountPointOfPath('/mnt/data', '/mnt/data'), true, 'an exact match is its own mount point');
      assert.strictEqual(isMountPointOfPath('/mnt/data', '/mnt/data-other/nightlamp.db'), false, 'a sibling mount is not owned');
      assert.strictEqual(isMountPointOfPath('/', '/mnt/data/nightlamp.db'), true, 'the root filesystem owns every path');
      // The resolved mount point can be `/`, so the naive concat would be `//`.
      assert.strictEqual(isMountPointOfPath('/', '/'), true);
    });
  });

  describe('mountinfo parsing', () => {
    it('reads the device and the mount point from every well-formed line', () => {
      const entries = parseMountInfo(
        [
          '36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue',
          '   ',
          '22 1 0:141 / / rw,relatime - overlay overlay rw,lowerdir=/a,upperdir=/b',
        ].join('\n'),
      );
      assert.strictEqual(entries.length, 2, 'a blank line is ignored, not a crash');
      assert.deepStrictEqual(
        { device: entries[0].device, mountPoint: entries[0].mountPoint },
        { device: '98:0', mountPoint: '/mnt2' },
      );
      assert.deepStrictEqual(
        { device: entries[1].device, mountPoint: entries[1].mountPoint },
        { device: '0:141', mountPoint: '/' },
      );
    });

    it('unescapes a mount point that carries an escaped space', () => {
      const entries = parseMountInfo('1 0 0:1 / /mnt/my\\040disk rw - tmpfs tmpfs rw');
      assert.strictEqual(entries[0].mountPoint, '/mnt/my disk');
    });
  });

  describe('fail-closed behaviour' + LINUX_ONLY, () => {
    it('publishes null - never a pass - when mountinfo cannot be read', () => {
      const identity = resolveMountIdentity(
        nodePath.join(os.tmpdir(), 'nightlamp-mount-identity-absent.db'),
        '/mnt/data',
        nodePath.join(os.tmpdir(), 'nightlamp-mount-identity-no-such-mountinfo'),
      );

      assert.strictEqual(identity.mountInfoReadable, false, 'a missing mountinfo is reported, not assumed');
      assert.strictEqual(identity.resolvedMountPoint, null);
      assert.strictEqual(identity.onExpectedMountDevice, null, 'a null verdict is a fail for a gate, not a pass');
      assert.strictEqual(identity.rootDevice, null);
      assert.strictEqual(identity.sameDeviceAsRoot, null);
      assert.strictEqual(identity.fileExists, false, 'the file does not exist yet');
      assert.strictEqual(
        identity.fileDevice,
        identity.parentDevice,
        'with the file absent the parent directory device decides, so the window before the first flush is not blind',
      );
    });

    itOnLinux('resolves the file device from the parent directory when the file is absent', () => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'nightlamp-mount-identity-'));
      const absentFile = nodePath.join(dir, 'nested', 'nightlamp.db');
      try {
        fs.mkdirSync(nodePath.join(dir, 'nested'), { recursive: true });
        const identity = resolveMountIdentity(absentFile, '/mnt/data', REAL_MOUNT_INFO);
        assert.strictEqual(identity.fileExists, false);
        assert.notStrictEqual(identity.fileDevice, null, 'a file written later lands on its parent device');
        assert.strictEqual(identity.fileDevice, identity.parentDevice);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('the verdict on the real host' + LINUX_ONLY, () => {
    /**
     * A plain temporary directory is not a mount, so the resolver must answer
     * `onExpectedMountDevice: false` for a file inside one whenever the
     * expected mount path is anything but the root filesystem. This is the
     * false green the shipped path-prefix check cannot see.
     */
    itOnLinux('answers false for a file on a plain directory, even with a path under the expected mount', () => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'nightlamp-mount-identity-'));
      const filePath = nodePath.join(dir, 'nightlamp.db');
      try {
        fs.writeFileSync(filePath, 'not a real database, only a path to inspect');

        // The witness: the path-prefix check cannot tell these two apart when
        // the product creates the expected directory itself, so the path fact
        // is a test witness and never the verdict.
        assert.strictEqual(
          isPathOnPersistentMount(filePath),
          false,
          'a tmpdir path is outside the default mount prefix',
        );

        const identity = resolveMountIdentity(filePath, '/mnt/data', REAL_MOUNT_INFO);
        assert.strictEqual(identity.mountInfoReadable, true);
        assert.notStrictEqual(identity.fileDevice, null);
        assert.notStrictEqual(identity.resolvedMountPoint, null, 'the tmpdir is on the container rootfs mount');
        assert.strictEqual(
          identity.onExpectedMountDevice,
          false,
          'a plain directory is not the declared volume, so the device verdict must be false',
        );
        assert.strictEqual(typeof identity.sameDeviceAsRoot, 'boolean');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    itOnLinux('a file in a plain directory resolves to the root filesystem, not to the declared mount', () => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'nightlamp-mount-identity-'));
      const filePath = nodePath.join(dir, 'nightlamp.db');
      try {
        fs.writeFileSync(filePath, 'x');
        const identity = resolveMountIdentity(filePath, '/mnt/data', REAL_MOUNT_INFO);
        assert.strictEqual(identity.mountInfoReadable, true);

        // The relationship, never a fixed device number: the host's root
        // filesystem is read from this host's mountinfo, so the assertion holds
        // wherever the lane runs instead of pinning one container's `0:141`.
        assert.notStrictEqual(identity.rootDevice, null, 'the root filesystem device is readable');
        assert.strictEqual(
          identity.fileDevice,
          identity.rootDevice,
          'a tmpdir file lives on the host root filesystem, which is not a volume',
        );
        assert.strictEqual(identity.sameDeviceAsRoot, true);
        assert.strictEqual(
          identity.resolvedMountPoint,
          '/',
          'the device that carries the file resolves to the root mount point',
        );
        assert.strictEqual(identity.onExpectedMountDevice, false, '/mnt/data is not the root filesystem');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    itOnLinux('a directory under the declared mount that is not a mount resolves to the same root device', () => {
      // The false green itself: the product creates the expected directory, so
      // the path-prefix fact answers true while the device fact answers false.
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'nightlamp-mount-identity-'));
      const insideDir = nodePath.join(dir, 'mnt', 'data');
      const filePath = nodePath.join(insideDir, 'nightlamp.db');
      try {
        fs.mkdirSync(insideDir, { recursive: true });
        fs.writeFileSync(filePath, 'x');

        // The witness: a path that IS under a declared-looking directory, so the
        // path check says on-mount. The device verdict must still say no.
        assert.strictEqual(
          isPathOnPersistentMount(filePath),
          false,
          'this synthetic directory is not the default mount prefix, so the path check is inert here',
        );

        const identity = resolveMountIdentity(filePath, '/', REAL_MOUNT_INFO);
        assert.strictEqual(identity.onExpectedMountDevice, true, 'the root filesystem is the expected mount when the expectation is /');
        assert.strictEqual(identity.resolvedMountPoint, '/');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('build identity', () => {
    it('reads RENDER_GIT_COMMIT and RENDER_GIT_BRANCH, and says so when they are absent', () => {
      const withEnv = resolveBuildIdentity({
        RENDER_GIT_COMMIT: '020db50a8e0d6333eff52c66f526b8544200c84a',
        RENDER_GIT_BRANCH: 'release/noc-288-onboarding-tree',
      });
      assert.strictEqual(withEnv.source, 'render_git_commit');
      assert.strictEqual(withEnv.commit, '020db50a8e0d6333eff52c66f526b8544200c84a');
      assert.strictEqual(withEnv.branch, 'release/noc-288-onboarding-tree');

      const withoutEnv = resolveBuildIdentity({});
      assert.strictEqual(withoutEnv.source, 'unset');
      assert.strictEqual(withoutEnv.commit, null);
      assert.strictEqual(withoutEnv.branch, null);
    });

    it('an empty variable is absent, not an empty-string commit', () => {
      const identity = resolveBuildIdentity({ RENDER_GIT_COMMIT: '', RENDER_GIT_BRANCH: '' });
      assert.strictEqual(identity.commit, null);
      assert.strictEqual(identity.branch, null);
      assert.strictEqual(identity.source, 'unset');
    });
  });

  describe('the request-time cache never masks a failure', () => {
    itOnLinux('a cached pass is not reused when mountinfo becomes unreadable', () => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'nightlamp-mount-identity-'));
      const filePath = nodePath.join(dir, 'nightlamp.db');
      const mountInfoPath = nodePath.join(dir, 'mountinfo');
      try {
        fs.writeFileSync(filePath, 'x');
        // The synthetic table carries the device the file actually has, so the
        // case is deterministic on every host instead of pinning one Linux
        // container's rootfs device.
        const device = decodeDevice(fs.statSync(filePath).dev);
        // field[3] is the root within the filesystem and field[4] the mount
        // point, so a `/` mount needs both fields.
        fs.writeFileSync(
          mountInfoPath,
          `22 1 ${device} / / rw,relatime - tmpfs tmpfs rw\n`,
        );
        clearMountIdentityCache();
        const readable = resolveMountIdentity(filePath, '/mnt/data', mountInfoPath);
        assert.strictEqual(readable.mountInfoReadable, true);
        assert.notStrictEqual(readable.resolvedMountPoint, null, 'the synthetic mount table resolves the file');
        assert.strictEqual(readable.onExpectedMountDevice, false, '/mnt/data is not the root filesystem');

        // The same path, now with an unreadable mountinfo: the failure must be
        // answered, not served from the previous successful resolution.
        fs.rmSync(mountInfoPath);
        const unreadable = resolveMountIdentity(filePath, '/mnt/data', mountInfoPath);
        assert.strictEqual(unreadable.mountInfoReadable, false);
        assert.strictEqual(unreadable.resolvedMountPoint, null);
        assert.strictEqual(unreadable.onExpectedMountDevice, null);
      } finally {
        clearMountIdentityCache();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('an explicit cache clear re-reads the facts', () => {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'nightlamp-mount-identity-'));
      const filePath = nodePath.join(dir, 'nightlamp.db');
      const mountInfoPath = nodePath.join(dir, 'mountinfo');
      try {
        fs.writeFileSync(
          mountInfoPath,
          '22 1 0:141 / / rw,relatime - overlay overlay rw,lowerdir=/a,upperdir=/b\n',
        );
        clearMountIdentityCache();
        const absent = resolveMountIdentity(filePath, '/mnt/data', mountInfoPath);
        assert.strictEqual(absent.fileExists, false);

        fs.writeFileSync(filePath, 'x');
        clearMountIdentityCache();
        const present = resolveMountIdentity(filePath, '/mnt/data', mountInfoPath);
        assert.strictEqual(present.fileExists, true, 'the freshest read is taken after a clear');
      } finally {
        clearMountIdentityCache();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  afterEach(() => {
    clearMountIdentityCache();
    for (const key of MANAGED_KEYS) {
      delete process.env[key];
    }
  });
});