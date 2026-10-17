import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startSession,
  executeSession,
  getSessionStatus,
  listSessions,
  attachSession,
  showSessionLogs,
  stopSession,
  removeSession,
  buildContainerCreateArgs,
} from "./session";
import { PodmanClient, type CommandResult, type ProcessRunner } from "./podman";
async function prepareSecretFixture(options: {
  stateRoot: string;
  sessionId: string;
  sourcePath: string;
}) {
  const directory = await mkdtemp(join(options.stateRoot, "secret-fixture-"));
  await mkdir(join(directory, "agent"), { mode: 0o700 });
  await writeFile(
    join(directory, "agent", "auth.json"),
    await readFile(options.sourcePath),
    { mode: 0o600 },
  );
  const manifestPath = join(directory, "handoff.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      resources: [
        {
          id: "pi-auth",
          kind: "snapshot",
          source: "agent",
          destination: "/home/session/.config/harness/credentials",
          access: "rw",
          lifetime: "secret",
        },
      ],
    }),
    { mode: 0o600 },
  );
  return { manifestPath, cleanup: () => rm(directory, { recursive: true }) };
}
import type { EffectiveSpec } from "../config/config";

const directories: string[] = [];
const imageId = "a".repeat(64);
const containerId = "b".repeat(64);
const sessionId = "88888888-8888-4888-8888-888888888888";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh session "));
  directories.push(root);
  const project = join(root, "project folder");
  const stateRoot = join(root, "state");
  await mkdir(project);
  await writeFile(join(project, "file.txt"), "caller data");
  return { root, project, stateRoot };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function spec(
  projectDir: string,
  overrides: Partial<EffectiveSpec> = {},
): EffectiveSpec {
  return {
    projectDir,
    configFile: undefined,
    image: "localhost/session-test:local",
    workspace: "mount",
    command: ["sh", "-lc", "printf '$HOME'"],
    network: "none",
    ...overrides,
  };
}

