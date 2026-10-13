import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { PiSeshError } from "../errors";

const MANIFEST_LIMIT = 1024 * 1024;
const ENTRY_LIMIT = 32;
const FILE_LIMIT = 10_000;
const BYTE_LIMIT = 64 * 1024 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OWNER_FILE = "pi-sesh-owner.json";

type SnapshotResource = {
  id: string;
  kind: "snapshot";
  source: string;
  destination: string;
  access: "ro" | "rw";
  lifetime: "retained" | "secret";
};
type OwnedDirectoryResource = {
  id: string;
  destination: string;
  kind: "owned-directory";
  lifetime: "retained";
};
export type HandoffResource = SnapshotResource | OwnedDirectoryResource;
export interface HandoffManifest {
  version: 1;
  resources: HandoffResource[];
}
export interface StagedResourceRecord {
  id: string;
  destination: string;
  kind: "snapshot" | "owned-directory";
  access: "ro" | "rw";
  lifetime: "retained" | "secret";
  stageToken: string;
  stageDevice: number;
  stageInode: number;
}
export interface StagedResource {
  record: StagedResourceRecord;
  mountPath: string;
}

type SourceItem = {
  relativePath: string;
  kind: "file" | "directory";
  device: number;
  inode: number;
  size: number;
  mode: number;
};
type PreparedResource = {
  resource: HandoffResource;
  sourcePath?: string;
  sourceItems: SourceItem[];
};

type OwnerRecord = {
  version: 1;
  sessionId: string;
  resourceId: string;
  token: string;
  device: number;
  inode: number;
  destination: string;
  kind: StagedResourceRecord["kind"];
  access: StagedResourceRecord["access"];
  lifetime: StagedResourceRecord["lifetime"];
};

function fail(message: string, cause?: unknown): never {
  throw new PiSeshError(
    "HANDOFF",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function currentUid(): number {
  const value = process.getuid?.();
  if (value === undefined)
    fail("Host UID is unavailable; resource staging requires Linux");
  return value;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function validateDestination(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/home/session/") ||
    value === "/home/session/" ||
    value.includes("\\") ||
    value.includes("\0") ||
    posix.normalize(value) !== value ||
    value
      .split("/")
      .slice(1)
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("Handoff destination must be a canonical path below /home/session/");
  }
  return value;
}

function validateManifestValue(value: unknown): HandoffManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("Handoff manifest must be a JSON object");
  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).some(
      (key) => key !== "version" && key !== "resources",
    )
  )
    fail("Handoff manifest contains unsupported fields");
  if (manifest.version !== 1 || !Array.isArray(manifest.resources))
    fail("Handoff manifest requires version 1 and a resources array");
  if (manifest.resources.length > ENTRY_LIMIT)
    fail(`Handoff manifest exceeds the ${ENTRY_LIMIT}-resource limit`);

  const ids = new Set<string>();
  const targets: string[] = [];
  const resources: HandoffResource[] = manifest.resources.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      fail("Handoff resource entries must be JSON objects");
    const item = raw as Record<string, unknown>;
    const allowed =
      item.kind === "owned-directory"
        ? ["id", "destination", "kind", "lifetime"]
        : ["id", "destination", "kind", "source", "access", "lifetime"];
    if (Object.keys(item).some((key) => !allowed.includes(key)))
      fail("Handoff resource contains unsupported fields");
    if (
      typeof item.id !== "string" ||
      !RESOURCE_ID.test(item.id) ||
      ids.has(item.id)
    )
      fail("Handoff resource IDs must be unique simple names");
    ids.add(item.id);
    const destination = validateDestination(item.destination);
    if (
      targets.some(
        (target) =>
          target === destination ||
          target.startsWith(`${destination}/`) ||
          destination.startsWith(`${target}/`),
      )
    )
      fail("Handoff destinations must not duplicate or overlap");
    targets.push(destination);

    if (item.kind === "owned-directory") {
      if (item.lifetime !== "retained" || "source" in item || "access" in item)
        fail("Owned directories must be retained, initially empty resources");
      return {
        id: item.id,
        destination,
        kind: "owned-directory",
        lifetime: "retained",
      };
    }
    if (item.kind !== "snapshot")
      fail("Handoff resource kind must be snapshot or owned-directory");
    if (
      typeof item.source !== "string" ||
      item.source.length === 0 ||
      isAbsolute(item.source) ||
      item.source.includes("\0")
    )
      fail(
        "Snapshot source must be a non-empty relative path from the handoff manifest",
      );
    if (item.access !== "ro" && item.access !== "rw")
      fail("Snapshot access must be ro or rw");
    if (item.lifetime !== "retained" && item.lifetime !== "secret")
      fail("Snapshot lifetime must be retained or secret");
    if (item.lifetime === "secret" && item.access !== "rw")
      fail("Secret snapshots must be writable");
    return {
      id: item.id,
      kind: "snapshot",
      source: item.source,
      destination,
      access: item.access,
      lifetime: item.lifetime,
    };
  });
  return { version: 1, resources };
}

