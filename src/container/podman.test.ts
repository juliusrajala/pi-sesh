import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveSpec } from "../config/config";
import {
  buildHostEnvironment,
  buildProjectImage,
  bunProcessRunner,
  PodmanClient,
  type CommandResult,
  type ProcessRunner,
} from "./podman";

const directories: string[] = [];
const oldImageId = "a".repeat(64);
const newImageId = "b".repeat(64);
const temporaryTagPattern = /^localhost\/pi-sesh-intermediate:/;

async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), "pi-sesh podman "));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("process runner forwards output chunks while it captures command output", async () => {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const result = await bunProcessRunner(
    [
      process.execPath,
      "-e",
      'process.stdout.write("out"); process.stderr.write("err");',
    ],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: "pipe",
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    },
  );
  expect(result).toMatchObject({ status: 0, stdout: "out", stderr: "err" });
  expect(new TextDecoder().decode(Buffer.concat(stdoutChunks))).toBe("out");
  expect(new TextDecoder().decode(Buffer.concat(stderrChunks))).toBe("err");
});

function podmanInfo(overrides: Record<string, unknown> = {}) {
  return {
    host: {
      security: { rootless: true },
      serviceIsRemote: false,
      cgroupVersion: "v2",
      cgroupControllers: ["memory", "pids"],
      rootlessNetworkCmd: "pasta",
    },
    version: { Version: "6.1.1", OsArch: "linux/amd64" },
    ...overrides,
  };
}

function result(status = 0, stdout = "", stderr = ""): CommandResult {
  return { status, stdout, stderr };
}

async function client(runner: ProcessRunner, extraEnv: NodeJS.ProcessEnv = {}) {
  return PodmanClient.create({
    executable: "/usr/bin/podman",
    source: {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp",
      XDG_DATA_HOME: "/tmp/pi-sesh-test-data",
      ...extraEnv,
    },
    runner,
  });
}

function spec(
  projectDir: string,
  image = "localhost/example:local",
): EffectiveSpec {
  return {
    projectDir,
    image,
    build: { context: projectDir, file: join(projectDir, "Containerfile") },
    workspace: "mount",
    command: ["true"],
    network: "none",
  };
}

test("host Podman environment contains only allowlisted variables", async () => {
  const { env, path } = await buildHostEnvironment({
    source: {
      PATH: "/usr/bin:/bin:relative",
      HOME: "/tmp",
      HTTPS_PROXY: "synthetic-secret",
      OPENAI_API_KEY: "synthetic-secret",
      DOCKER_HOST: undefined,
      XDG_RUNTIME_DIR: "/run/user/1000",
      TERM: "xterm-256color",
    },
  });
  expect(path).toContain("/usr/bin");
  expect(env).toEqual({
    PATH: path,
    HOME: "/tmp",
    XDG_RUNTIME_DIR: "/run/user/1000",
    TERM: "xterm-256color",
  });
  expect(Object.keys(env)).not.toContain("HTTPS_PROXY");
});

test("remote engine overrides and relative state paths fail closed", async () => {
  await expect(
    buildHostEnvironment({
      source: { PATH: "/usr/bin", DOCKER_HOST: "tcp://remote.invalid" },
    }),
  ).rejects.toThrow("Unsupported remote container configuration");
  await expect(
    buildHostEnvironment({
      source: { PATH: "/usr/bin", HOME: "relative-home" },
    }),
  ).rejects.toThrow("HOME must be an absolute path");
});

test("preflight selects the local rootless engine and validates supported baseline", async () => {
  const seen: string[][] = [];
  const podman = await client(async (argv, options) => {
    seen.push(argv);
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/podman", "--remote=false"]);
    expect(options.env).not.toHaveProperty("HTTPS_PROXY");
    return result(0, JSON.stringify(podmanInfo()));
  });
  expect(await podman.preflight("pasta")).toEqual({
    version: "6.1.1",
    imageArch: "linux/amd64",
    selinuxEnabled: false,
  });
  expect(seen[0]).toContain("info");
});

