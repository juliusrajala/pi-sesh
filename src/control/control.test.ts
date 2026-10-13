import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSesh } from "./index";
import { writablePathBytes } from "./usage";

test("control options reject unsafe limits before any Podman access", () => {
  expect(() => createPiSesh({ maxWritableBytes: 0 })).toThrow(
    "maxWritableBytes",
  );
  expect(() => createPiSesh({ pollIntervalMs: 1 })).toThrow("pollIntervalMs");
});

test("session input rejects shell strings, unsafe environment, and invalid network", async () => {
  const control = createPiSesh({
    stateRoot: "/tmp/pi-sesh-control-test-state",
  });
  const base = {
    name: "worker-test",
    image: "localhost/worker:latest",
    workspace: { path: "/tmp", mode: "mount" as const },
    command: ["pi", "--print", "task"],
  };

  await expect(
    control.sessions.start({ ...base, command: [] }),
  ).rejects.toThrow("literal argv");
  await expect(
    control.sessions.start({
      ...base,
      network: "host" as "none",
    }),
  ).rejects.toThrow("Network");
  await expect(
    control.sessions.start({
      ...base,
      environment: { OPENAI_API_KEY: "secret" },
    }),
  ).rejects.toThrow();
  await expect(
    control.sessions.start({
      ...base,
      artifacts: [{ id: "job", destination: "/job" }],
    }),
  ).rejects.toThrow("Artifact");
  await expect(
    control.sessions.start({
      ...base,
      secrets: [
        {
          id: "provider-env",
          destination: "/workspace/provider-env.json",
          content: "{}",
        },
      ],
    }),
  ).rejects.toThrow("Secret file");
});

test("writable usage counts allocated files and does not follow symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh-control-usage-"));
  const external = await mkdtemp(join(tmpdir(), "pi-sesh-control-external-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "data"), "allocated data");
    await writeFile(join(external, "secret"), "must not be counted");
    await symlink(external, join(root, "linked"));

    const bytes = await writablePathBytes([root]);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1024 * 1024);
    expect(
      await writablePathBytes([join(root, "nested", "data")]),
    ).toBeGreaterThan(0);
    await expect(writablePathBytes([join(root, "linked")])).rejects.toThrow(
      "symbolic link",
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(external, { recursive: true, force: true }),
    ]);
  }
});
