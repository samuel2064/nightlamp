import * as fs from 'fs';
import * as nodePath from 'path';

/**
 * Identity of the file the durable sql.js image is written to (NOC-425).
 *
 * The product's existing on-mount check, `isPathOnPersistentMount`, is a
 * **path-prefix** comparison: it answers `true` for `/mnt/data/nightlamp.db`
 * whenever `/mnt/data` is the declared mount - but the product creates that
 * directory itself when it does not exist, so a container rootfs directory and
 * a real Render volume answer identically. That is a false green on the board's
 * own operator step: "the operator set `DB_PATH` but attached no disk" must not
 * be a passing deploy gate.
 *
 * The device identity closes it. On Linux `st_dev` decodes to `major:minor` and
 * `/proc/self/mountinfo` maps a `major:minor` to the mount point that carries
 * it, so the resolved mount point of the file's path is a measurement of where
 * the bytes actually land. Device identity alone is ambiguous when two mounts
 * share one device, so the verdict requires **both** facts: the resolved mount
 * point that carries the file's device, and that the file's path is a path
 * prefix of that mount point.
 *
 * Every fact fails closed. An unreadable `/proc/self/mountinfo` publishes
 * `mountInfoReadable: false`, `resolvedMountPoint: null` and
 * `onExpectedMountDevice: null` - a gate must read that `null` as a fail, never
 * as a pass.
 */
export interface MountIdentity {
  /** The file exists right now (`fs.statSync` succeeded on it). */
  fileExists: boolean;
  /** `major:minor` of the file, or of its parent directory when the file is absent. `null` when stat failed. */
  fileDevice: string | null;
  /** `major:minor` of the file's parent directory. `null` when stat failed. */
  parentDevice: string | null;
  /** `major:minor` of the root filesystem, read from mountinfo. `null` when mountinfo is unreadable. */
  rootDevice: string | null;
  /**
   * The longest mount point that is a path prefix of the file's path **and**
   * carries the file's `major:minor`. `null` when mountinfo is unreadable or no
   * mount carries the device.
   */
  resolvedMountPoint: string | null;
  /**
   * True only when the resolved mount point is the expected mount path. This is
   * the publishable verdict: it is false for a file on the container rootfs
   * under a declared-but-absent volume, and `null` - never `false`-as-pass -
   * when mountinfo could not be read.
   */
  onExpectedMountDevice: boolean | null;
  /** Whether `/proc/self/mountinfo` was read and parsed. */
  mountInfoReadable: boolean;
  /**
   * Whether the file's device is the root filesystem's device. `null` when
   * mountinfo is unreadable. A `true` here with `onExpectedMountDevice === true`
   * means the expected mount path is the root filesystem, not a volume.
   */
  sameDeviceAsRoot: boolean | null;
}

export interface BuildIdentity {
  /** `RENDER_GIT_COMMIT` - the commit Render deployed, an automatic runtime variable. */
  commit: string | null;
  /** `RENDER_GIT_BRANCH` - the branch Render deployed, an automatic runtime variable. */
  branch: string | null;
  /** Where the identity was read from, so a gate can tell a real fact from an absent one. */
  source: 'render_git_commit' | 'unset';
}

const DEFAULT_MOUNT_INFO_PATH = '/proc/self/mountinfo';

/**
 * Decodes a Linux `dev_t` into the `major:minor` form mountinfo prints.
 *
 * The glibc encoding for a 64-bit `dev_t` splits the value across the two
 * fields, and the common case (major < 4096, minor < 256) is the legacy
 * `(major << 8) | minor` form. Both are supported, so a raw stat value maps to
 * the same string mountinfo carries regardless of which encoding the host
 * kernel used.
 */
export function decodeDevice(dev: number): string {
  const major = ((dev >> 32) & 0xfffff000) | ((dev >> 8) & 0x00000fff);
  const minor = ((dev >> 12) & 0xffffff00) | (dev & 0x000000ff);
  return `${major}:${minor}`;
}

/**
 * Reports whether `candidate` is the mount point that owns `filePath`: an exact
 * match, or a path-segment boundary match. A resolved mount point can be `/`
 * itself, so the separator is appended rather than concatenated blindly, and a
 * sibling mount such as `/mnt/data-other` is not a prefix of `/mnt/data`.
 */
