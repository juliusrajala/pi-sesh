import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStagedResource } from "../handoff/handoff";
import { DEFAULT_IMAGE } from "../config/config";
import {
  buildContainerCreateArgs,
  validateSessionName,
  type SessionRecord,
} from "./session";
import { PodmanClient, type CommandResult, type ProcessRunner } from "./podman";
import {
  startSessionWithServices,
  type StartSessionOptions,
  type StartupServices,
} from "./session-start";
import { inspectOwnedContainer, PENDING_CONTAINER_ID } from "./owned-container";

const roots: string[] = [];
const containerId = "b".repeat(64);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  faults: {
    writeAt?: number;
    recoveryWrite?: boolean;
    create?: "lost-response" | "rejected" | "invalid-id";
    remove?: "noop" | "error";
    inspect?: "foreign" | "malformed" | "error";
    start?: "throw" | "exit" | "rejected" | "transport-failure" | "missing";
    imageMissing?: boolean;
    clean?: "secret" | "all";
    deleteRecord?: boolean;
    releaseName?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh-start-flow-"));
  roots.push(root);
  const project = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(project);
  await writeFile(join(project, "original.txt"), "caller data");
  const manifestPath = join(root, "handoff.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      resources: [
        {
          id: "output",
          kind: "owned-directory",
          destination: "/home/session/output",
          lifetime: "retained",
        },
      ],
    }),
  );

  const events: string[] = [];
  let exists = false;
  let state = "created";
  let id = "";
  let reserved = false;
  let persisted: SessionRecord | undefined;
  let writes = 0;
  const result = (status = 0, stdout = ""): CommandResult => ({
    status,
    stdout,
    stderr: "",
  });
  const runner: ProcessRunner = async (argv) => {
    const args = argv.slice(2);
    if (args[0] === "info")
      return result(
        0,
        JSON.stringify({
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: ["memory", "pids"],
          },
          version: { Version: "6.1.1" },
        }),
      );
    if (args[0] === "image" && args[1] === "exists")
      return result(faults.imageMissing ? 1 : 0);
    if (args[0] === "image" && args[1] === "inspect")
      return result(0, "a".repeat(64));
    if (args[0] === "create") {
      events.push("create");
      expect(persisted?.containerId).toBe(PENDING_CONTAINER_ID);
      expect(persisted?.resources).toHaveLength(1);
      if (faults.create === "rejected") return result(125);
      exists = true;
      if (faults.create === "lost-response")
        throw new Error("create response lost");
      return result(0, faults.create === "invalid-id" ? "bad-id" : containerId);
    }
    if (args[0] === "container" && args[1] === "exists") {
      events.push(exists ? "exists:present" : "exists:absent");
      if (faults.inspect === "error") return result(125);
      return result(exists ? 0 : 1);
    }
    if (args[0] === "container" && args[1] === "inspect") {
      events.push("inspect");
      if (faults.inspect === "malformed") return result(0, "{}");
      return result(
        0,
        JSON.stringify([
          {
            Id: containerId,
            Config: {
              Labels: {
                "io.pi-sesh.owner":
                  faults.inspect === "foreign" ? "foreign" : "pi-sesh",
                "io.pi-sesh.session-id": id,
              },
            },
            State: { Status: state, ExitCode: state === "exited" ? 17 : 0 },
          },
        ]),
      );
    }
    if (args[0] === "container" && args[1] === "start") {
      events.push("start");
      state = faults.start === "exit" ? "exited" : "running";
      if (faults.start === "throw") throw new Error("start transport lost");
      if (faults.start === "missing") exists = false;
      if (faults.start === "rejected") state = "created";
      if (faults.start === "rejected" || faults.start === "transport-failure")
        return result(125);
      return result(faults.start === "exit" ? 17 : 0);
    }
    if (args[0] === "container" && args[1] === "stop") {
      events.push("stop");
      state = "exited";
      return result();
    }
    if (args[0] === "container" && args[1] === "rm") {
      events.push("remove");
      if (faults.remove === "error") throw new Error("remove transport lost");
      if (faults.remove !== "noop") exists = false;
      return result();
    }
    throw new Error(`Unexpected engine call: ${args.join(" ")}`);
  };
  const client = await PodmanClient.create({
    executable: "/usr/bin/podman",
    source: { PATH: "/usr/bin:/bin", HOME: root },
    runner,
  });
  const services: StartupServices = {
    validateName: validateSessionName,
    prepareStateRoot: async () => {
      await mkdir(stateRoot, { mode: 0o700 });
      return stateRoot;
    },
    reserveName: async (_root, _name, sessionId) => {
      events.push("reserve");
      id = sessionId;
      reserved = true;
    },
    releaseName: async () => {
      events.push("release");
      if (faults.releaseName) throw new Error("release failed");
      reserved = false;
    },
    writeRecord: async (_root, record) => {
      events.push(`write:${++writes}`);
      if (faults.writeAt === writes || (faults.recoveryWrite && writes > 2))
        throw new Error(`metadata write ${writes} failed`);
      persisted = structuredClone(record);
    },
    deleteRecord: async () => {
      events.push("delete-record");
      if (faults.deleteRecord) throw new Error("record deletion failed");
      persisted = undefined;
    },
    cleanResources: async (_root, record, lifetime) => {
      events.push(`clean:${lifetime}`);
      if (faults.clean === lifetime)
        throw new Error(`${lifetime} cleanup failed`);
      if (lifetime === "all") {
        for (const resource of record.resources ?? [])
          await removeStagedResource({ stateRoot, sessionId: id, resource });
        record.resources = [];
      }
    },
    buildCreateArgs: buildContainerCreateArgs,
  };
  const options: StartSessionOptions = {
    name: "flow-test",
    client,
    stateRoot,
    detached: true,
    spec: {
      projectDir: project,
      image: "localhost/test:local",
      workspace: "mount",
      command: ["tool"],
      network: "none",
    },
    handoffManifestPath: manifestPath,
  };
  return {
    root,
    project,
    options,
    services,
    events,
    client,
    snapshot: () => ({ exists, state, reserved, persisted, id }),
    payload: () => join(stateRoot, "resources", id, "output", "payload"),
    run: () => startSessionWithServices(options, services),
  };
}

