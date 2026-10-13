import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { runtimeMountArgs, validateRuntimeMounts } from "./runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const destination = "/home/session/runtime/agent";
test("runtime mounts accept only bounded literal read-only program selections", () => {
  for (const value of [
    null,
    {},
    [{ source: "relative", destination }],
    [{ source: "/program", destination: "/workspace" }],
    [{ source: "/program", destination: "/home/session/runtime/../agent" }],
    [{ source: "/program", destination, access: "rw" }],
    [{ source: "/program,a", destination }],
    [
      { source: "/program", destination },
      { source: "/other", destination: `${destination}/child` },
    ],
    Array.from({ length: 33 }, () => ({ source: "/program", destination })),
  ])
    expect(() => validateRuntimeMounts(value)).toThrow();
});
test("runtime mounts reject broad directories, credential stores, and sockets", async () => {
  for (const source of [
    "/",
    "/usr",
    "/etc",
    "/tmp",
    homedir(),
    join(homedir(), ".config"),
    join(homedir(), ".pi"),
  ])
    await expect(runtimeMountArgs([{ source, destination }])).rejects.toThrow();
});
test("runtime mounts reject a socket inside selected program files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh-runtime-socket-"));
  roots.push(root);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(root, "socket"), () => resolve());
  });
  try {
    await expect(
      runtimeMountArgs([{ source: root, destination }]),
    ).rejects.toThrow("socket");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("runtime binds preserve internal symlinks and reject external symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh-runtime-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "agent"), "program", { mode: 0o700 });
  await symlink("bin/agent", join(root, "agent"));
  expect(await runtimeMountArgs([{ source: root, destination }])).toEqual([
    "--mount",
    `type=bind,src=${root},dst=${destination},ro,bind-propagation=rprivate,bind-nonrecursive`,
  ]);
  await symlink("/etc/passwd", join(root, "escape"));
  await expect(
    runtimeMountArgs([{ source: root, destination }]),
  ).rejects.toThrow("escapes");
});