export async function loadHandoffManifest(
  path: string,
): Promise<{ manifest: HandoffManifest; directory: string }> {
  const absolute = resolve(path);
  let before;
  try {
    before = await lstat(absolute);
  } catch (cause) {
    fail("Unable to read the explicitly selected handoff manifest", cause);
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.uid !== currentUid()
  )
    fail("Handoff manifest must be a regular file owned by the invoking user");
  if (before.size > MANIFEST_LIMIT)
    fail(`Handoff manifest exceeds the ${MANIFEST_LIMIT}-byte limit`);
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== currentUid() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MANIFEST_LIMIT
    )
      fail("Handoff manifest changed or is unsafe");
    const bytes = Buffer.alloc(MANIFEST_LIMIT + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MANIFEST_LIMIT)
      fail(`Handoff manifest exceeds the ${MANIFEST_LIMIT}-byte limit`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch (cause) {
      fail("Handoff manifest is invalid JSON", cause);
    }
    return {
      manifest: validateManifestValue(parsed),
      directory: await realpath(join(absolute, "..")),
    };
  } catch (cause) {
    if (cause instanceof PiSeshError) throw cause;
    return fail("Unable to safely load the handoff manifest", cause);
  } finally {
    await handle?.close();
  }
}

async function scanSource(
  sourcePath: string,
  secret: boolean,
): Promise<SourceItem[]> {
  const items: SourceItem[] = [];
  const root = await lstat(sourcePath).catch((cause) =>
    fail("Handoff source does not exist or cannot be inspected", cause),
  );
  if (root.isSymbolicLink() || (!root.isFile() && !root.isDirectory()))
    fail(
      "Handoff sources must be regular files or directories without symlinks",
    );
  if (root.uid !== currentUid())
    fail("Handoff source entries must be owned by the invoking user");

  async function visit(path: string, relativePath: string, info: Stats) {
    if (
      info.isSymbolicLink() ||
      (!info.isFile() && !info.isDirectory()) ||
      info.uid !== currentUid()
    )
      fail("Handoff source contains a symlink, special file, or unowned entry");
    if (secret && (info.mode & 0o077) !== 0)
      fail(
        "Secret snapshot source entries must have no group/other permissions",
      );
    if (info.isFile() && info.size > BYTE_LIMIT)
      fail(`Handoff source exceeds the ${BYTE_LIMIT}-byte payload limit`);
    items.push({
      relativePath,
      kind: info.isFile() ? "file" : "directory",
      device: info.dev,
      inode: info.ino,
      size: info.isFile() ? info.size : 0,
      mode: info.mode & 0o777,
    });
    if (info.isDirectory()) {
      const children = await readdir(path);
      for (const child of children.sort()) {
        const childPath = join(path, child);
        const childInfo = await lstat(childPath);
        await visit(
          childPath,
          relativePath ? join(relativePath, child) : child,
          childInfo,
        );
      }
    }
  }
  await visit(sourcePath, "", root);
  return items;
}