test("preflight rejects non-rootless, remote, old, and unsupported cgroup hosts", async () => {
  const cases = [
    {
      info: podmanInfo({
        host: {
          security: { rootless: false },
          cgroupVersion: "v2",
          cgroupControllers: ["memory", "pids"],
        },
      }),
      error: "local rootless",
    },
    {
      info: podmanInfo({ version: { Version: "6.0.9" } }),
      error: "6.1.1 or later",
    },
    {
      info: podmanInfo({
        host: {
          security: { rootless: true },
          cgroupVersion: "v1",
          cgroupControllers: ["memory", "pids"],
        },
      }),
      error: "cgroup v2",
    },
    {
      info: podmanInfo({
        host: {
          security: { rootless: true },
          cgroupVersion: "v2",
          cgroupControllers: ["memory"],
        },
      }),
      error: "memory and PID controllers",
    },
  ];
  for (const item of cases) {
    const podman = await client(async () =>
      result(0, JSON.stringify(item.info)),
    );
    await expect(podman.preflight()).rejects.toThrow(item.error);
  }
});

test("image existence engine errors are not treated as absence", async () => {
  const podman = await client(async (argv) =>
    argv.slice(2)[0] === "image"
      ? result(125, "", "engine unavailable")
      : result(),
  );
  await expect(podman.imageExists("localhost/example:local")).rejects.toThrow(
    "could not determine whether image",
  );
});

test("build error remains primary when image cleanup fails and auth temp cleanup is still attempted", async () => {
  const root = await tempDir();
  let temporaryTag = "";
  let authFile = "";
  const runner: ProcessRunner = async (argv) => {
    const args = argv.slice(2);
    if (args[0] === "info") return result(0, JSON.stringify(podmanInfo()));
    if (args[0] === "image" && args[1] === "exists")
      return result(args[2] === temporaryTag && temporaryTag ? 0 : 1);
    if (args[0] === "build") {
      temporaryTag = args[args.indexOf("--tag") + 1]!;
      authFile = args[args.indexOf("--authfile") + 1]!;
      return result(125, "", "synthetic build failure");
    }
    if (args[0] === "image" && args[1] === "rm")
      return result(125, "", "synthetic cleanup failure");
    throw new Error(`Unexpected Podman call: ${args.join(" ")}`);
  };
  const podman = await client(runner, { HOME: root, XDG_DATA_HOME: root });
  await expect(
    buildProjectImage(spec(root), { client: podman, pullMissingBases: true }),
  ).rejects.toThrow(
    /Podman build failed.*cleanup also failed.*Unable to clean/,
  );
  expect(authFile).not.toBe("");
  await expect(readFile(authFile, "utf8")).rejects.toThrow();
});

test("failed local-only build leaves the previous output tag unchanged", async () => {
  const tags = new Map([["localhost/example:local", oldImageId]]);
  let buildArgs: string[] | undefined;
  const runner: ProcessRunner = async (argv, options) => {
    const args = argv.slice(2);
    if (args[0] === "info") return result(0, JSON.stringify(podmanInfo()));
    if (args[0] === "image" && args[1] === "exists")
      return result(tags.has(args[2]!) ? 0 : 1);
    if (args[0] === "image" && args[1] === "inspect")
      return result(0, `${tags.get(args.at(-1)!) ?? ""}\n`);
    if (args[0] === "build") {
      buildArgs = args;
      expect(options.stdio).toBe("inherit");
      return result(125);
    }
    if (args[0] === "image" && args[1] === "rm") {
      tags.delete(args.at(-1)!);
      return result();
    }
    throw new Error(`Unexpected Podman call: ${args.join(" ")}`);
  };
  const podman = await client(runner);
  await expect(
    buildProjectImage(spec("/tmp/fixture"), { client: podman }),
  ).rejects.toThrow("Podman build failed");
  expect(tags.get("localhost/example:local")).toBe(oldImageId);
  expect(buildArgs).toContain("--pull=never");
  expect(buildArgs).toContain("--http-proxy=false");
  expect(buildArgs).toContain("--network=pasta");
  expect(
    buildArgs?.some((argument) => argument.startsWith("--build-arg")),
  ).toBe(false);
  expect([...tags.keys()].some((name) => temporaryTagPattern.test(name))).toBe(
    false,
  );
});

