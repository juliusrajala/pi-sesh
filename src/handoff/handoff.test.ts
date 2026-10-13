import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handoffMountArgs,
  loadHandoffManifest,
  removeStagedResource,
  stageHandoffManifest,
  type StagedResourceRecord,
} from "./handoff";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh handoff "));
  roots.push(root);
  const source = join(root, "selected");
  const stateRoot = join(root, "state");
  await mkdir(source, { mode: 0o700 });
  await mkdir(stateRoot, { mode: 0o700 });
  return { root, source, stateRoot };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function manifest(root: string, resources: unknown[]) {
  const path = join(root, "handoff.json");
  await writeFile(path, JSON.stringify({ version: 1, resources }), {
    mode: 0o600,
  });
  return path;
}

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  id: "settings",
  kind: "snapshot",
  source: "selected/settings.json",
  destination: "/home/session/.config/pi/settings.json",
  access: "ro",
  lifetime: "retained",
  ...overrides,
});

async function stage(path: string, stateRoot: string, sessionId: string) {
  const records: StagedResourceRecord[] = [];
  const resources = await stageHandoffManifest({
    manifestPath: path,
    stateRoot,
    sessionId,
    register: async (record) => {
      records.push(record);
    },
  });
  return { resources, records };
}

test("stages selected generic snapshots and owned outputs with private boundaries", async () => {
  const { root, source, stateRoot } = await fixture();
  await writeFile(join(source, "settings.json"), '{"theme":"synthetic"}\n', {
    mode: 0o644,
  });
  const secret = join(source, "credentials");
  await mkdir(secret, { mode: 0o700 });
  await writeFile(join(secret, "auth.json"), '{"fake":"offline"}\n', {
    mode: 0o600,
  });
  const path = await manifest(root, [
    snapshot(),
    {
      id: "auth",
      kind: "snapshot",
      source: "selected/credentials",
      destination: "/home/session/.config/harness/auth",
      access: "rw",
      lifetime: "secret",
    },
    {
      id: "history",
      kind: "owned-directory",
      destination: "/home/session/.local/share/harness/sessions",
      lifetime: "retained",
    },
  ]);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const { resources, records } = await stage(path, stateRoot, sessionId);
  expect(records).toHaveLength(3);
  expect(resources.map(({ record }) => record.destination)).toEqual([
    "/home/session/.config/pi/settings.json",
    "/home/session/.config/harness/auth",
    "/home/session/.local/share/harness/sessions",
  ]);
  expect(await readFile(resources[0]!.mountPath, "utf8")).toContain(
    "synthetic",
  );
  expect(
    await readFile(join(resources[1]!.mountPath, "auth.json"), "utf8"),
  ).toContain("offline");
  expect(
    await readFile(join(source, "credentials", "auth.json"), "utf8"),
  ).toContain("offline");
  expect((await Bun.file(resources[1]!.mountPath).stat()).mode & 0o077).toBe(0);
  expect(handoffMountArgs({ resources, selinux: true })).toEqual([
    "--volume",
    `${resources[0]!.mountPath}:/home/session/.config/pi/settings.json:ro,Z`,
    "--volume",
    `${resources[1]!.mountPath}:/home/session/.config/harness/auth:rw,Z`,
    "--volume",
    `${resources[2]!.mountPath}:/home/session/.local/share/harness/sessions:rw,Z`,
  ]);

  await writeFile(
    join(resources[1]!.mountPath, "auth.json.tmp"),
    '{"fake":"rotated"}\n',
    { mode: 0o600 },
  );
  await Bun.write(
    join(resources[1]!.mountPath, "auth.json"),
    '{"fake":"rotated"}\n',
  );
  await removeStagedResource({ stateRoot, sessionId, resource: records[1]! });
  await expect(
    readFile(join(resources[1]!.mountPath, "auth.json"), "utf8"),
  ).rejects.toThrow();
  expect(
    await readFile(join(source, "credentials", "auth.json"), "utf8"),
  ).toContain("offline");
  expect(await readFile(resources[0]!.mountPath, "utf8")).toContain(
    "synthetic",
  );
  await removeStagedResource({ stateRoot, sessionId, resource: records[0]! });
  expect((await lstat(resources[2]!.mountPath)).isDirectory()).toBe(true);
});