export function isMountPointOfPath(mountPoint: string, filePath: string): boolean {
  const prefix = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
  return filePath === mountPoint || filePath.startsWith(prefix);
}

interface MountInfoEntry {
  device: string;
  mountPoint: string;
}

/**
 * Parses `/proc/self/mountinfo`. Each line carries the device as the third
 * space-separated field and the mount point as the fifth; everything between
 * the mount point and the ` - ` separator is optional and variable-width.
 * Mount points may carry octal escapes for space, tab, newline and backslash.
 *
 * The parse is memoized on the raw text: `/api/health` resolves the identity on
 * every request, and the same unchanged mountinfo parses to the same entries.
 * The memo is keyed by the text itself, so a changed mount table re-parses
 * rather than serving a stale table, and an unreadable file never reaches it.
 */
let mountInfoMemo: { text: string; entries: MountInfoEntry[] } | null = null;

export function parseMountInfo(text: string): MountInfoEntry[] {
  if (mountInfoMemo && mountInfoMemo.text === text) {
    return mountInfoMemo.entries;
  }
  const entries: MountInfoEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fields = line.split(' ');
    if (fields.length < 5) continue;
    const device = fields[2];
    if (!/^\d+:\d+$/.test(device)) continue;
    entries.push({ device, mountPoint: unescapeMountPoint(fields[4]) });
  }
  mountInfoMemo = { text, entries };
  return entries;
}