function fakePodman(
  options: {
    startState?: string;
    startCode?: number;
    startStderr?: string;
    exitCode?: number;
    failStartOnce?: boolean;
    failRemoveOnce?: boolean;
    foreignLabel?: boolean;
    existsStatus?: number;
    inspectMalformed?: boolean;
    onInspect?: () => void;
    removeNoop?: boolean;
    execWaitForAbort?: boolean;
    execStatus?: number;
    execError?: boolean;
    failStop?: boolean;
    startWaitForAbort?: boolean;
    startError?: boolean;
    createError?: boolean;
  } = {},
) {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  let exists = false;
  let state = "created";
  let exitCode = 0;
  let ownedSessionId = "";
  let failStart = options.failStartOnce ?? false;
  let failRemove = options.failRemoveOnce ?? false;
  const runner: ProcessRunner = async (argv, processOptions) => {
    const args = argv.slice(2);
    calls.push({ args, env: processOptions.env });
    if (args[0] === "info") {
      return result(
        0,
        JSON.stringify({
          host: {
            security: { rootless: true, selinuxEnabled: false },
            serviceIsRemote: false,
            cgroupVersion: "v2",
            cgroupControllers: ["memory", "pids"],
            rootlessNetworkCmd: "pasta",
          },
          version: { Version: "6.1.1", OsArch: "linux/amd64" },
        }),
      );
    }
    if (args[0] === "image" && args[1] === "exists") return result(0);
    if (args[0] === "image" && args[1] === "inspect")
      return result(0, `${imageId}\n`);
    if (args[0] === "create") {
      exists = true;
      state = "created";
      ownedSessionId =
        args
          .find((value) => value.startsWith("io.pi-sesh.session-id="))
          ?.split("=")[1] ?? "";
      if (options.createError) throw new Error("create response lost");
      return result(0, `${containerId}\n`);
    }
    if (args[0] === "container" && args[1] === "start") {
      if (failStart) {
        failStart = false;
        state = "created";
        return result(125, "", options.startStderr ?? "");
      }
      state =
        options.startState ??
        (args.includes("--attach") ? "exited" : "running");
      exitCode = options.exitCode ?? options.startCode ?? 0;
      if (options.startWaitForAbort) {
        await new Promise<void>((resolve) => {
          if (processOptions.signal?.aborted) resolve();
          else
            processOptions.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
      }
      if (options.startError) throw new Error("Attached transport failed");
      return result(options.startCode ?? 0, "", options.startStderr ?? "");
    }
    if (args[0] === "container" && args[1] === "exists")
      return result(options.existsStatus ?? (exists ? 0 : 1));
    if (args[0] === "container" && args[1] === "inspect") {
      options.onInspect?.();
      if (options.inspectMalformed) return result(0, '{"Id":"invalid"}');
      return result(
        0,
        JSON.stringify([
          {
            Id: containerId,
            Config: {
              Labels: {
                "io.pi-sesh.owner": options.foreignLabel
                  ? "foreign"
                  : "pi-sesh",
                "io.pi-sesh.session-id": ownedSessionId,
              },
            },
            State: { Status: state, ExitCode: exitCode },
          },
        ]),
      );
    }
    if (args[0] === "exec") {
      if (options.execError) throw new Error("exec transport failed");
      if (options.execWaitForAbort) {
        await new Promise<void>((resolve) => {
          if (processOptions.signal?.aborted) resolve();
          else
            processOptions.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
      }
      return result(options.execStatus ?? 0, "exec output", "");
    }
    if (args[0] === "container" && args[1] === "attach") return result(0);
    if (args[0] === "container" && args[1] === "logs")
      return result(0, "workload output\n");
    if (args[0] === "container" && args[1] === "stop") {
      if (options.failStop) return result(125);
      state = "exited";
      exitCode = 143;
      return result(0);
    }
    if (args[0] === "container" && args[1] === "rm") {
      if (failRemove) {
        failRemove = false;
        return result(125);
      }
      if (!options.removeNoop) exists = false;
      return result(0);
    }
    throw new Error(`Unexpected Podman call: ${args.join(" ")}`);
  };
  return {
    calls,
    runner,
    options,
    async client(stateRoot: string) {
      return PodmanClient.create({
        executable: "/usr/bin/podman",
        source: {
          PATH: "/usr/bin:/bin",
          HOME: stateRoot,
          XDG_DATA_HOME: join(stateRoot, "data"),
        },
        runner,
      });
    },
  };
}

async function git(cwd: string, args: string[]) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, status] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function initCommittedRepo(project: string) {
  await rm(join(project, "file.txt"));
  await git(project, ["init", "--initial-branch=main"]);
  await git(project, ["config", "user.name", "Test User"]);
  await git(project, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(project, "source.txt"), "committed fixture\n");
  await git(project, ["add", "source.txt"]);
  await git(project, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "fixture",
  ]);
}

function result(status = 0, stdout = "", stderr = ""): CommandResult {
  return { status, stdout, stderr };
}

test("attached cancellation and transport failure stop the container and retain clone results", async () => {
  for (const outcome of ["cancel", "throw", "transport-status"]) {
    const { project, stateRoot } = await fixture();
    await initCommittedRepo(project);
    const fake = fakePodman({
      startState: "running",
      startWaitForAbort: outcome === "cancel",
      startError: outcome === "throw",
      startCode: outcome === "transport-status" ? 125 : 0,
    });
    const client = await fake.client(stateRoot);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        startSession({
          name: "attached-interrupt",
          spec: spec(project, { workspace: "clone" }),
          tty: false,
          client,
          stateRoot,
          signal: controller.signal,
        }),
      ).rejects.toThrow("results remain available");
      const status = await getSessionStatus({
        name: "attached-interrupt",
        client,
        stateRoot,
      });
      expect(status.status.state).toBe("exited");
      expect(
        await readFile(join(status.record.workspacePath, "source.txt"), "utf8"),
      ).toBe("committed fixture\n");
      const create = fake.calls.find((call) => call.args[0] === "create")!;
      expect(create.args).toContain("--interactive");
      expect(create.args).not.toContain("--tty");
      expect(
        fake.calls.some(
          (call) => call.args[0] === "container" && call.args[1] === "rm",
        ),
      ).toBe(false);
      await removeSession({ name: "attached-interrupt", client, stateRoot });
    } finally {
      clearTimeout(timer);
    }
  }
});

test("exec verifies session identity and preserves literal argv and exit status", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman({ execStatus: 23 });
  const client = await fake.client(stateRoot);
  const started = await startSession({
    name: "tools",
    spec: spec(project),
    detached: true,
    stateRoot,
    client,
  });
  const result = await executeSession({
    name: "tools",
    sessionId: started.id,
    argv: ["printf", "$HOME; literal", ""],
    stateRoot,
    client,
  });
  expect(result.status).toBe(23);
  expect(fake.calls.find((call) => call.args[0] === "exec")?.args).toEqual([
    "exec",
    "--interactive",
    "--workdir",
    "/workspace",
    "--",
    containerId,
    "printf",
    "$HOME; literal",
    "",
  ]);
  const dir = join(stateRoot, "executions", started.id);
  const receipts = await readdir(dir);
  const path = join(dir, receipts[0]!);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  expect(receipt.sessionId).toBe(started.id);
  expect(receipt.status).toBe(23);
  expect(receipt.outcome).toBe("completed");
  expect(receipt.endedAt).toBeDefined();
  expect(receipt.argv).toBeUndefined();
  expect((await stat(path)).mode & 0o077).toBe(0);
  fake.calls.length = 0;
  await expect(
    executeSession({
      name: "tools",
      sessionId,
      argv: ["true"],
      stateRoot,
      client,
    }),
  ).rejects.toThrow("does not match");
  expect(fake.calls.some((call) => call.args[0] === "exec")).toBe(false);
  await stopSession({ name: "tools", stateRoot, client });
  await expect(
    executeSession({
      name: "tools",
      sessionId: started.id,
      argv: ["true"],
      stateRoot,
      client,
    }),
  ).rejects.toThrow("requires a running");
  await removeSession({ name: "tools", stateRoot, client });
  await expect(stat(dir)).rejects.toThrow();
});