async function prepareManifestSources(
  manifest: HandoffManifest,
  directory: string,
): Promise<PreparedResource[]> {
  const canonicalDirectory = await realpath(directory);
  const prepared: PreparedResource[] = [];
  let files = 0;
  let entries = 0;
  let bytes = 0;
  for (const resource of manifest.resources) {
    if (resource.kind === "owned-directory") {
      prepared.push({ resource, sourceItems: [] });
      continue;
    }
    const candidate = resolve(canonicalDirectory, resource.source);
    if (!within(canonicalDirectory, candidate))
      fail(`Handoff source for ${resource.id} escapes the manifest directory`);
    const pathParts = relative(canonicalDirectory, candidate)
      .split(sep)
      .filter(Boolean);
    let checkedPath = canonicalDirectory;
    for (const part of pathParts) {
      checkedPath = join(checkedPath, part);
      const info = await lstat(checkedPath).catch((cause) =>
        fail(`Handoff source for ${resource.id} is missing or unsafe`, cause),
      );
      if (info.isSymbolicLink())
        fail(`Handoff source for ${resource.id} traverses a symlink`);
    }
    const sourcePath = await realpath(candidate).catch((cause) =>
      fail(`Handoff source for ${resource.id} is missing or unsafe`, cause),
    );
    if (!within(canonicalDirectory, sourcePath))
      fail(
        `Handoff source for ${resource.id} resolves outside the manifest directory`,
      );
    const sourceItems = await scanSource(
      sourcePath,
      resource.lifetime === "secret",
    );
    files += sourceItems.filter((item) => item.kind === "file").length;
    entries += sourceItems.length;
    bytes += sourceItems.reduce((total, item) => total + item.size, 0);
    if (files > FILE_LIMIT)
      fail(`Handoff exceeds the ${FILE_LIMIT}-file limit`);
    if (entries > FILE_LIMIT * 2)
      fail(`Handoff exceeds the ${FILE_LIMIT * 2}-entry safety limit`);
    if (bytes > BYTE_LIMIT)
      fail(`Handoff exceeds the ${BYTE_LIMIT}-byte payload limit`);
    prepared.push({ resource, sourcePath, sourceItems });
  }
  return prepared;
}

function resourceBase(stateRoot: string, sessionId: string): string {
  return join(stateRoot, "resources", sessionId);
}

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== currentUid())
    fail("Handoff staging directory has unexpected type or owner");
  await chmod(path, 0o700);
}

