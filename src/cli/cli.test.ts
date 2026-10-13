import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Crust } from "@crustjs/core";
import { renderHelp } from "@crustjs/plugins";
import packageInfo from "../../package.json";
import { createCli, runCli, type CliDependencies } from "./cli";
import { setupPrompt } from "./setup-prompt";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(config?: unknown) {
  const path = await mkdtemp(join(tmpdir(), "pi-sesh cli "));
  directories.push(path);
  if (config)
    await Bun.write(join(path, "pi-sesh.json"), JSON.stringify(config));
  return path;
}
async function execute(
  argv: string[],
  dependencies: CliDependencies = {},
  terminal: { isTTY?: boolean; noColor?: string; term?: string } = {},
) {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY",
  );
  const savedEnvironment = {
    NO_COLOR: process.env.NO_COLOR,
    TERM: process.env.TERM,
  };
  Object.defineProperty(process.stdout, "isTTY", {
    value: terminal.isTTY ?? false,
    configurable: true,
  });
  for (const [name, value] of Object.entries({
    NO_COLOR: terminal.noColor,
    TERM: terminal.term,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  const stdout: string[] = [],
    stderr: string[] = [];
  const log = console.log,
    error = console.error,
    code = process.exitCode;
  console.log = (...values) => {
    stdout.push(values.join(" "));
  };
  console.error = (...values) => {
    stderr.push(values.join(" "));
  };
  process.exitCode = 0;
  try {
    await runCli(argv, dependencies);
    return {
      code: process.exitCode,
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = code;
    if (ttyDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}
const preset = {
  image: "localhost/user:local",
  command: ["agent"],
  workspace: "clone" as const,
  network: "none" as const,
};
function launchDependencies(
  project: string,
  capture: (
    options: Parameters<NonNullable<CliDependencies["startSession"]>>[0],
  ) => void,
): CliDependencies {
  return {
    currentDirectory: () => project,
    loadLaunchPreset: async () => preset,
    startSession: async (options) => {
      capture(options);
      return {
        id: "id",
        name: options.name,
        containerId: "b".repeat(64),
        state: "exited",
        exitCode: 23,
        detached: Boolean(options.detached),
      };
    },
  };
}

test("help and version bypass all handlers and required arguments", async () => {
  const commands = [
    "init",
    "clean",
    "stop-all",
    "setup-prompt",
    "build",
    "start",
    "open",
    "exec",
    "launch",
    "list",
    "inspect",
    "attach",
    "logs",
    "stop",
    "remove",
  ];
  const dependencies: CliDependencies = {
    loadLaunchPreset: async () => {
      throw new Error("must not load");
    },
  };
  for (const command of commands) {
    const help = await execute([command, "--help"], dependencies);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(`USAGE:\n  pi-sesh ${command}`);
    expect(help.stderr).toBe("");
    expect((await execute([command, "--version"], dependencies)).stdout).toBe(
      `pi-sesh ${packageInfo.version}`,
    );
  }
  const help = await execute(["-h"]);
  expect(help.stdout).toContain("<command|preset>");
  expect(help.stdout).not.toContain("pi [project]");
  expect((await execute(["--version"])).stdout).toBe(
    `pi-sesh ${packageInfo.version}`,
  );
});

test("default help matches explicit help", async () => {
  const help = await execute(["--help"]);
  expect(await execute([])).toEqual(help);
  expect(await execute(["-h"])).toEqual(help);
});

test("help uses the supported Crust renderer", async () => {
  const { root } = await createCli().prepareCommandTree();
  for (const name of [undefined, ...Object.keys(root.subCommands)]) {
    const command = name ? root.subCommands[name]! : root;
    const help = await execute(name ? [name, "--help"] : ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).not.toContain("\t");
    expect(help.stdout).toBe(
      Bun.stripANSI(
        renderHelp(command, name ? ["pi-sesh", name] : ["pi-sesh"]),
      ),
    );
  }
});

test("terminal help adds color without changing text or alignment", async () => {
  for (const argv of [[], ["--help"], ["launch", "--help"]]) {
    const plain = await execute(argv);
    const colored = await execute(argv, {}, { isTTY: true, term: "xterm" });
    expect(plain.stdout).not.toContain("\x1b[");
    expect(colored.stdout).toContain("\x1b[");
    expect(colored.stdout).toContain("\x1b[36m-h, --help\x1b[39m");
    expect(Bun.stripANSI(colored.stdout)).toBe(plain.stdout);
    expect(colored.stderr).toBe("");
    expect(colored.code).toBe(0);
  }
  const help = await execute(["--help"], {}, { isTTY: true });
  expect(help.stdout).toContain("\x1b[32mlaunch\x1b[39m");
});

test("help stays plain for pipes, NO_COLOR, and dumb terminals", async () => {
  const plain = await execute(["--help"]);
  for (const terminal of [
    { isTTY: false, term: "xterm" },
    { isTTY: true, noColor: "1", term: "xterm" },
    { isTTY: true, noColor: "", term: "xterm" },
    { isTTY: true, term: "dumb" },
  ]) {
    expect(await execute(["--help"], {}, terminal)).toEqual(plain);
  }
});

test("color does not change version or setup-prompt output", async () => {
  for (const argv of [["--version"], ["setup-prompt"]]) {
    const plain = await execute(argv);
    expect(await execute(argv, {}, { isTTY: true, term: "xterm" })).toEqual(
      plain,
    );
    expect(plain.stdout).not.toContain("\x1b[");
  }
});

test("setup-prompt prints instructions for the caller folder without loading presets or containers", async () => {
  const folder = '/tmp/folder with spaces/"quoted"\nnot an instruction';
  const unexpected = async () => {
    throw new Error("Setup must only print instructions");
  };
  const result = await execute(["setup-prompt"], {
    currentDirectory: () => folder,
    loadLaunchPreset: unexpected,
    preparePresetHandoff: unexpected,
    startSession: unexpected,
    buildImage: unexpected,
  });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(setupPrompt(folder));
  expect(result.stdout).toContain(JSON.stringify(folder));
  expect(result.stdout).toContain("Use the installed pi-sesh CLI");
  expect(result.stdout).toContain(
    "Ask for approval before you install software or change files",
  );
  expect(result.stdout).not.toContain("bun run build");
});

test("setup-prompt reuses shared agent setup instead of requiring a new agent per project", () => {
  for (const folder of ["/projects/one", "/projects/two"]) {
    const prompt = setupPrompt(folder);
    expect(prompt).toContain("Agent setup is user-wide and is done once.");
    expect(prompt).toContain(
      "Do not create an agent or a user preset for each project.",
    );
    expect(prompt).toContain(
      "Reuse the user's selected preset and its existing preparation command.",
    );
    expect(prompt).toContain(
      "If a suitable preset exists, skip the one-time agent setup section below.",
    );
    expect(prompt).toContain(
      "This file belongs in the target folder, not in the pi-sesh source checkout.",
    );
    expect(prompt.indexOf("## Project setup")).toBeLessThan(
      prompt.indexOf("## One-time user-wide agent setup"),
    );
  }
});

test("the same shared prepared preset launches projects with different development images", async () => {
  const shared = {
    command: ["/home/session/runtime/agent/agent"],
    workspace: "clone" as const,
    network: "none" as const,
    prepare: ["/trusted/user-prepare"],
  };
  const loadedNames: string[] = [],
    images: string[] = [];
  for (const image of [
    "localhost/project-one:dev",
    "localhost/project-two:dev",
  ]) {
    const project = await fixture({ version: 1, image });
    const dependencies = launchDependencies(project, (options) => {
      images.push(options.spec.image);
      expect(options.spec.command).toEqual([...shared.command, "--version"]);
    });
    dependencies.loadLaunchPreset = async (name) => {
      loadedNames.push(name);
      return shared;
    };
    dependencies.preparePresetHandoff = async (preset) => {
      expect(preset).toBe(shared);
      return undefined;
    };
    expect(
      (await execute(["launch", "agent", "--", "--version"], dependencies))
        .code,
    ).toBe(23);
  }
  expect(loadedNames).toEqual(["agent", "agent"]);
  expect(images).toEqual([
    "localhost/project-one:dev",
    "localhost/project-two:dev",
  ]);
});

test("setup-prompt works with piped stdout outside any source checkout", async () => {
  const folder = await fixture();
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      resolve(import.meta.dir, "../main.ts"),
      "setup-prompt",
    ],
    cwd: folder,
    env: {
      PATH: "/nonexistent",
      HOME: folder,
      XDG_CONFIG_HOME: "/nonexistent",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe(`${setupPrompt(folder)}\n`);
});

test("short preset dispatch uses the same generic launch path", async () => {
  const names: string[] = [];
  const dependencies = launchDependencies(await fixture(), (options) => {
    expect(options.spec.command).toEqual(["agent", "--version"]);
  });
  dependencies.loadLaunchPreset = async (name) => {
    names.push(name);
    return preset;
  };
  for (const name of ["pi", "another-agent"]) {
    expect((await execute([name, "--", "--version"], dependencies)).code).toBe(
      23,
    );
  }
  expect(names).toEqual(["pi", "another-agent"]);
  for (const argv of [
    ["pi", "--auth-file", "/tmp/auth"],
    ["launch", "pi", "--auth-file", "/tmp/auth"],
  ]) {
    expect((await execute(argv, dependencies)).code).toBe(1);
  }
});

test("CLI rejects unknown flags, missing positionals, and argv without --", async () => {
  expect((await execute(["build", "--not-a-flag"])).code).toBe(1);
  expect((await execute(["build"])).stderr).toContain("project");
  expect((await execute(["launch", "shell", "argv"])).stderr).toContain(
    "after --",
  );
});

test("build forwards validated image, recipe, context, and pull option", async () => {
  const project = await fixture();
  await Bun.write(join(project, "Containerfile"), "FROM scratch\n");
  const result = await execute(
    [
      "build",
      project,
      "--image",
      "localhost/test:local",
      "--context",
      ".",
      "--file",
      "Containerfile",
      "--pull",
    ],
    {
      buildImage: async (spec, options) => {
        expect(spec.build?.file).toBe(join(project, "Containerfile"));
        expect(options?.pullMissingBases).toBe(true);
        return {
          tag: spec.image,
          imageId: "a".repeat(64),
          podmanVersion: "6.1.1",
        };
      },
    },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Built localhost/test:local");
});

test("start accepts literal argv and an explicit handoff", async () => {
  const project = await fixture();
  const result = await execute(
    [
      "start",
      project,
      "--name",
      "literal",
      "--image",
      "localhost/test:local",
      "--handoff",
      "/selected/handoff.json",
      "--",
      "sh",
      "-c",
      "printf '$HOME'",
    ],
    {
      startSession: async (options) => {
        expect(options.spec.command).toEqual(["sh", "-c", "printf '$HOME'"]);
        expect(options.handoffManifestPath).toBe("/selected/handoff.json");
        return {
          id: "id",
          name: options.name,
          containerId: "b".repeat(64),
          state: "exited",
          exitCode: 17,
          detached: false,
        };
      },
    },
  );
  expect(result.code).toBe(17);
});

test("launch generates identity, preserves argv, and keeps diagnostics off stdout", async () => {
  const project = await fixture();
  let received:
    | Parameters<NonNullable<CliDependencies["startSession"]>>[0]
    | undefined;
  const result = await execute(
    ["launch", "pi", "--", "--mode", "rpc", "$HOME; two words"],
    launchDependencies(project, (options) => {
      received = options;
    }),
  );
  expect(result.code).toBe(23);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Preset pi session");
  expect(received?.name).toMatch(/^pi-[0-9a-f]{32}$/);
  expect(received?.spec.command).toEqual([
    "agent",
    "--mode",
    "rpc",
    "$HOME; two words",
  ]);
  expect(received?.spec.workspace).toBe("clone");
  expect(received?.spec.network).toBe("none");
  expect(received?.tty).toBe(false);
  expect(received?.signal).toBeInstanceOf(AbortSignal);
});

test("launch combines static and prepared runtime mounts and cleans preparation", async () => {
  const project = await fixture({
    version: 1,
    image: "localhost/project:dev",
    command: ["untrusted"],
    build: { context: "missing", file: "missing" },
    network: "pasta",
  });
  const mounts = [
    { source: "/selected/agent", destination: "/home/session/runtime/agent" },
  ];
  let cleaned = false;
  const dependencies = launchDependencies(project, (options) => {
    expect(options.spec.image).toBe("localhost/project:dev");
    expect(options.spec.command).toEqual(["agent"]);
    expect(options.spec.build).toBeUndefined();
    expect(options.spec.network).toBe("none");
    expect(options.runtimeMounts).toEqual([
      ...mounts,
      { source: "/selected/lib", destination: "/home/session/runtime/lib" },
    ]);
    expect(options.handoffManifestPath).toBe("/private/handoff.json");
    expect(options.tty).toBe(true);
    expect(options.detached).toBe(true);
  });
  dependencies.loadLaunchPreset = async () => ({
    command: ["agent"],
    workspace: "clone",
    network: "none",
    prepare: ["/trusted/prepare"],
    runtime: mounts,
  });
  dependencies.preparePresetHandoff = async () => ({
    directory: "/private",
    manifestPath: "/private/handoff.json",
    runtimeMounts: [
      { source: "/selected/lib", destination: "/home/session/runtime/lib" },
    ],
  });
  dependencies.cleanupPresetHandoff = async () => {
    cleaned = true;
  };
  const result = await execute(
    ["launch", "any-agent", "--detach", "--tty"],
    dependencies,
  );
  expect(result.code).toBe(0);
  expect(cleaned).toBe(true);
  expect(result.stdout).toBe("");
});

test("image-pinned prepared presets require explicit approval for a different project image", async () => {
  const project = await fixture({ version: 1, image: "localhost/project:dev" });
  let prepared = 0;
  const dependencies = launchDependencies(project, (options) => {
    expect(options.spec.image).toBe("localhost/confirmed:dev");
  });
  dependencies.loadLaunchPreset = async () => ({
    ...preset,
    prepare: ["/trusted/prepare"],
  });
  dependencies.preparePresetHandoff = async () => {
    prepared++;
    return undefined;
  };
  expect((await execute(["launch", "agent"], dependencies)).stderr).toContain(
    "cannot select an image",
  );
  expect(prepared).toBe(0);
  expect(
    (
      await execute(
        ["launch", "agent", "--image", "localhost/confirmed:dev"],
        dependencies,
      )
    ).code,
  ).toBe(23);
  expect(prepared).toBe(1);
});

test("preset, project, and CLI literal environments use safe precedence", async () => {
  const project = await fixture({
    version: 1,
    image: "localhost/project:dev",
    workspace: "mount",
    environment: { NODE_ENV: "project", PROJECT_PROFILE: "literal" },
  });
  const dependencies = launchDependencies(project, (options) => {
    expect(options.spec.environment).toEqual({
      NODE_ENV: "cli",
      PROJECT_PROFILE: "literal",
      USER_PROFILE: "$HOME",
    });
    expect(options.spec.workspace).toBe("clone");
    expect(options.spec.network).toBe("pasta");
  });
  dependencies.loadLaunchPreset = async () => ({
    ...preset,
    environment: { NODE_ENV: "user", USER_PROFILE: "$HOME" },
  });
  const result = await execute(
    [
      "launch",
      "agent",
      "--workspace",
      "clone",
      "--network",
      "pasta",
      "--env",
      "NODE_ENV=cli",
    ],
    dependencies,
  );
  expect(result.code).toBe(23);
});

test("reserved, secret-like, and duplicate CLI environment names fail before preparation", async () => {
  for (const values of [
    ["HOME=/tmp"],
    ["OPENAI_API_KEY=fake"],
    ["NODE_ENV=one", "NODE_ENV=two"],
  ]) {
    let prepared = false;
    const result = await execute(
      ["launch", "agent", ...values.flatMap((value) => ["--env", value])],
      {
        loadLaunchPreset: async () => preset,
        preparePresetHandoff: async () => {
          prepared = true;
          return undefined;
        },
      },
    );
    expect(result.code).toBe(1);
    expect(prepared).toBe(false);
  }
});

test("missing presets and failed cleanup report errors without protocol output", async () => {
  const missing = await execute(["launch", "missing"], {
    loadLaunchPreset: async () => {
      throw new Error("No selected preset");
    },
  });
  expect(missing.code).toBe(1);
  expect(missing.stdout).toBe("");
  const dependencies = launchDependencies(await fixture(), () => {});
  dependencies.preparePresetHandoff = async () => ({
    directory: "/private/recovery",
    manifestPath: "/private/recovery/handoff.json",
  });
  dependencies.cleanupPresetHandoff = async () => {
    throw new Error("cleanup");
  };
  const result = await execute(["launch", "agent"], dependencies);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("/private/recovery");
});

test("open returns an isolated offline environment descriptor", async () => {
  const project = await fixture({
    version: 1,
    image: "localhost/project:dev",
    workspace: "mount",
    network: "pasta",
    command: ["untrusted"],
  });
  const id = "88888888-8888-4888-8888-888888888888";
  let handoff: string | undefined;
  const dependencies: CliDependencies = {
    startSession: async (options) => {
      handoff = options.handoffManifestPath;
      expect(options.spec.workspace).toBe("clone");
      expect(options.spec.network).toBe("none");
      expect(options.spec.command?.[0]).toBe("/bin/sh");
      return {
        id,
        name: "dev",
        containerId: "b".repeat(64),
        state: "running",
        detached: true,
      };
    },
    getSessionStatus: async () => ({
      record: {
        version: 1,
        id,
        name: "dev",
        containerId: "b".repeat(64),
        containerName: `pi-sesh-${id}`,
        projectDir: project,
        workspacePath: "/owned/clone",
        workspaceMode: "clone",
        imageId: "a".repeat(64),
        network: "none",
        tty: false,
        createdAt: "now",
      },
      status: { state: "running" },
    }),
  };
  const result = await execute(
    ["open", project, "--name", "dev"],
    dependencies,
  );
  expect(JSON.parse(result.stdout).workspacePath).toBe("/owned/clone");
  expect(handoff).toBeUndefined();
  const staged = await execute(
    ["open", project, "--name", "dev", "--handoff", "/private/handoff.json"],
    dependencies,
  );
  expect(staged.code).toBe(0);
  expect(handoff).toBe("/private/handoff.json");
});

test("stop and remove accept an optional immutable session identity", async () => {
  for (const action of ["stop", "remove"]) {
    let identity: string | undefined;
    const dependencies: CliDependencies = {
      stopSession: async (options) => {
        identity = options.sessionId;
        return { state: "exited" };
      },
      removeSession: async (options) => {
        identity = options.sessionId;
      },
    };
    expect(
      (
        await execute(
          [action, "dev", "--session-id", "expected-id"],
          dependencies,
        )
      ).code,
    ).toBe(0);
    expect(identity).toBe("expected-id");
    expect((await execute([action, "dev"], dependencies)).code).toBe(0);
    expect(identity).toBeUndefined();
  }
});

test("exec forwards stdin and literal argv with immutable identity", async () => {
  const result = await execute(
    [
      "exec",
      "dev",
      "--session-id",
      "id",
      "--timeout",
      "12",
      "--",
      "printf",
      "$HOME; literal",
      "",
    ],
    {
      executeSession: async (options) => {
        expect(options.argv).toEqual(["printf", "$HOME; literal", ""]);
        expect(options.timeout).toBe(12);
        expect(options.stdin).toBe("inherit");
        return { status: 23, stdout: "", stderr: "" };
      },
    },
  );
  expect(result.code).toBe(23);
  expect(
    (await execute(["exec", "dev", "--session-id", "id"])).stderr,
  ).toContain("after --");
});

test("cleanup previews and applies only stopped sessions in the selected project", async () => {
  const project = await fixture(),
    other = await fixture();
  const rows = [
    {
      record: { name: "done", id: "done-id", projectDir: project },
      status: { state: "exited" },
    },
    {
      record: { name: "missing", id: "missing-id", projectDir: project },
      status: { state: "missing" },
    },
    {
      record: { name: "new", id: "new-id", projectDir: project },
      status: { state: "created" },
    },
    {
      record: { name: "live", id: "live-id", projectDir: project },
      status: { state: "running" },
    },
    {
      record: { name: "paused", id: "paused-id", projectDir: project },
      status: { state: "paused" },
    },
    {
      record: { name: "other", id: "other-id", projectDir: other },
      status: { state: "stopped" },
    },
  ];
  const removed: unknown[] = [];
  const dependencies: CliDependencies = {
    currentDirectory: () => project,
    listSessions: async () => rows as never,
    removeSession: async (options) => {
      removed.push(options);
    },
    stopSession: async () => {
      throw new Error("must not stop");
    },
    loadLaunchPreset: async () => {
      throw new Error("must not load");
    },
  };
  const preview = await execute(["clean"], dependencies);
  expect(preview.code).toBe(0);
  expect(preview.stdout).toContain("Preview: 3 session(s)");
  expect(preview.stdout).toContain("Removal deletes retained output");
  expect(preview.stdout).not.toContain("Remove other");
  expect(preview.stdout).not.toContain("Remove live");
  expect(removed).toEqual([]);
  expect((await execute(["clean", "--yes"], dependencies)).code).toBe(0);
  expect(removed).toEqual(
    ["done", "missing", "new"].map((name) => ({
      name,
      sessionId: `${name}-id`,
    })),
  );
  removed.length = 0;
  expect((await execute(["clean", other, "--yes"], dependencies)).code).toBe(0);
  expect(removed).toEqual([{ name: "other", sessionId: "other-id" }]);
  removed.length = 0;
  expect((await execute(["clean", "--all"], dependencies)).code).toBe(0);
  expect(removed).toEqual([]);
  expect((await execute(["clean", "--all", "--yes"], dependencies)).code).toBe(
    0,
  );
  expect(removed).toHaveLength(4);
  expect(
    (await execute(["clean", project, "--all", "--yes"], dependencies)).code,
  ).toBe(1);
});

test("bulk cleanup reports failures and continues with other selected sessions", async () => {
  const removed: string[] = [];
  const result = await execute(["clean", "--all", "--yes"], {
    currentDirectory: () => {
      throw new Error("global cleanup must not inspect cwd");
    },
    listSessions: async () =>
      ["bad", "good"].map((name) => ({
        record: { name, id: `${name}-id`, projectDir: "/gone" },
        status: { state: "missing" },
      })) as never,
    removeSession: async ({ name, sessionId }) => {
      expect(sessionId).toBe(`${name}-id`);
      if (name === "bad") throw new Error("Cannot verify container absence");
      removed.push(name);
    },
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Cannot verify container absence");
  expect(removed).toEqual(["good"]);
});

test("stop-all previews, scopes running sessions, and retains results", async () => {
  const project = await fixture(),
    other = await fixture();
  const stopped: unknown[] = [];
  const dependencies: CliDependencies = {
    currentDirectory: () => project,
    listSessions: async () =>
      [
        {
          record: { name: "live", id: "live-id", projectDir: project },
          status: { state: "running" },
        },
        {
          record: { name: "paused", id: "paused-id", projectDir: project },
          status: { state: "paused" },
        },
        {
          record: { name: "done", id: "done-id", projectDir: project },
          status: { state: "exited" },
        },
        {
          record: { name: "other", id: "other-id", projectDir: other },
          status: { state: "running" },
        },
      ] as never,
    stopSession: async (options) => {
      stopped.push(options);
      return { state: "exited" };
    },
    removeSession: async () => {
      throw new Error("must retain results");
    },
  };
  const preview = await execute(["stop-all"], dependencies);
  expect(preview.stdout).toContain("Skipped 1 paused");
  expect(preview.stdout).toContain("Stop live");
  expect(stopped).toEqual([]);
  expect((await execute(["stop-all", "--yes"], dependencies)).code).toBe(0);
  expect(stopped).toEqual([{ name: "live", sessionId: "live-id" }]);
  stopped.length = 0;
  expect(
    (await execute(["stop-all", "--all", "--yes"], dependencies)).code,
  ).toBe(0);
  expect(stopped).toEqual([
    { name: "live", sessionId: "live-id" },
    { name: "other", sessionId: "other-id" },
  ]);
});

test("init creates config without changing an existing project recipe", async () => {
  const project = await fixture();
  const recipe = "FROM docker.io/library/node:22-bookworm-slim\n";
  await Bun.write(join(project, "Containerfile"), recipe);
  const dependencies = { currentDirectory: () => project };
  expect((await execute(["init"], dependencies)).code).toBe(0);
  expect(await Bun.file(join(project, "Containerfile")).text()).toBe(recipe);
  const config = await Bun.file(join(project, "pi-sesh.json")).text();
  expect(JSON.parse(config)).toMatchObject({
    version: 1,
    build: { context: ".", file: "Containerfile" },
    workspace: "mount",
    network: "none",
  });
  expect((await execute(["init"], dependencies)).stdout).toContain(
    "Using existing",
  );
  expect(await Bun.file(join(project, "pi-sesh.json")).text()).toBe(config);
});

test("session list aligns columns and colors terminal statuses", async () => {
  const sessions = [
    {
      record: {
        name: "short",
        id: "a".repeat(36),
        projectDir: "/projects/one",
      },
      status: { state: "running" as const },
    },
    {
      record: {
        name: "a-longer-session",
        id: "b".repeat(36),
        projectDir: "/projects/two",
      },
      status: { state: "exited" as const, exitCode: 0 },
    },
    {
      record: {
        name: "failed",
        id: "c".repeat(36),
        projectDir: "/projects/three",
      },
      status: { state: "exited" as const, exitCode: 7 },
    },
    {
      record: {
        name: "lost",
        id: "d".repeat(36),
        projectDir: "/projects/four",
      },
      status: { state: "missing" as const },
    },
  ];
  const dependencies: CliDependencies = {
    listSessions: async () => sessions as never,
  };
  const plain = await execute(["list"], dependencies);
  expect(plain.stdout.split("\n")).toHaveLength(4);
  expect(plain.stdout.split("\n")[0]).toBe(
    `short\trunning\t-\t${"a".repeat(36)}\t"/projects/one"`,
  );
  expect(plain.stdout).not.toContain("\x1b[");

  const colored = await execute(["list"], dependencies, {
    isTTY: true,
    term: "xterm",
  });
  expect(colored.stdout).toContain("\x1b[1mNAME");
  expect(colored.stdout).toContain("\x1b[36mshort");
  expect(colored.stdout).toContain("\x1b[32mrunning");
  expect(colored.stdout).toContain("\x1b[32m0");
  expect(colored.stdout).toContain("\x1b[31m7");
  expect(colored.stdout).toContain("\x1b[31mmissing");
  const header = Bun.stripANSI(colored.stdout.split("\n")[0]!);
  expect(header).toContain("SESSION ID");
  expect(header).toContain("PROJECT FOLDER");
  expect(header.indexOf("PROJECT FOLDER")).toBeGreaterThan(
    header.indexOf("SESSION ID"),
  );
  expect(colored.stdout).toContain('"/projects/one"');
  expect(colored.stderr).toBe("");
});

test("session list is plain for NO_COLOR and empty on a terminal when there are no sessions", async () => {
  const dependencies: CliDependencies = { listSessions: async () => [] };
  const empty = await execute(["list"], dependencies, {
    isTTY: true,
    term: "xterm",
  });
  expect(empty.stdout).toBe("No sessions.");
  const plain = await execute(["list"], dependencies, {
    isTTY: true,
    noColor: "1",
    term: "xterm",
  });
  expect(plain.stdout).toBe("No sessions.");
  expect(plain.stdout).not.toContain("\x1b[");
});

test("lifecycle commands do not resolve presets", async () => {
  let attached = false;
  const result = await execute(["attach", "existing"], {
    loadLaunchPreset: async () => {
      throw new Error("must not load");
    },
    attachSession: async ({ name }) => {
      attached = name === "existing";
      return 0;
    },
  });
  expect(result.code).toBe(0);
  expect(attached).toBe(true);
});

test("CLI uses the Crust command tree", () => {
  expect(createCli()).toBeInstanceOf(Crust);
});