test("exec cancellation and timeout stop the container and retain receipts", async () => {
  for (const timedOut of [false, true]) {
    const { project, stateRoot } = await fixture();
    const fake = fakePodman({ execWaitForAbort: true });
    const client = await fake.client(stateRoot);
    const started = await startSession({
      name: "cancel-tools",
      spec: spec(project),
      detached: true,
      stateRoot,
      client,
    });
    const controller = new AbortController();
    const promise = executeSession({
      name: "cancel-tools",
      sessionId: started.id,
      argv: ["sleep", "99"],
      stateRoot,
      client,
      signal: controller.signal,
      ...(timedOut ? { timeout: 0.01 } : {}),
    });
    if (!timedOut) setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow(timedOut ? "timed out" : "cancelled");
    expect(
      fake.calls.some(
        (call) =>
          call.args.join(" ") === `container stop --time 0 ${containerId}`,
      ),
    ).toBe(true);
    expect(
      (await getSessionStatus({ name: "cancel-tools", stateRoot, client }))
        .status.state,
    ).toBe("exited");
    const dir = join(stateRoot, "executions", started.id);
    const receipt = JSON.parse(
      await readFile(join(dir, (await readdir(dir))[0]!), "utf8"),
    );
    expect(receipt.outcome).toBe(timedOut ? "timeout" : "cancelled");
    expect(await readFile(join(project, "file.txt"), "utf8")).toBe(
      "caller data",
    );
  }
});

test("exec transport failures stop the environment and cancellation failures stay visible", async () => {
  for (const failStop of [false, true]) {
    const { project, stateRoot } = await fixture();
    const fake = fakePodman({ execError: true, failStop });
    const client = await fake.client(stateRoot);
    const started = await startSession({
      name: "transport",
      spec: spec(project),
      detached: true,
      stateRoot,
      client,
    });
    await expect(
      executeSession({
        name: "transport",
        sessionId: started.id,
        argv: ["true"],
        stateRoot,
        client,
      }),
    ).rejects.toThrow(
      failStop ? "could not be verified" : "exec transport failed",
    );
    expect(
      (await getSessionStatus({ name: "transport", stateRoot, client })).status
        .state,
    ).toBe(failStop ? "running" : "exited");
    const dir = join(stateRoot, "executions", started.id);
    const receipt = JSON.parse(
      await readFile(join(dir, (await readdir(dir))[0]!), "utf8"),
    );
    expect(receipt.outcome).toBe("error");
  }
});

test("exec refuses foreign containers and invalid requests before execution", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman();
  const client = await fake.client(stateRoot);
  const started = await startSession({
    name: "owned-tools",
    spec: spec(project),
    detached: true,
    stateRoot,
    client,
  });
  fake.options.foreignLabel = true;
  await expect(
    executeSession({
      name: "owned-tools",
      sessionId: started.id,
      argv: ["true"],
      stateRoot,
      client,
    }),
  ).rejects.toThrow("not owned");
  await expect(
    executeSession({
      name: "owned-tools",
      sessionId: started.id,
      argv: ["bad\0arg"],
      stateRoot,
      client,
    }),
  ).rejects.toThrow("NUL");
  expect(fake.calls.some((call) => call.args[0] === "exec")).toBe(false);
});

test("detached cancellation during startup inspection verifies removal before cleanup", async () => {
  for (const failRemoveOnce of [false, true]) {
    const { project, stateRoot } = await fixture();
    const controller = new AbortController();
    const fake = fakePodman({
      onInspect: () => controller.abort(),
      failRemoveOnce,
    });
    const client = await fake.client(stateRoot);
    await expect(
      startSession({
        name: "cancelled-open",
        spec: spec(project),
        detached: true,
        signal: controller.signal,
        client,
        stateRoot,
      }),
    ).rejects.toThrow();
    const removal = fake.calls.findIndex(
      ({ args }) => args[0] === "container" && args[1] === "rm",
    );
    expect(removal).toBeGreaterThan(0);
    expect(fake.calls[removal + 1]!.args.slice(0, 2)).toEqual([
      "container",
      "exists",
    ]);
    expect(await readdir(join(stateRoot, "sessions"))).toHaveLength(
      failRemoveOnce ? 1 : 0,
    );
    expect(await readdir(join(stateRoot, "names"))).toHaveLength(
      failRemoveOnce ? 1 : 0,
    );
  }
});

