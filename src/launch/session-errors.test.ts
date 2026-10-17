import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord, StartedSession } from "../container/session";
import {
  openPresetSession,
  PresetSessionError,
  startPresetSession,
  type PresetSessionDependencies,
} from "./session";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const session: StartedSession = {
  id: "88888888-8888-4888-8888-888888888888",
  name: "worker",
  containerId: "b".repeat(64),
  state: "running",
  detached: true,
};
const record: SessionRecord = {
  version: 1,
  id: session.id,
  name: session.name,
  containerName: `pi-sesh-${session.id}`,
  containerId: session.containerId,
  projectDir: "/project",
  workspaceMode: "mount",
  workspacePath: "/project",
  imageId: "a".repeat(64),
  network: "none",
  tty: false,
  createdAt: new Date().toISOString(),
};

async function fixture() {
  const projectDir = await mkdtemp(join(tmpdir(), "pi-sesh-preset-errors-"));
  directories.push(projectDir);
  let prepared = false;
  let started = false;
  let cleaned = false;
  const dependencies: PresetSessionDependencies = {
    loadLaunchPreset: async () => ({
      command: ["agent"],
      workspace: "mount",
      network: "none",
    }),
    preparePresetHandoff: async () => {
      prepared = true;
      return {
        directory: "/private/prepare",
        manifestPath: "/private/prepare/handoff.json",
      };
    },
    cleanupPresetHandoff: async () => {
      cleaned = true;
    },
    startSession: async () => {
      started = true;
      return session;
    },
  };
  return {
    input: { preset: "agent", name: "worker", projectDir, open: true },
    dependencies,
    state: () => ({ prepared, started, cleaned }),
  };
}

async function rejection(
  operation: Promise<unknown>,
): Promise<PresetSessionError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(PresetSessionError);
    return error as PresetSessionError;
  }
  throw new Error("Expected a preset session error");
}

test("invalid preset session inputs fail before host preparation", async () => {
  const { input, dependencies, state } = await fixture();
  for (const overrides of [
    { name: "bad/name" },
    { name: undefined },
    { network: "host" },
    { workspace: "invalid" },
    { args: ["bad\0arg"] },
    { args: "not-argv" },
    { args: Array(256).fill("arg") },
  ]) {
    await expect(
      startPresetSession(
        { ...input, ...overrides } as typeof input,
        dependencies,
      ),
    ).rejects.toThrow();
  }
  expect(state().prepared).toBe(false);
  expect(state().started).toBe(false);
});

test("cleanup errors preserve startup errors and both causes", async () => {
  const { input, dependencies } = await fixture();
  const startup = new Error("image unavailable");
  const cleanup = new Error("private directory busy");
  dependencies.startSession = async () => {
    throw startup;
  };
  dependencies.cleanupPresetHandoff = async () => {
    throw cleanup;
  };
  const error = await rejection(startPresetSession(input, dependencies));
  expect(error.message).toContain("image unavailable");
  expect(error.message).toContain("/private/prepare");
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect((error.cause as AggregateError).errors).toEqual([startup, cleanup]);
});

test("post-start cleanup errors retain the immutable session identity", async () => {
  const { input, dependencies } = await fixture();
  dependencies.cleanupPresetHandoff = async () => {
    throw new Error("busy");
  };
  const error = await rejection(startPresetSession(input, dependencies));
  expect(error.session).toEqual(session);
  expect(error.message).toContain(session.id);
});

test("cancellation after preparation cleans temporary data without starting", async () => {
  const { input, dependencies, state } = await fixture();
  const controller = new AbortController();
  dependencies.preparePresetHandoff = async () => {
    controller.abort();
    return {
      directory: "/private/prepare",
      manifestPath: "/private/prepare/handoff.json",
    };
  };
  await expect(
    startPresetSession({ ...input, signal: controller.signal }, dependencies),
  ).rejects.toThrow();
  expect(state().started).toBe(false);
  expect(state().cleaned).toBe(true);
});

test("open verifies readiness and forwards the selected state root", async () => {
  const { input, dependencies } = await fixture();
  const opened = await openPresetSession(
    { ...input, stateRoot: "/private/state" },
    {
      ...dependencies,
      getSessionStatusById: async (options) => {
        expect(options).toEqual({
          id: session.id,
          stateRoot: "/private/state",
        });
        return { record, status: { state: "running" } };
      },
    },
  );
  expect(opened.command).toEqual(["agent"]);
  expect(opened.record.id).toBe(session.id);
});

test("cancellation during readiness stops the same immutable session", async () => {
  const { input, dependencies } = await fixture();
  const controller = new AbortController();
  let stopped = false;
  const error = await rejection(
    openPresetSession(
      { ...input, signal: controller.signal },
      {
        ...dependencies,
        getSessionStatusById: async () => {
          controller.abort();
          return { record, status: { state: "running" } };
        },
        stopSession: async (options) => {
          expect(options.name).toBe(session.name);
          expect(options.sessionId).toBe(session.id);
          stopped = true;
          return { state: "stopped" };
        },
      },
    ),
  );
  expect(stopped).toBe(true);
  expect(error.session?.id).toBe(session.id);
});

test("readiness and engine failures keep session identity for explicit recovery", async () => {
  const { input, dependencies } = await fixture();
  for (const state of ["exited", "missing", "created", "paused"] as const) {
    const error = await rejection(
      openPresetSession(input, {
        ...dependencies,
        getSessionStatusById: async () => ({ record, status: { state } }),
      }),
    );
    expect(error.session?.id).toBe(session.id);
    expect(error.message).toContain(session.id);
    expect((error.cause as Error).message).toContain(state);
  }
  const engineError = new Error("engine unavailable");
  const error = await rejection(
    openPresetSession(input, {
      ...dependencies,
      getSessionStatusById: async () => {
        throw engineError;
      },
    }),
  );
  expect(error.cause).toBe(engineError);
  expect(error.session?.id).toBe(session.id);
});