test.each([
  { image: DEFAULT_IMAGE, remedy: "build-default" },
  { image: "localhost/custom:local", remedy: "build or select an image" },
])(
  "missing image $image fails before reservation with the correct remedy",
  async ({ image, remedy }) => {
    const f = await fixture({ imageMissing: true });
    f.options.spec.image = image;
    await expect(f.run()).rejects.toThrow(remedy);
    expect(f.events).toEqual([]);
    expect(f.snapshot().reserved).toBe(false);
  },
);

test("conflicting handoff inputs fail before reservation or preparation", async () => {
  const f = await fixture();
  let prepared = false;
  f.options.prepareHandoff = async () => {
    prepared = true;
    throw new Error("must not prepare");
  };
  await expect(f.run()).rejects.toThrow("not both");
  expect(prepared).toBe(false);
  expect(f.events).toEqual([]);
});

test.each([
  {
    start: "rejected",
    detached: false,
    message: "failed to start",
    retained: false,
  },
  {
    start: "exit",
    detached: true,
    message: "failed to start",
    retained: false,
  },
  {
    start: "transport-failure",
    detached: false,
    message: "results remain available",
    retained: true,
  },
  {
    start: "transport-failure",
    detached: true,
    message: "failed to start",
    retained: false,
  },
  {
    start: "missing",
    detached: false,
    message: "disappeared during startup",
    retained: false,
  },
  {
    start: "throw",
    detached: true,
    message: "start transport lost",
    retained: false,
  },
] as const)(
  "start outcome $start with detached=$detached keeps its cleanup policy",
  async ({ start, detached, message, retained }) => {
    const f = await fixture({ start });
    f.options.detached = detached;
    await expect(f.run()).rejects.toThrow(message);
    expect(f.snapshot().reserved).toBe(retained);
    expect(f.events.includes("stop")).toBe(retained);
    expect(f.events.includes("clean:secret")).toBe(retained);
    expect(f.events.includes("clean:all")).toBe(!retained);
    if (retained) {
      expect(f.events).not.toContain("remove");
      expect(f.snapshot().state).toBe("exited");
      expect((await stat(f.payload())).isDirectory()).toBe(true);
    } else {
      expect(f.events[f.events.indexOf("clean:all") - 1]).toBe("exists:absent");
      await expect(stat(f.payload())).rejects.toThrow();
    }
  },
);