test("lost create responses preserve resources until owned-container absence is verified", async () => {
  for (const scenario of [
    {},
    { failRemoveOnce: true },
    { foreignLabel: true },
    { existsStatus: 2 },
  ]) {
    const { project, stateRoot } = await fixture();
    const handoffPath = join(project, "handoff.json");
    await writeFile(
      handoffPath,
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
    const fake = fakePodman({ ...scenario, createError: true });
    const client = await fake.client(stateRoot);
    await expect(
      startSession({
        name: "lost-create",
        spec: spec(project),
        detached: true,
        handoffManifestPath: handoffPath,
        client,
        stateRoot,
      }),
    ).rejects.toThrow("create response lost");
    const records = await readdir(join(stateRoot, "sessions"));
    if (Object.keys(scenario).length === 0) {
      expect(records).toHaveLength(0);
      expect(await readdir(join(stateRoot, "names"))).toHaveLength(0);
      await expect(readdir(join(stateRoot, "resources"))).rejects.toThrow();
      continue;
    }
    expect(records).toHaveLength(1);
    const record = JSON.parse(
      await readFile(join(stateRoot, "sessions", records[0]!), "utf8"),
    );
    expect(record.resources).toHaveLength(1);
    expect(
      (
        await stat(join(stateRoot, "resources", record.id, "output", "payload"))
      ).isDirectory(),
    ).toBe(true);
    if (scenario.foreignLabel || scenario.existsStatus) {
      expect(
        fake.calls.some(
          ({ args }) => args[0] === "container" && args[1] === "rm",
        ),
      ).toBe(false);
    }
    fake.options.foreignLabel = false;
    fake.options.existsStatus = undefined;
    const recovered = await getSessionStatus({
      name: "lost-create",
      client,
      stateRoot,
    });
    expect(recovered.record.containerId).toBe(containerId);
    await removeSession({ name: "lost-create", client, stateRoot });
    expect(await readdir(join(stateRoot, "sessions"))).toHaveLength(0);
  }
});

test("session policy rejects unsafe runtime modes before Podman access", async () => {
  const { project } = await fixture();
  for (const overrides of [
    { network: "host" as "none" },
    { workspace: "unsafe" as "mount" },
    { command: ["tool", "bad\0arg"] },
  ]) {
    await expect(
      startSession({ name: "invalid", spec: spec(project, overrides) }),
    ).rejects.toThrow();
  }
});

test("runtime create args apply the fixed security/resource policy and preserve argv", async () => {
  const { project } = await fixture();
  const args = buildContainerCreateArgs({
    record: {
      id: sessionId,
      name: "shell",
      containerName: `pi-sesh-${sessionId}`,
      imageId,
    },
    spec: spec(project, {
      network: "pasta",
      environment: { NODE_ENV: "test", PROJECT_PROFILE: "itsaplan" },
    }),
    workspace: { mode: "mount", path: project, projectDir: project },
    uid: 1000,
    gid: 1000,
    tty: true,
    selinux: true,
    terminal: { term: "xterm-256color" },
  });
  for (const argument of [
    "--pull=never",
    "--image-volume=ignore",
    "--http-proxy=false",
    "--userns=keep-id",
    "1000:1000",
    "--read-only",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--memory=4g",
    "--memory-swap=4g",
    "--cpus=4",
    "--pids-limit=512",
    "/home/session:rw,noexec,nosuid,nodev,size=1g,mode=1777",
    "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777",
    `${project}:/workspace:rw,Z`,
    "--network",
    "pasta",
    "TERM=xterm-256color",
    "NODE_ENV=test",
    "PROJECT_PROFILE=itsaplan",
  ]) {
    expect(args).toContain(argument);
  }
  expect(args.slice(-5)).toEqual([
    "--entrypoint",
    "sh",
    imageId,
    "-lc",
    "printf '$HOME'",
  ]);
  expect(args.some((argument) => argument.includes("--privileged"))).toBe(
    false,
  );
  expect(args).not.toContain("OPENAI_API_KEY=synthetic-host-secret");
  expect(() =>
    buildContainerCreateArgs({
      record: {
        id: sessionId,
        name: "shell",
        containerName: `pi-sesh-${sessionId}`,
        imageId,
      },
      spec: spec(project, { environment: { HOME: "/tmp/host" } }),
      workspace: { mode: "mount", path: project, projectDir: project },
      uid: 1000,
      gid: 1000,
      tty: false,
      selinux: false,
    }),
  ).toThrow("reserved");
});

test("detached session survives CLI lifecycle operations and retains mount workspace", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman();
  const client = await fake.client(stateRoot);
  const started = await startSession({
    name: "checks",
    spec: spec(project),
    detached: true,
    client,
    stateRoot,
  });
  expect(started.state).toBe("running");
  expect(started.detached).toBe(true);
  const inspected = await getSessionStatus({
    name: "checks",
    client,
    stateRoot,
  });
  expect(inspected.record.containerId).toBe(containerId);
  expect(inspected.status.state).toBe("running");
  expect(
    (await listSessions({ client, stateRoot })).map((item) => item.record.name),
  ).toEqual(["checks"]);
  expect(await attachSession({ name: "checks", client, stateRoot })).toBe(0);
  expect(
    (await showSessionLogs({ name: "checks", client, stateRoot })).status,
  ).toBe(0);
  const stopped = await stopSession({ name: "checks", client, stateRoot });
  expect(stopped.state).toBe("exited");
  expect(stopped.exitCode).toBe(143);
  await removeSession({ name: "checks", client, stateRoot });
  expect((await listSessions({ client, stateRoot })).length).toBe(0);
  expect(await readFile(join(project, "file.txt"), "utf8")).toBe("caller data");
});