function unescapeMountPoint(raw: string): string {
  if (!raw.includes('\\')) return raw;
  return raw.replace(/\\(\d{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

/**
 * Strips trailing separators so an expected mount path of `/mnt/data/` and one
 * of `/mnt/data` are the same mount. The root filesystem stays `/`.
 */
function normalizeMountPath(mountPath: string): string {
  const trimmed = mountPath.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Lifetime of a resolved identity, in milliseconds.
 *
 * `/api/health` resolves the identity on every request, and the underlying
 * facts change only when the mount table changes or the database file first
 * appears - neither of which happens while a process serves. A one-second
 * window keeps the deploy gate's samples a second apart from seeing a stale
 * verdict while making the steady-state health probe nearly free.
 *
 * **The cache never masks a failure.** `/proc/self/mountinfo` is re-read and
 * re-parsed on every call, and a cached entry is reused only when the mount
 * table it was resolved against is byte-for-byte the table that is readable
 * right now - so a mountinfo that becomes unreadable answers
 * `mountInfoReadable: false` immediately instead of serving a stale pass.
 */
const MOUNT_IDENTITY_TTL_MS = 1000;

const identityCache = new Map<string, { at: number; mountText: string; identity: MountIdentity }>();

/** Drops every cached identity. Exported for a caller that must read fresh facts. */
export function clearMountIdentityCache(): void {
  identityCache.clear();
}

function cachedIdentity(key: string, mountText: string): MountIdentity | null {
  const hit = identityCache.get(key);
  if (!hit) return null;
  if (hit.mountText !== mountText) {
    identityCache.delete(key);
    return null;
  }
  if (Date.now() - hit.at >= MOUNT_IDENTITY_TTL_MS) {
    identityCache.delete(key);
    return null;
  }
  return hit.identity;
}

function storeIdentity(key: string, mountText: string, identity: MountIdentity): MountIdentity {
  // One live path per process in production; the cap only guards a caller that
  // resolves many distinct paths, which the tests do.
  if (identityCache.size > 64) identityCache.clear();
  identityCache.set(key, { at: Date.now(), mountText, identity });
  return identity;
}

/**
 * The two `stat` calls a resolution ever makes: the file and its parent
 * directory. With the file absent the parent's device stands in for the file's,
 * because a file written later lands on its parent's device - so the window
 * before the first flush is not a blind window.
 */
function readFileIdentity(
  resolvedFilePath: string,
  parentDir: string,
): { fileExists: boolean; fileDevice: string | null; parentDevice: string | null } {
  let fileExists = false;
  let fileDevice: string | null = null;
  try {
    // The stat must succeed before the existence flag is set, so a failed stat
    // cannot report a file that is not there as existing.
    fileDevice = decodeDevice(fs.statSync(resolvedFilePath).dev);
    fileExists = true;
  } catch {
    // The file is absent: a file written later lands on its parent's device, so
    // the window before the first flush is not a blind window.
  }
  let parentDevice: string | null = null;
  try {
    parentDevice = decodeDevice(fs.statSync(parentDir).dev);
  } catch {
    parentDevice = null;
  }
  if (!fileExists && fileDevice === null) {
    fileDevice = parentDevice;
  }
  return { fileExists, fileDevice, parentDevice };
}

/**
 * Resolves the mount identity of the file the durability layer writes.
 *
 * The file need not exist: with the file absent the **parent directory's**
 * device decides, because a file written later lands on its parent's device, so
 * the window before the first flush is not a blind window.
 *
 * Two `stat` calls at most - the file and its parent directory - because the
 * published facts are one `fileDevice`, one `parentDevice` and one existence.
 */
export function resolveMountIdentity(
  filePath: string,
  expectedMountPath: string,
  mountInfoPath: string = DEFAULT_MOUNT_INFO_PATH,
): MountIdentity {
  const resolvedFilePath = nodePath.resolve(filePath);
  const parentDir = nodePath.dirname(resolvedFilePath);
  const expected = normalizeMountPath(expectedMountPath);
  const cacheKey = `${resolvedFilePath}|${expected}|${mountInfoPath}`;

  // The mount table is always re-read: a cached verdict must never stand in for
  // a mountinfo that is no longer readable.
  let mountText: string;
  try {
    mountText = fs.readFileSync(mountInfoPath, 'utf8');
  } catch {
    // Fail closed: no mountinfo means no resolved mount point and no verdict.
    // The stat-derived facts are still published, because they cost nothing
    // extra here and they tell an operator why the file is not on a mount.
    const failed = readFileIdentity(resolvedFilePath, parentDir);
    return {
      fileExists: failed.fileExists,
      fileDevice: failed.fileDevice,
      parentDevice: failed.parentDevice,
      rootDevice: null,
      resolvedMountPoint: null,
      onExpectedMountDevice: null,
      mountInfoReadable: false,
      sameDeviceAsRoot: null,
    };
  }
  const cached = cachedIdentity(cacheKey, mountText);
  if (cached) {
    return cached;
  }
  const entries = parseMountInfo(mountText);
  const { fileExists, fileDevice, parentDevice } = readFileIdentity(resolvedFilePath, parentDir);

  const rootEntry = entries.find((entry) => entry.mountPoint === '/');
  const rootDevice = rootEntry ? rootEntry.device : null;

  let resolvedMountPoint: string | null = null;
  if (fileDevice !== null) {
    // Longest path prefix wins, so a nested volume inside another one resolves
    // to the innermost mount point that actually carries this device.
    const candidates = entries
      .filter((entry) => entry.device === fileDevice && isMountPointOfPath(entry.mountPoint, resolvedFilePath))
      .sort((a, b) => b.mountPoint.length - a.mountPoint.length);
    if (candidates.length > 0) {
      resolvedMountPoint = candidates[0].mountPoint;
    }
  }

  const onExpectedMountDevice =
    resolvedMountPoint === null
      ? null
      : normalizeMountPath(resolvedMountPoint) === expected && isMountPointOfPath(expected, resolvedFilePath);

  return storeIdentity(cacheKey, mountText, {
    fileExists,
    fileDevice,
    parentDevice,
    rootDevice,
    resolvedMountPoint,
    onExpectedMountDevice,
    mountInfoReadable: true,
    sameDeviceAsRoot: rootDevice === null ? null : fileDevice === rootDevice,
  });
}

/**
 * Reads the build identity Render already publishes. `RENDER_GIT_COMMIT` and
 * `RENDER_GIT_BRANCH` are automatic runtime variables on a Render service, so a
 * product-side build identity needs no Render setting change, no credential and
 * no board step.
 */
export function resolveBuildIdentity(
  env: NodeJS.ProcessEnv = process.env,
): BuildIdentity {
  const commit = env.RENDER_GIT_COMMIT;
  const branch = env.RENDER_GIT_BRANCH;
  return {
    commit: commit && commit.length > 0 ? commit : null,
    branch: branch && branch.length > 0 ? branch : null,
    source: commit && commit.length > 0 ? 'render_git_commit' : 'unset',
  };
}