test("manifest is explicit, bounded, and rejects destination/source escape and overlap", async () => {
  const { root } = await fixture();
  const path = await manifest(root, [
    snapshot({ destination: "/workspace/secret" }),
  ]);
  await expect(loadHandoffManifest(path)).rejects.toThrow(
    "below /home/session",
  );
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      resources: [
        snapshot(),
        snapshot({
          id: "other",
          destination: "/home/session/.config/pi/settings.json/child",
        }),
      ],
    }),
  );
  await expect(loadHandoffManifest(path)).rejects.toThrow(
    "must not duplicate or overlap",
  );
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      resources: [{ ...snapshot(), command: "touch /tmp/no" }],
    }),
  );
  await expect(loadHandoffManifest(path)).rejects.toThrow("unsupported fields");
  await writeFile(path, " ".repeat(1024 * 1024 + 1));
  await expect(loadHandoffManifest(path)).rejects.toThrow("byte limit");
});

test("source symlinks, escaping paths, and public secret sources are rejected", async () => {
  const { root, source, stateRoot } = await fixture();
  const outside = join(root, "outside.json");
  await writeFile(outside, "private?", { mode: 0o600 });
  await symlink(outside, join(source, "alias.json"));
  const sessionId = "22222222-2222-4222-8222-222222222222";
  let path = await manifest(root, [
    snapshot({ source: "selected/alias.json" }),
  ]);
  await expect(stage(path, stateRoot, sessionId)).rejects.toThrow(
    "traverses a symlink",
  );
  path = await manifest(root, [snapshot({ source: "../outside.json" })]);
  await expect(stage(path, stateRoot, sessionId)).rejects.toThrow(
    "escapes the manifest directory",
  );
  await writeFile(join(source, "public.json"), "secret", { mode: 0o644 });
  path = await manifest(root, [
    snapshot({
      source: "selected/public.json",
      access: "rw",
      lifetime: "secret",
    }),
  ]);
  await expect(stage(path, stateRoot, sessionId)).rejects.toThrow(
    "no group/other permissions",
  );
});

test("payload and resource-count bounds fail before any resource is staged", async () => {
  const { root, source, stateRoot } = await fixture();
  const huge = join(source, "huge.bin");
  await writeFile(huge, "");
  await truncate(huge, 64 * 1024 * 1024 + 1);
  const path = await manifest(root, [
    snapshot({ source: "selected/huge.bin" }),
  ]);
  await expect(
    stage(path, stateRoot, "33333333-3333-4333-8333-333333333333"),
  ).rejects.toThrow("payload limit");
  const many = Array.from({ length: 33 }, (_, index) =>
    snapshot({
      id: `entry-${index}`,
      destination: `/home/session/data/${index}`,
    }),
  );
  await writeFile(path, JSON.stringify({ version: 1, resources: many }));
  await expect(loadHandoffManifest(path)).rejects.toThrow("32-resource limit");
});

test("registration interruption removes the unregistered partial resource", async () => {
  const { root, source, stateRoot } = await fixture();
  await writeFile(join(source, "settings.json"), "{}", { mode: 0o600 });
  const path = await manifest(root, [snapshot()]);
  const sessionId = "55555555-5555-4555-8555-555555555555";
  await expect(
    stageHandoffManifest({
      manifestPath: path,
      stateRoot,
      sessionId,
      register: async () => {
        throw new Error("synthetic metadata interruption");
      },
    }),
  ).rejects.toThrow("Unable to stage handoff resource settings");
  await expect(
    lstat(join(stateRoot, "resources", sessionId)),
  ).rejects.toThrow();
});

test("cleanup refuses a replaced resource owner identity", async () => {
  const { root, source, stateRoot } = await fixture();
  await writeFile(join(source, "settings.json"), "{}", { mode: 0o600 });
  const path = await manifest(root, [snapshot()]);
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const { resources, records } = await stage(path, stateRoot, sessionId);
  const itemPath = join(stateRoot, "resources", sessionId, records[0]!.id);
  await rm(itemPath, { recursive: true });
  await mkdir(itemPath, { mode: 0o700 });
  await expect(
    removeStagedResource({ stateRoot, sessionId, resource: records[0]! }),
  ).rejects.toThrow("replaced or foreign");
  expect(await Bun.file(resources[0]!.mountPath).exists()).toBe(false);
});