test("mount overlap checks reject shared paths but accept similar names", async () => {
  for (const destination of [
    "/home/session/runtime/tool",
    "/home/session/runtime/tool/data",
    "/home/session/runtime",
    "/home/session/runtime/toolbox",
  ]) {
    const f = await fixture();
    const source = join(f.root, "program");
    await mkdir(source);
    f.options.runtimeMounts = [
      { source, destination: "/home/session/runtime/tool" },
    ];
    await writeFile(
      f.options.handoffManifestPath!,
      JSON.stringify({
        version: 1,
        resources: [
          {
            id: "output",
            kind: "owned-directory",
            destination,
            lifetime: "retained",
          },
        ],
      }),
    );
    if (destination.endsWith("toolbox")) {
      expect((await f.run()).state).toBe("running");
    } else {
      await expect(f.run()).rejects.toThrow("must not overlap");
      expect(f.events).not.toContain("create");
      expect(f.events).toContain("clean:all");
      expect(f.snapshot().reserved).toBe(false);
    }
  }
});

test("startup failure before workspace acquisition releases only its reservation", async () => {
  const f = await fixture();
  f.options.spec.projectDir = join(f.root, "missing");
  await expect(f.run()).rejects.toThrow("does not exist");
  expect(f.events).toEqual(["reserve", "delete-record", "release"]);
  expect(f.snapshot().reserved).toBe(false);
});

test("preparation failures keep workspace recovery metadata when cleanup fails", async () => {
  const f = await fixture({ clean: "all" });
  delete f.options.handoffManifestPath;
  f.options.prepareHandoff = async () => {
    throw new Error("trusted preparation failed");
  };
  await expect(f.run()).rejects.toThrow("trusted preparation failed");
  expect(f.events).not.toContain("create");
  expect(f.events).not.toContain("release");
  expect(f.snapshot().persisted?.containerId).toBe(PENDING_CONTAINER_ID);
  expect(f.snapshot().persisted?.workspacePath).toBe(f.project);
});

test("registration and pre-create persistence failures clean resources without container operations", async () => {
  for (const writeAt of [1, 2]) {
    const f = await fixture({ writeAt });
    await expect(f.run()).rejects.toThrow();
    expect(f.events).not.toContain("create");
    expect(f.events).not.toContain("remove");
    expect(f.events).toContain("clean:all");
    expect(f.snapshot().reserved).toBe(false);
    await expect(stat(f.payload())).rejects.toThrow();
    expect(await readFile(join(f.project, "original.txt"), "utf8")).toBe(
      "caller data",
    );
  }
});

test("each uncertain create outcome requires verified absence before resource cleanup", async () => {
  for (const faults of [
    { create: "lost-response" as const },
    { create: "invalid-id" as const },
    { create: "rejected" as const },
    { writeAt: 3 },
  ]) {
    const f = await fixture(faults);
    await expect(f.run()).rejects.toThrow();
    const cleanup = f.events.indexOf("clean:all");
    expect(cleanup).toBeGreaterThan(0);
    expect(f.events[cleanup - 1]).toBe("exists:absent");
    expect(f.snapshot().exists).toBe(false);
    expect(f.snapshot().reserved).toBe(false);
    await expect(stat(f.payload())).rejects.toThrow();
  }
});