test("generic handoff mounts selected snapshots and retains outputs separately from secrets", async () => {
  const { project, stateRoot } = await fixture();
  const selected = join(project, "selected");
  const secret = join(selected, "auth");
  await mkdir(secret, { recursive: true, mode: 0o700 });
  await writeFile(join(selected, "settings.json"), '{"name":"offline"}\n', {
    mode: 0o600,
  });
  await writeFile(join(secret, "auth.json"), '{"credential":"synthetic"}\n', {
    mode: 0o600,
  });
  const handoffPath = join(project, "handoff.json");
  await writeFile(
    handoffPath,
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
          source: "selected/auth",
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
  const fake = fakePodman({ startState: "exited", exitCode: 3 });
  const client = await fake.client(stateRoot);
  const started = await startSession({
    name: "handoff-task",
    spec: spec(project, { command: ["harness", "--run"] }),
    detached: true,
    client,
    stateRoot,
    handoffManifestPath: handoffPath,
  });
  expect(started.state).toBe("exited");
  const create = fake.calls.find((call) => call.args[0] === "create")!;
  expect(
    create.args.some((argument) =>
      argument.endsWith(":/home/session/.config/harness/settings.json:ro"),
    ),
  ).toBe(true);
  expect(
    create.args.some((argument) =>
      argument.endsWith(":/home/session/.config/harness/auth:rw"),
    ),
  ).toBe(true);
  expect(JSON.stringify(create.args)).not.toContain("synthetic");
  const record = (
    await getSessionStatus({ name: "handoff-task", client, stateRoot })
  ).record;
  expect(record.resources?.map((resource) => resource.id)).toEqual([
    "settings",
    "output",
  ]);
  const output = join(stateRoot, "resources", record.id, "output", "payload");
  await writeFile(join(output, "result.txt"), "retained output");
  await expect(
    readFile(
      join(stateRoot, "resources", record.id, "auth", "payload", "auth.json"),
      "utf8",
    ),
  ).rejects.toThrow();
  await removeSession({ name: "handoff-task", client, stateRoot });
  await expect(readFile(join(output, "result.txt"), "utf8")).rejects.toThrow();
});

test("generic handoff snapshots persist across attach without reseeding", async () => {
  const { project, stateRoot } = await fixture();
  const input = join(project, "selected.json");
  await writeFile(input, "original\n", { mode: 0o600 });
  const handoffPath = join(project, "handoff.json");
  await writeFile(
    handoffPath,
    JSON.stringify({
      version: 1,
      resources: [
        {
          id: "config",
          kind: "snapshot",
          source: "selected.json",
          destination: "/home/session/.config/custom/config.json",
          access: "rw",
          lifetime: "retained",
        },
        {
          id: "state",
          kind: "owned-directory",
          destination: "/home/session/.local/share/custom/state",
          lifetime: "retained",
        },
      ],
    }),
  );
  const fake = fakePodman();
  const client = await fake.client(stateRoot);
  await startSession({
    name: "handoff-attach",
    spec: spec(project, { command: ["sh"] }),
    detached: true,
    client,
    stateRoot,
    handoffManifestPath: handoffPath,
  });
  const record = (
    await getSessionStatus({ name: "handoff-attach", client, stateRoot })
  ).record;
  const stagedConfig = join(
    stateRoot,
    "resources",
    record.id,
    "config",
    "payload",
  );
  const output = join(stateRoot, "resources", record.id, "state", "payload");
  await writeFile(stagedConfig, "container-updated\n");
  await writeFile(join(output, "transcript.jsonl"), "retained line\n");
  expect(
    await attachSession({ name: "handoff-attach", client, stateRoot }),
  ).toBe(0);
  expect(await readFile(stagedConfig, "utf8")).toBe("container-updated\n");
  expect(await readFile(input, "utf8")).toBe("original\n");
  await stopSession({ name: "handoff-attach", client, stateRoot });
  expect(await readFile(join(output, "transcript.jsonl"), "utf8")).toBe(
    "retained line\n",
  );
  await removeSession({ name: "handoff-attach", client, stateRoot });
});

test("generic handoff resources clean up after failed startup and the name can be reused", async () => {
  const { project, stateRoot } = await fixture();
  const secret = join(project, "secret");
  await mkdir(secret, { mode: 0o700 });
  await writeFile(join(secret, "credential"), "synthetic", { mode: 0o600 });
  const handoffPath = join(project, "handoff.json");
  await writeFile(
    handoffPath,
    JSON.stringify({
      version: 1,
      resources: [
        {
          id: "secret",
          kind: "snapshot",
          source: "secret",
          destination: "/home/session/.config/harness/secret",
          access: "rw",
          lifetime: "secret",
        },
      ],
    }),
  );
  const fake = fakePodman({ failStartOnce: true });
  const client = await fake.client(stateRoot);
  await expect(
    startSession({
      name: "handoff-retry",
      spec: spec(project),
      detached: true,
      client,
      stateRoot,
      handoffManifestPath: handoffPath,
    }),
  ).rejects.toThrow("failed to start the session");
  await startSession({
    name: "handoff-retry",
    spec: spec(project),
    detached: true,
    client,
    stateRoot,
    handoffManifestPath: handoffPath,
  });
  await stopSession({ name: "handoff-retry", client, stateRoot });
  await removeSession({ name: "handoff-retry", client, stateRoot });
});

test("interactive workload nonzero exit is retained and propagated, not treated as launch failure", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman({ startCode: 7 });
  const result = await startSession({
    name: "failure",
    spec: spec(project),
    client: await fake.client(stateRoot),
    stateRoot,
  });
  expect(result.state).toBe("exited");
  expect(result.exitCode).toBe(7);
  expect(
    fake.calls.some(
      (call) => call.args[0] === "container" && call.args[1] === "rm",
    ),
  ).toBe(false);
});

