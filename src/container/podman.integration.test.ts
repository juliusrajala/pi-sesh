import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveSpec } from "../config/config";
import { buildProjectImage, PodmanClient } from "./podman";
import {
  getSessionStatus,
  removeSession,
  startSession,
  stopSession,
} from "./session";

const podmanTestsEnabled = process.env.PI_SESH_PODMAN_TESTS === "1";
const integrationTest = test.skipIf(!podmanTestsEnabled);

function buildSpec(projectDir: string, tag: string): EffectiveSpec {
  return {
    projectDir,
    image: tag,
    build: { context: projectDir, file: join(projectDir, "Containerfile") },
    workspace: "mount",
    command: ["true"],
    network: "none",
  };
}

integrationTest(
  "rootless Podman builds a useful fixture, preserves the previous tag, and does not follow an outside symlink",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sesh podman fixture "));
    const project = join(root, "project with spaces");
    await mkdir(project);
    const client = await PodmanClient.create({ projectDir: project });
    await client.preflight();
    if (!(await client.imageExists("docker.io/library/alpine:3.21"))) {
      throw new Error(
        "Opt-in test requires docker.io/library/alpine:3.21 locally; no pull is performed",
      );
    }
    const tag = `localhost/pi-sesh-test:${crypto.randomUUID()}`;
    const escapeTag = `localhost/pi-sesh-escape-test:${crypto.randomUUID()}`;
    try {
      const recipe = join(project, "Containerfile");
      await writeFile(
        recipe,
        "FROM docker.io/library/alpine:3.21\nRUN printf useful-tool > /usr/local/bin/fixture-tool\n",
      );
      const spec = buildSpec(project, tag);
      const built = await buildProjectImage(spec, { client });
      const tool = await client.checked([
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--entrypoint",
        "/bin/sh",
        built.imageId,
        "-c",
        'test "$(cat /usr/local/bin/fixture-tool)" = useful-tool',
      ]);
      expect(tool.status).toBe(0);

      await writeFile(recipe, "FROM localhost/pi-sesh-unavailable:missing\n");
      await expect(buildProjectImage(spec, { client })).rejects.toThrow(
        "Podman build failed",
      );
      expect(await client.imageId(tag)).toBe(built.imageId);

      const outside = join(root, "host-only.txt");
      await writeFile(outside, "must-not-enter-image\n");
      await symlink(outside, join(project, "escape"));
      await writeFile(
        recipe,
        "FROM docker.io/library/alpine:3.21\nCOPY escape /escape\n",
      );
      try {
        const escapeBuild = await buildProjectImage(
          buildSpec(project, escapeTag),
          { client },
        );
        const probe = await client.invoke([
          "run",
          "--rm",
          "--pull=never",
          "--network=none",
          "--entrypoint",
          "/bin/sh",
          escapeBuild.imageId,
          "-c",
          "test ! -e /escape || ! grep -q must-not-enter-image /escape",
        ]);
        expect(probe.status).toBe(0);
      } catch (error) {
        expect(String(error)).toContain("Podman build failed");
      }
    } finally {
      await client.invoke(["image", "rm", "--force", tag]);
      await client.invoke(["image", "rm", "--force", escapeTag]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

integrationTest(
  "generic handoff mounts private snapshots and retains only selected output after exit",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sesh handoff podman "));
    const project = join(root, "caller project");
    const stateRoot = join(root, "state");
    await mkdir(project);
    const selected = join(project, "selected");
    const secret = join(selected, "secret");
    await mkdir(secret, { recursive: true, mode: 0o700 });
    await writeFile(join(selected, "settings.json"), "allowed-value\n", {
      mode: 0o600,
    });
    await writeFile(join(secret, "auth.json"), "synthetic-original\n", {
      mode: 0o600,
    });
    const handoff = join(project, "handoff.json");
    await writeFile(
      handoff,
      JSON.stringify({
        version: 1,
        resources: [
          {
            id: "settings",
            kind: "snapshot",
            source: "selected/settings.json",
            destination: "/home/session/.config/harness/settings.json",
            access: "ro",
            lifetime: "retained",
          },
          {
            id: "auth",
            kind: "snapshot",
            source: "selected/secret",
            destination: "/home/session/.config/harness/auth",
            access: "rw",
            lifetime: "secret",
          },
          {
            id: "output",
            kind: "owned-directory",
            destination: "/home/session/.local/share/harness/output",
            lifetime: "retained",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const client = await PodmanClient.create({ projectDir: project });
    const name = `handoff-integration-${crypto.randomUUID().slice(0, 8)}`;
    let started = false;
    try {
      const result = await startSession({
        name,
        spec: {
          projectDir: project,
          configFile: undefined,
          image: "docker.io/library/node:22-bookworm-slim",
          workspace: "mount",
          command: [
            "sh",
            "-lc",
            'test "$(cat /home/session/.config/harness/settings.json)" = allowed-value && ! touch /home/session/.config/harness/settings.json && printf rotated > /home/session/.config/harness/auth/auth.json.tmp && mv /home/session/.config/harness/auth/auth.json.tmp /home/session/.config/harness/auth/auth.json && printf retained > /home/session/.local/share/harness/output/result.txt',
          ],
          network: "none",
        },
        detached: true,
        stateRoot,
        client,
        handoffManifestPath: handoff,
      });
      started = true;
      expect(["running", "exited"]).toContain(result.state);
      let status = await getSessionStatus({ name, stateRoot, client });
      for (
        let attempt = 0;
        status.status.state === "running" && attempt < 30;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await getSessionStatus({ name, stateRoot, client });
      }
      expect(status.status.state).toBe("exited");
      expect(status.status.exitCode).toBe(0);
      const inspect = await client.checked([
        "container",
        "inspect",
        "--format",
        "json",
        status.record.containerId,
      ]);
      const parsed = JSON.parse(inspect.stdout);
      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      const mounts = item.Mounts as Array<{
        Source: string;
        Destination: string;
        RW: boolean;
        Options?: string[];
      }>;
      const settingsMount = mounts.find(
        (mount) =>
          mount.Destination === "/home/session/.config/harness/settings.json",
      );
      const authMount = mounts.find(
        (mount) => mount.Destination === "/home/session/.config/harness/auth",
      );
      expect(settingsMount?.RW).toBe(false);
      expect(authMount?.RW).toBe(true);
      expect(settingsMount?.Source).not.toBe(
        join(project, "selected", "settings.json"),
      );
      expect(authMount?.Source).not.toBe(join(project, "selected", "secret"));
      expect(
        await readFile(
          join(project, "selected", "secret", "auth.json"),
          "utf8",
        ),
      ).toBe("synthetic-original\n");
      expect(status.record.resources?.map((resource) => resource.id)).toEqual([
        "settings",
        "output",
      ]);
      const outputPath = join(
        stateRoot,
        "resources",
        status.record.id,
        "output",
        "payload",
        "result.txt",
      );
      expect(await readFile(outputPath, "utf8")).toBe("retained");
      await removeSession({ name, stateRoot, client });
      started = false;
      await expect(readFile(outputPath, "utf8")).rejects.toThrow();
    } finally {
      if (started) {
        await stopSession({ name, stateRoot, client }).catch(() => {});
        await removeSession({ name, stateRoot, client }).catch(() => {});
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