test("uncertain or foreign containers block resource deletion and name release", async () => {
  for (const faults of [
    { remove: "noop" as const },
    { remove: "error" as const },
    { inspect: "foreign" as const },
    { inspect: "malformed" as const },
    { inspect: "error" as const },
  ]) {
    const f = await fixture({ create: "lost-response", ...faults });
    await expect(f.run()).rejects.toThrow("remains reserved for recovery");
    expect(f.events).not.toContain("clean:all");
    expect(f.events).not.toContain("delete-record");
    expect(f.events).not.toContain("release");
    if ("inspect" in faults) expect(f.events).not.toContain("remove");
    expect(f.snapshot().reserved).toBe(true);
    expect(f.snapshot().persisted?.resources).toHaveLength(1);
    expect((await stat(f.payload())).isDirectory()).toBe(true);
  }
});

test("attached interruption retains results even when secret cleanup fails", async () => {
  const f = await fixture({ start: "throw", clean: "secret" });
  f.options.detached = false;
  const failure = await f.run().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("results remain available");
  const cause = (failure as Error).cause as AggregateError;
  expect(cause).toBeInstanceOf(AggregateError);
  expect(cause.errors.map((error: Error) => error.message)).toEqual([
    "start transport lost",
    "secret cleanup failed",
  ]);
  expect(f.events.slice(-4)).toEqual([
    "stop",
    "exists:present",
    "inspect",
    "clean:secret",
  ]);
  expect(f.events).not.toContain("remove");
  expect(f.events).not.toContain("clean:all");
  expect(f.snapshot().state).toBe("exited");
  expect(f.snapshot().reserved).toBe(true);
  expect((await stat(f.payload())).isDirectory()).toBe(true);
});

test("an attached workload exit is a result, not a rollback request", async () => {
  const f = await fixture({ start: "exit" });
  f.options.detached = false;
  const started = await f.run();
  expect(started.exitCode).toBe(17);
  expect(f.events).toContain("clean:secret");
  expect(f.events).not.toContain("remove");
  expect(f.snapshot().reserved).toBe(true);
});

test("temporary preparation cleanup is retried without losing recovery metadata", async () => {
  const f = await fixture();
  const manifestPath = f.options.handoffManifestPath!;
  delete f.options.handoffManifestPath;
  f.options.prepareHandoff = async () => ({
    manifestPath,
    cleanup: async () => {
      f.events.push("clean:temporary");
      throw new Error("temporary cleanup failed");
    },
  });
  await expect(f.run()).rejects.toThrow("temporary cleanup failed");
  expect(f.events.filter((event) => event === "clean:temporary")).toHaveLength(
    2,
  );
  expect(f.events).not.toContain("create");
  expect(f.events).toContain("clean:all");
  expect(f.events).not.toContain("release");
  expect(f.snapshot().persisted).toBeDefined();
});

test("record deletion and name release failures are reported, not swallowed", async () => {
  for (const faults of [{ deleteRecord: true }, { releaseName: true }]) {
    const f = await fixture({ create: "rejected", ...faults });
    await expect(f.run()).rejects.toThrow("remains reserved for recovery");
    expect(f.snapshot().persisted).toBeDefined();
    expect(f.snapshot().reserved).toBe(true);
    if (faults.deleteRecord) expect(f.events).not.toContain("release");
  }
});

test("recovery reports both resource cleanup and metadata persistence failures", async () => {
  const f = await fixture({
    create: "lost-response",
    clean: "all",
    recoveryWrite: true,
  });
  let failure: unknown;
  try {
    await f.run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const cause = (failure as Error).cause as AggregateError;
  expect(cause).toBeInstanceOf(AggregateError);
  expect(cause.errors.map((error: Error) => error.message)).toEqual([
    "create response lost",
    "all cleanup failed",
    "metadata write 3 failed",
  ]);
  expect(f.snapshot().reserved).toBe(true);
});

test("ownership inspection returns recovered identity without mutating the record", async () => {
  const f = await fixture();
  await f.run();
  const record = Object.freeze({
    ...f.snapshot().persisted!,
    containerId: PENDING_CONTAINER_ID,
  });
  const inspected = await inspectOwnedContainer(f.client, record);
  expect(inspected.kind).toBe("owned");
  if (inspected.kind === "owned")
    expect(inspected.containerId).toBe(containerId);
  expect(record.containerId).toBe(PENDING_CONTAINER_ID);
});