test("launch failures remove only their new container and release the name", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman({ failStartOnce: true });
  const client = await fake.client(stateRoot);
  await expect(
    startSession({
      name: "retryable",
      spec: spec(project),
      detached: true,
      client,
      stateRoot,
    }),
  ).rejects.toThrow("failed to start the session");
  expect(
    fake.calls.some(
      (call) => call.args[0] === "container" && call.args[1] === "rm",
    ),
  ).toBe(true);
  fake.calls.length = 0;
  // A subsequent reservation is not blocked by stale name metadata.
  await startSession({
    name: "retryable",
    spec: spec(project),
    detached: true,
    client,
    stateRoot,
  });
});

test("startup errors include a bounded single-line Podman diagnostic", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman({
    startState: "created",
    startCode: 125,
    startStderr: `Error: crun: executable file not found\n${"x".repeat(700)}`,
  });
  const client = await fake.client(stateRoot);
  let errorMessage = "";
  try {
    await startSession({
      name: "missing-command",
      spec: spec(project),
      detached: true,
      client,
      stateRoot,
    });
  } catch (error) {
    errorMessage = String(error);
  }
  expect(errorMessage).toContain("executable file not found");
  expect(errorMessage).not.toContain("\n");
  expect(errorMessage.length).toBeLessThan(700);
  const startFailure = fake.calls.find(
    (call) => call.args[0] === "container" && call.args[1] === "start",
  );
  expect(startFailure).toBeDefined();
});

test("failed cleanup retains ownership metadata and the name reservation for recovery", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman({
    startState: "created",
    startCode: 125,
    failRemoveOnce: true,
  });
  const client = await fake.client(stateRoot);
  await expect(
    startSession({
      name: "needs-recovery",
      spec: spec(project),
      detached: true,
      client,
      stateRoot,
    }),
  ).rejects.toThrow("remains reserved for recovery");
  expect(
    (await getSessionStatus({ name: "needs-recovery", client, stateRoot }))
      .status.state,
  ).toBe("created");
  await removeSession({ name: "needs-recovery", client, stateRoot });
  expect((await listSessions({ client, stateRoot })).length).toBe(0);
});