test("successful build retags the validated image ID and removes only its temporary tag", async () => {
  const tags = new Map([["localhost/example:local", oldImageId]]);
  const runner: ProcessRunner = async (argv) => {
    const args = argv.slice(2);
    if (args[0] === "info") return result(0, JSON.stringify(podmanInfo()));
    if (args[0] === "image" && args[1] === "exists")
      return result(tags.has(args[2]!) ? 0 : 1);
    if (args[0] === "image" && args[1] === "inspect")
      return result(0, `${tags.get(args.at(-1)!) ?? ""}\n`);
    if (args[0] === "build") {
      const tag = args[args.indexOf("--tag") + 1]!;
      tags.set(tag, newImageId);
      return result();
    }
    if (args[0] === "image" && args[1] === "tag") {
      tags.set(args[3]!, tags.get(args[2]!) ?? args[2]!);
      return result();
    }
    if (args[0] === "image" && args[1] === "rm") {
      tags.delete(args.at(-1)!);
      return result();
    }
    throw new Error(`Unexpected Podman call: ${args.join(" ")}`);
  };
  const built = await buildProjectImage(spec("/tmp/fixture"), {
    client: await client(runner),
  });
  expect(built).toEqual({
    tag: "localhost/example:local",
    imageId: newImageId,
    podmanVersion: "6.1.1",
  });
  expect(tags.get("localhost/example:local")).toBe(newImageId);
  expect([...tags.keys()].some((name) => temporaryTagPattern.test(name))).toBe(
    false,
  );
});

test("explicit public pulls use a private empty auth file and clean it afterward", async () => {
  const root = await tempDir();
  const env = { PATH: "/usr/bin:/bin", HOME: root, XDG_DATA_HOME: root };
  const tags = new Map<string, string>();
  let authFile = "";
  const runner: ProcessRunner = async (argv) => {
    const args = argv.slice(2);
    if (args[0] === "info") return result(0, JSON.stringify(podmanInfo()));
    if (args[0] === "image" && args[1] === "exists")
      return result(tags.has(args[2]!) ? 0 : 1);
    if (args[0] === "image" && args[1] === "inspect")
      return result(0, `${tags.get(args.at(-1)!) ?? ""}\n`);
    if (args[0] === "build") {
      const index = args.indexOf("--authfile");
      authFile = args[index + 1]!;
      expect(await readFile(authFile, "utf8")).toBe('{"auths":{}}\n');
      expect((await stat(authFile)).mode & 0o777).toBe(0o600);
      tags.set(args[args.indexOf("--tag") + 1]!, newImageId);
      expect(args).toContain("--pull=missing");
      return result();
    }
    if (args[0] === "image" && args[1] === "tag") {
      tags.set(args[3]!, tags.get(args[2]!) ?? args[2]!);
      return result();
    }
    if (args[0] === "image" && args[1] === "rm") {
      tags.delete(args.at(-1)!);
      return result();
    }
    throw new Error(`Unexpected Podman call: ${args.join(" ")}`);
  };
  const podman = await PodmanClient.create({
    executable: "/usr/bin/podman",
    source: env,
    runner,
  });
  await buildProjectImage(spec(root), {
    client: podman,
    pullMissingBases: true,
  });
  await expect(readFile(authFile, "utf8")).rejects.toThrow();
});
