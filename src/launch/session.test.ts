import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPEN_ENVIRONMENT_COMMAND } from "../container/session";
import { startPresetSession, type PresetSessionDependencies } from "./session";

async function fixture() {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-sesh-preset-open-"));
  await writeFile(
    join(projectDir, "pi-sesh.json"),
    JSON.stringify({
      version: 1,
      image: "localhost/project:dev",
      command: ["untrusted"],
      network: "pasta",
    }),
  );
  return projectDir;
}

test("opens the preset environment without starting its agent", async () => {
  const projectDir = await fixture();
  const command = ["/bin/sh", "/home/session/bootstrap.sh", "--no-approve"];
  let cleaned = false;
  try {
    const result = await startPresetSession(
      {
        preset: "pi",
        name: "job",
        projectDir,
        workspace: "clone",
        open: true,
        stateRoot: "/private/state",
      },
      {
        loadLaunchPreset: async () => ({
          command,
          workspace: "mount",
          network: "none",
          prepare: ["/trusted/prepare"],
          runtime: [
            {
              source: "/selected/runtime",
              destination: "/home/session/runtime/pi",
            },
          ],
        }),
        preparePresetHandoff: async () => ({
          directory: "/private/prepare",
          manifestPath: "/private/prepare/handoff.json",
        }),
        cleanupPresetHandoff: async () => {
          cleaned = true;
        },
        startSession: async (input) => {
          expect(input.spec.command).toEqual([...OPEN_ENVIRONMENT_COMMAND]);
          expect(input.spec.image).toBe("localhost/project:dev");
          expect(input.spec.workspace).toBe("clone");
          expect(input.spec.network).toBe("none");
          expect(input.spec.build).toBeUndefined();
          expect(input.runtimeMounts).toHaveLength(1);
          expect(input.handoffManifestPath).toBe(
            "/private/prepare/handoff.json",
          );
          expect(input.stateRoot).toBe("/private/state");
          expect(input.detached).toBe(true);
          expect(input.tty).toBe(false);
          return {
            id: "session-id",
            name: input.name,
            containerId: "container",
            state: "running",
            detached: true,
          };
        },
      },
    );
    expect(result.command).toEqual(command);
    expect(cleaned).toBe(true);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("cleans preset preparation when environment startup fails", async () => {
  const projectDir = await fixture();
  let cleaned = false;
  const dependencies: PresetSessionDependencies = {
    loadLaunchPreset: async () => ({
      command: ["agent"],
      workspace: "clone",
      network: "none",
    }),
    preparePresetHandoff: async () => ({
      directory: "/private/prepare",
      manifestPath: "/private/prepare/handoff.json",
    }),
    cleanupPresetHandoff: async () => {
      cleaned = true;
    },
    startSession: async () => {
      throw new Error("startup failed");
    },
  };
  try {
    await expect(
      startPresetSession(
        { preset: "pi", name: "job", projectDir, open: true },
        dependencies,
      ),
    ).rejects.toThrow("startup failed");
    expect(cleaned).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      startPresetSession(
        {
          preset: "pi",
          name: "job",
          projectDir,
          open: true,
          signal: controller.signal,
        },
        dependencies,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