test("Podman exists errors and malformed inspection fail closed without deleting session data", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman();
  const client = await fake.client(stateRoot);
  await startSession({
    name: "engine-error",
    spec: spec(project),
    detached: true,
    client,
    stateRoot,
  });
  fake.options.existsStatus = 125;
  await expect(
    getSessionStatus({ name: "engine-error", client, stateRoot }),
  ).rejects.toThrow("could not determine whether container");
  await expect(
    removeSession({ name: "engine-error", client, stateRoot }),
  ).rejects.toThrow("could not determine whether container");
  fake.options.existsStatus = undefined;
  fake.options.inspectMalformed = true;
  await expect(
    removeSession({ name: "engine-error", client, stateRoot }),
  ).rejects.toThrow("incomplete container inspection");
  expect(
    fake.calls.some(
      (call) => call.args[0] === "container" && call.args[1] === "rm",
    ),
  ).toBe(false);
  fake.options.inspectMalformed = false;
  expect(
    (await getSessionStatus({ name: "engine-error", client, stateRoot })).status
      .state,
  ).toBe("running");
});

test("container engine errors preserve clone, staged auth, and name reservation", async () => {
  const { root, project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  const authFile = join(root, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify({ "openai-codex": { type: "oauth", access: "synthetic" } }),
    { mode: 0o600 },
  );
  const fake = fakePodman();
  const client = await fake.client(stateRoot);
  await startSession({
    name: "clone-engine-error",
    spec: spec(project, { workspace: "clone", command: ["pi"] }),
    detached: true,
    client,
    stateRoot,
    prepareHandoff: (context) =>
      prepareSecretFixture({ ...context, sourcePath: authFile }),
  });
  const record = (
    await getSessionStatus({ name: "clone-engine-error", client, stateRoot })
  ).record;
  fake.options.existsStatus = 125;
  await expect(
    removeSession({ name: "clone-engine-error", client, stateRoot }),
  ).rejects.toThrow("could not determine whether container");
  expect(await readFile(join(record.workspacePath, "source.txt"), "utf8")).toBe(
    "committed fixture\n",
  );
  await expect(
    readFile(
      join(
        stateRoot,
        "resources",
        record.id,
        "pi-auth",
        "payload",
        "auth.json",
      ),
      "utf8",
    ),
  ).resolves.toContain("synthetic");
  fake.options.existsStatus = undefined;
  await stopSession({ name: "clone-engine-error", client, stateRoot });
  await removeSession({ name: "clone-engine-error", client, stateRoot });
  await expect(
    readFile(
      join(
        stateRoot,
        "resources",
        record.id,
        "pi-auth",
        "payload",
        "auth.json",
      ),
      "utf8",
    ),
  ).rejects.toThrow();
});

test("bulk actions refuse a session name whose immutable identity changed", async () => {
  const { project, stateRoot } = await fixture();
  const podman = fakePodman();
  const client = await podman.client(stateRoot);
  await startSession({
    name: "reused",
    spec: spec(project),
    detached: true,
    stateRoot,
    client,
  });
  const options = { name: "reused", sessionId, stateRoot, client };
  await expect(stopSession(options)).rejects.toThrow(
    "Session identity changed",
  );
  await expect(removeSession(options)).rejects.toThrow(
    "Session identity changed",
  );
  expect(
    podman.calls.some(
      ({ args }) =>
        args[0] === "container" && ["stop", "rm"].includes(args[1]!),
    ),
  ).toBe(false);
  expect(
    (await getSessionStatus({ name: "reused", stateRoot, client })).status
      .state,
  ).toBe("running");
});

test("remove verifies absence before deleting session metadata", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman({ removeNoop: true });
  const client = await fake.client(stateRoot);
  await startSession({
    name: "rm-not-absent",
    spec: spec(project),
    detached: true,
    client,
    stateRoot,
  });
  await stopSession({ name: "rm-not-absent", client, stateRoot });
  await expect(
    removeSession({ name: "rm-not-absent", client, stateRoot }),
  ).rejects.toThrow("container is still present");
  expect(
    (await getSessionStatus({ name: "rm-not-absent", client, stateRoot }))
      .status.state,
  ).toBe("exited");
});