async function copyFile(
  item: SourceItem,
  source: string,
  destination: string,
  secret: boolean,
) {
  let input;
  try {
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    fail("Unable to safely open a handoff source file", cause);
  }
  try {
    const info = await input.stat();
    if (
      !info.isFile() ||
      info.uid !== currentUid() ||
      info.dev !== item.device ||
      info.ino !== item.inode ||
      info.size !== item.size ||
      (secret && (info.mode & 0o077) !== 0)
    )
      fail("Handoff source changed while it was being staged");
    const mode = secret ? 0o600 : (item.mode & 0o111) | 0o600;
    const output = await open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < item.size) {
        const { bytesRead } = await input.read(
          buffer,
          0,
          Math.min(buffer.length, item.size - position),
          position,
        );
        if (bytesRead === 0)
          fail("Handoff source changed while it was being copied");
        await output.write(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const extra = Buffer.alloc(1);
      const { bytesRead } = await input.read(extra, 0, 1, position);
      if (bytesRead !== 0)
        fail("Handoff source grew beyond its validated size");
      await output.sync();
      await output.chmod(mode);
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function copySnapshot(
  prepared: PreparedResource,
  payloadPath: string,
): Promise<void> {
  const resource = prepared.resource as SnapshotResource;
  const items = prepared.sourceItems;
  const root = items[0]!;
  const expectedChildren = new Map<string, string[]>();
  for (const item of items.slice(1)) {
    const parent = dirname(item.relativePath);
    const children = expectedChildren.get(parent) ?? [];
    children.push(
      item.relativePath.slice(item.relativePath.lastIndexOf(sep) + 1),
    );
    expectedChildren.set(parent, children);
  }
  for (const children of expectedChildren.values()) children.sort();
  if (root.kind === "directory") {
    await mkdir(payloadPath, { mode: 0o700 });
    for (const item of items) {
      if (item.kind !== "directory") continue;
      const sourceDirectory = join(prepared.sourcePath!, item.relativePath);
      const info = await lstat(sourceDirectory);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        info.uid !== currentUid() ||
        info.dev !== item.device ||
        info.ino !== item.inode
      )
        fail("Handoff source directory changed while it was being staged");
      const expected = expectedChildren.get(item.relativePath || ".") ?? [];
      const actualChildren = (await readdir(sourceDirectory)).sort();
      if (JSON.stringify(actualChildren) !== JSON.stringify(expected))
        fail("Handoff source directory changed while it was being staged");
      if (item.relativePath) {
        const destination = join(payloadPath, item.relativePath);
        await mkdir(destination, { mode: 0o700 });
      }
    }
    for (const item of items.slice(1)) {
      if (item.kind === "directory") continue;
      const destination = join(payloadPath, item.relativePath);
      await copyFile(
        item,
        join(prepared.sourcePath!, item.relativePath),
        destination,
        resource.lifetime === "secret",
      );
    }
  } else {
    await copyFile(
      root,
      prepared.sourcePath!,
      payloadPath,
      resource.lifetime === "secret",
    );
  }
}

function ownerPath(itemPath: string): string {
  return join(itemPath, OWNER_FILE);
}

function validateSessionId(sessionId: string): void {
  if (!UUID.test(sessionId)) fail("Session ID is invalid for handoff staging");
}

export async function stageHandoffManifest(options: {
  manifestPath: string;
  stateRoot: string;
  sessionId: string;
  register: (resource: StagedResourceRecord) => Promise<void>;
}): Promise<StagedResource[]> {
  validateSessionId(options.sessionId);
  const { manifest, directory } = await loadHandoffManifest(
    options.manifestPath,
  );
  const prepared = await prepareManifestSources(manifest, directory);
  return stagePreparedResources({
    prepared,
    stateRoot: options.stateRoot,
    sessionId: options.sessionId,
    register: options.register,
  });
}

async function stagePreparedResources(options: {
  prepared: PreparedResource[];
  stateRoot: string;
  sessionId: string;
  register: (resource: StagedResourceRecord) => Promise<void>;
}): Promise<StagedResource[]> {
  validateSessionId(options.sessionId);
  if (options.prepared.length === 0) return [];
  const stateRoot = await realpath(resolve(options.stateRoot)).catch((cause) =>
    fail("Session state directory is unavailable for handoff staging", cause),
  );
  const resourcesRoot = join(stateRoot, "resources");
  const sessionRoot = resourceBase(stateRoot, options.sessionId);
  await privateDir(resourcesRoot);
  await privateDir(sessionRoot);
  const staged: StagedResource[] = [];
  try {
    for (const prepared of options.prepared) {
      const resource = prepared.resource;
      const itemPath = join(sessionRoot, resource.id);
      const payloadPath = join(itemPath, "payload");
      await mkdir(itemPath, { mode: 0o700 });
      const identity = await lstat(itemPath);
      const kind =
        resource.kind === "owned-directory" ? "owned-directory" : "snapshot";
      const access =
        resource.kind === "owned-directory" ? "rw" : resource.access;
      const record: StagedResourceRecord = {
        id: resource.id,
        destination: resource.destination,
        kind,
        access,
        lifetime: resource.lifetime,
        stageToken: randomUUID(),
        stageDevice: identity.dev,
        stageInode: identity.ino,
      };
      const owner: OwnerRecord = {
        version: 1,
        sessionId: options.sessionId,
        resourceId: record.id,
        token: record.stageToken,
        device: record.stageDevice,
        inode: record.stageInode,
        destination: record.destination,
        kind: record.kind,
        access: record.access,
        lifetime: record.lifetime,
      };
      let registered = false;
      try {
        await writeFile(ownerPath(itemPath), `${JSON.stringify(owner)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await options.register(record);
        registered = true;
        if (resource.kind === "owned-directory")
          await mkdir(payloadPath, { mode: 0o700 });
        else await copySnapshot(prepared, payloadPath);
        if (resource.kind === "owned-directory")
          await chmod(payloadPath, 0o700);
        staged.push({ record, mountPath: payloadPath });
      } catch (cause) {
        if (!registered)
          await rm(itemPath, { recursive: true, force: true }).catch(() => {});
        if (cause instanceof PiSeshError) throw cause;
        fail(`Unable to stage handoff resource ${resource.id}`, cause);
      }
    }
  } catch (cause) {
    if ((await readdir(sessionRoot)).length === 0) {
      await rmdir(sessionRoot).catch(() => {});
      if ((await readdir(resourcesRoot)).length === 0)
        await rmdir(resourcesRoot).catch(() => {});
    }
    throw cause;
  }
  return staged;
}

export async function removeStagedResource(options: {
  stateRoot: string;
  sessionId: string;
  resource: StagedResourceRecord;
}): Promise<void> {
  validateSessionId(options.sessionId);
  const resource = options.resource;
  if (
    !RESOURCE_ID.test(resource.id) ||
    !UUID.test(resource.stageToken) ||
    !Number.isInteger(resource.stageDevice) ||
    !Number.isInteger(resource.stageInode)
  )
    fail("Handoff resource ownership metadata is invalid");
  const stateRoot = await realpath(resolve(options.stateRoot)).catch((cause) =>
    fail("Session state directory is missing", cause),
  );
  const resourcesRoot = join(stateRoot, "resources");
  const sessionRoot = join(resourcesRoot, options.sessionId);
  const itemPath = join(sessionRoot, resource.id);
  const resourcesInfo = await lstat(resourcesRoot).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("Unable to inspect handoff resource root", cause);
  });
  if (!resourcesInfo) return;
  if (
    resourcesInfo.isSymbolicLink() ||
    !resourcesInfo.isDirectory() ||
    resourcesInfo.uid !== currentUid() ||
    (resourcesInfo.mode & 0o077) !== 0
  )
    fail("Handoff resource root is unsafe");
  const sessionInfoBefore = await lstat(sessionRoot).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("Unable to inspect handoff session root", cause);
  });
  if (!sessionInfoBefore) return;
  if (
    sessionInfoBefore.isSymbolicLink() ||
    !sessionInfoBefore.isDirectory() ||
    sessionInfoBefore.uid !== currentUid() ||
    (sessionInfoBefore.mode & 0o077) !== 0
  )
    fail("Handoff session root is unsafe");
  const itemInfo = await lstat(itemPath).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("Unable to inspect staged handoff ownership", cause);
  });
  if (!itemInfo) return;
  if (
    itemInfo.isSymbolicLink() ||
    !itemInfo.isDirectory() ||
    itemInfo.uid !== currentUid() ||
    (itemInfo.mode & 0o077) !== 0 ||
    itemInfo.dev !== resource.stageDevice ||
    itemInfo.ino !== resource.stageInode
  )
    fail("Refusing to remove a replaced or foreign handoff resource");
  const ownerInfo = await lstat(ownerPath(itemPath)).catch((cause) =>
    fail("Handoff ownership record is missing", cause),
  );
  if (
    ownerInfo.isSymbolicLink() ||
    !ownerInfo.isFile() ||
    ownerInfo.uid !== currentUid() ||
    (ownerInfo.mode & 0o077) !== 0
  )
    fail("Handoff ownership record is unsafe");
  let owner: OwnerRecord;
  let ownerHandle;
  try {
    ownerHandle = await open(
      ownerPath(itemPath),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = await ownerHandle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== currentUid() ||
      opened.dev !== ownerInfo.dev ||
      opened.ino !== ownerInfo.ino ||
      (opened.mode & 0o077) !== 0
    )
      fail("Handoff ownership record changed during cleanup");
    owner = JSON.parse(await ownerHandle.readFile("utf8")) as OwnerRecord;
  } catch (cause) {
    if (cause instanceof PiSeshError) throw cause;
    return fail("Handoff ownership record is invalid", cause);
  } finally {
    await ownerHandle?.close();
  }
  if (
    owner.version !== 1 ||
    owner.sessionId !== options.sessionId ||
    owner.resourceId !== resource.id ||
    owner.token !== resource.stageToken ||
    owner.device !== itemInfo.dev ||
    owner.inode !== itemInfo.ino ||
    owner.destination !== resource.destination ||
    owner.kind !== resource.kind ||
    owner.access !== resource.access ||
    owner.lifetime !== resource.lifetime
  )
    fail("Handoff ownership record does not match the session metadata");
  await rm(itemPath, { recursive: true, force: false });
  const sessionInfo = await lstat(sessionRoot);
  if (
    sessionInfo.isSymbolicLink() ||
    !sessionInfo.isDirectory() ||
    sessionInfo.uid !== currentUid()
  )
    fail("Handoff session directory changed during cleanup");
  if ((await readdir(sessionRoot)).length === 0) await rmdir(sessionRoot);
  const rootInfo = await lstat(resourcesRoot);
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    rootInfo.uid !== currentUid()
  )
    fail("Handoff resource root changed during cleanup");
  if ((await readdir(resourcesRoot)).length === 0) await rmdir(resourcesRoot);
}

export function stagedResourcePath(
  stateRoot: string,
  sessionId: string,
  resourceId: string,
): string {
  validateSessionId(sessionId);
  if (!RESOURCE_ID.test(resourceId)) fail("Handoff resource ID is invalid");
  return join(
    resourceBase(resolve(stateRoot), sessionId),
    resourceId,
    "payload",
  );
}

export function handoffMountArgs(options: {
  resources: StagedResource[];
  selinux: boolean;
}): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const { record, mountPath } of options.resources) {
    if (seen.has(record.destination))
      fail("Duplicate handoff mount destination");
    seen.add(record.destination);
    if (
      mountPath.includes(":") ||
      mountPath.includes(",") ||
      record.destination.includes(":") ||
      record.destination.includes(",")
    )
      fail(
        "Handoff paths containing ':' or ',' are unsupported by Podman volume syntax",
      );
    args.push(
      "--volume",
      `${mountPath}:${record.destination}:${record.access === "ro" ? "ro" : "rw"}${options.selinux ? ",Z" : ""}`,
    );
  }
  return args;
}