test("paused sessions retain credential staging and cannot be stopped or removed", async () => {
  const { root, project, stateRoot } = await fixture();
  const sourcePath = join(root, "auth.json");
  await writeFile(
    sourcePath,
    JSON.stringify({ "openai-codex": { type: "oauth", access: "synthetic" } }),
    { mode: 0o600 },
  );
  const fake = fakePodman({ startState: "paused" });
  const client = await fake.client(stateRoot);
  await startSession({
    name: "paused-task",
    spec: spec(project, { command: ["pi"] }),
    detached: true,
    client,
    stateRoot,
    prepareHandoff: (context) =>
      prepareSecretFixture({ ...context, sourcePath }),
  });
  const record = (
    await getSessionStatus({ name: "paused-task", client, stateRoot })
  ).record;
  const stagedAuth = join(
    stateRoot,
    "resources",
    record.id,
    "pi-auth",
    "payload",
    "auth.json",
  );
  expect((await readFile(stagedAuth, "utf8")).includes("synthetic")).toBe(true);
  await expect(
    stopSession({ name: "paused-task", client, stateRoot }),
  ).rejects.toThrow("Session is paused");
  await expect(
    removeSession({ name: "paused-task", client, stateRoot }),
  ).rejects.toThrow("Stop the session");
  expect((await readFile(stagedAuth, "utf8")).includes("synthetic")).toBe(true);
  expect(
    fake.calls.some(
      (call) => call.args[0] === "container" && call.args[1] === "stop",
    ),
  ).toBe(false);
});

test("duplicate session names are refused before a second container is created", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman();
  const client = await fake.client(stateRoot);
  await startSession({
    name: "unique",
    spec: spec(project),
    detached: true,
    client,
    stateRoot,
  });
  const createCalls = fake.calls.filter(
    (call) => call.args[0] === "create",
  ).length;
  await expect(
    startSession({
      name: "unique",
      spec: spec(project),
      detached: true,
      client,
      stateRoot,
    }),
  ).rejects.toThrow("already reserved");
  expect(fake.calls.filter((call) => call.args[0] === "create").length).toBe(
    createCalls,
  );
});

test("foreign container labels are refused", async () => {
  const { project, stateRoot } = await fixture();
  const fake = fakePodman({ foreignLabel: true });
  await expect(
    startSession({
      name: "owned",
      spec: spec(project),
      detached: true,
      client: await fake.client(stateRoot),
      stateRoot,
    }),
  ).rejects.toThrow("not owned by this pi-sesh session");
});

test("explicit secret handoff is cleaned on task exit", async () => {
  const { root, project, stateRoot } = await fixture();
  const sourcePath = join(root, "auth.json");
  await writeFile(
    sourcePath,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "synthetic-offline-only",
        refresh: "rotate-me",
        expires: 123,
      },
      unrelated: { type: "api_key", key: "must-not-stage" },
    }),
    { mode: 0o600 },
  );
  const fake = fakePodman({ startState: "exited", exitCode: 4 });
  const client = await fake.client(stateRoot);
  const result = await startSession({
    name: "pi-task",
    spec: spec(project, {
      network: "pasta",
      command: ["pi", "--model", "openai-codex/example", "--print", "offline"],
    }),
    detached: true,
    client,
    stateRoot,
    prepareHandoff: (context) =>
      prepareSecretFixture({ ...context, sourcePath }),
  });
  expect(result.state).toBe("exited");
  const create = fake.calls.find((call) => call.args[0] === "create")!;
  const mountArgument =
    create.args[
      create.args.indexOf("--volume", create.args.indexOf("--volume") + 1) + 1
    ];
  expect(mountArgument).toContain(
    ":/home/session/.config/harness/credentials:rw",
  );
  expect(JSON.stringify(create.args).includes("synthetic-offline-only")).toBe(
    false,
  );
  expect(JSON.stringify(create.env).includes("synthetic-offline-only")).toBe(
    false,
  );
  const record = (
    await getSessionStatus({ name: "pi-task", client, stateRoot })
  ).record;
  expect(record.resources).toEqual([]);
  await expect(
    readFile(
      join(
        stateRoot,
        "resources",
        record.id,
        "pi-auth",
        "payload",
        "auth.json",
      ),
      "utf8",
    ),
  ).rejects.toThrow();
  expect(
    JSON.parse(await readFile(sourcePath, "utf8"))["openai-codex"].access ===
      "synthetic-offline-only",
  ).toBe(true);
});

test("offline command sessions can stage explicitly selected secrets", async () => {
  const { root, project, stateRoot } = await fixture();
  const sourcePath = join(root, "auth.json");
  await writeFile(
    sourcePath,
    JSON.stringify({ "openai-codex": { type: "oauth", access: "offline" } }),
    { mode: 0o600 },
  );
  const fake = fakePodman({ startState: "exited" });
  const result = await startSession({
    name: "offline-pi",
    spec: spec(project, { command: ["pi", "--version"] }),
    detached: true,
    client: await fake.client(stateRoot),
    stateRoot,
    prepareHandoff: (context) =>
      prepareSecretFixture({ ...context, sourcePath }),
  });
  expect(result.state).toBe("exited");
  const create = fake.calls.find((call) => call.args[0] === "create")!;
  expect(create.args).toContain("none");
  expect(
    create.args.some((argument) =>
      argument.includes(":/home/session/.config/harness/credentials:rw"),
    ),
  ).toBe(true);
});
