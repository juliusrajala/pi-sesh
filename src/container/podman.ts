import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { PiSeshError } from "../errors";
import type { EffectiveSpec } from "../config/config";
import { ensureOwnedPrivateDirectory, isPathWithin } from "../path-utils";
import { readStreamBounded } from "../process-utils";

const HOST_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
] as const;
const ABSOLUTE_PATH_ENV = [
  "HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
] as const;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  argv: string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
    stdio?: "inherit" | "pipe";
    stdin?: "inherit" | Uint8Array;
    signal?: AbortSignal;
    onStdout?: (chunk: Uint8Array) => void;
    onStderr?: (chunk: Uint8Array) => void;
  },
) => Promise<CommandResult>;

export class ProcessError extends PiSeshError {
  readonly status: number;

  constructor(message: string, status: number) {
    super("PROCESS", message);
    this.name = "ProcessError";
    this.status = status;
  }
}

function fail(message: string, cause?: unknown): never {
  throw new PiSeshError(
    "PODMAN",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export const bunProcessRunner: ProcessRunner = async (argv, options) => {
  options.signal?.throwIfAborted();
  const proc = Bun.spawn({
    cmd: argv,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    stdin:
      options.stdin ?? (options.stdio === "inherit" ? "inherit" : "ignore"),
    stdout: options.stdio === "inherit" ? "inherit" : "pipe",
    stderr: options.stdio === "inherit" ? "inherit" : "pipe",
  });
  const abort = () => proc.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    if (options.stdio === "inherit")
      return { status: await proc.exited, stdout: "", stderr: "" };
    const [stdout, stderr, status] = await Promise.all([
      readStreamBounded(
        proc.stdout as ReadableStream<Uint8Array>,
        MAX_OUTPUT_BYTES,
        options.onStdout,
      ).then((output) => new TextDecoder().decode(output)),
      readStreamBounded(
        proc.stderr as ReadableStream<Uint8Array>,
        MAX_OUTPUT_BYTES,
        options.onStderr,
      ).then((output) => new TextDecoder().decode(output)),
      proc.exited,
    ]);
    return { status, stdout, stderr };
  } catch (error) {
    proc.kill();
    await proc.exited.catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
};

export async function buildHostEnvironment(
  options: { projectDir?: string; source?: NodeJS.ProcessEnv } = {},
): Promise<{
  env: Record<string, string>;
  path: string;
}> {
  const source = options.source ?? process.env;
  for (const name of [
    "CONTAINER_HOST",
    "CONTAINER_CONNECTION",
    "DOCKER_HOST",
  ]) {
    if (source[name])
      fail(
        `Unsupported remote container configuration is set (${name}); use the local rootless Podman engine`,
      );
  }
  const containerOverrides = Object.keys(source).filter((name) =>
    name.startsWith("CONTAINERS_"),
  );
  if (containerOverrides.length > 0) {
    fail(
      `Unsupported Podman environment override is set (${containerOverrides[0]}); unset it and retry`,
    );
  }

  const env: Record<string, string> = {};
  for (const name of HOST_ENV_ALLOWLIST) {
    const value = source[name];
    if (value === undefined) continue;
    if (
      ABSOLUTE_PATH_ENV.includes(name as (typeof ABSOLUTE_PATH_ENV)[number]) &&
      !isAbsolute(value)
    ) {
      fail(`${name} must be an absolute path`);
    }
    env[name] = value;
  }
  const rawPath = env.PATH ?? "/usr/bin:/bin";
  const safePath: string[] = [];
  const projectDir = options.projectDir
    ? await realpath(options.projectDir)
    : undefined;
  for (const entry of rawPath.split(delimiter).filter(isAbsolute)) {
    try {
      const canonical = await realpath(entry);
      if (!projectDir || !isPathWithin(projectDir, canonical))
        safePath.push(canonical);
    } catch {
      // Ignore nonexistent executable directories.
    }
  }
  env.PATH = safePath.join(delimiter) || "/usr/bin:/bin";
  return { env, path: env.PATH };
}

async function resolvePodman(
  projectDir?: string,
  source?: NodeJS.ProcessEnv,
): Promise<{ path: string; env: Record<string, string> }> {
  const { env, path } = await buildHostEnvironment({ projectDir, source });
  const executable = Bun.which("podman", { PATH: path });
  if (!executable || !isAbsolute(executable))
    fail("Podman is required; install Podman 6.1.1 or later");
  return { path: executable, env };
}

export class PodmanClient {
  readonly executable: string;
  readonly env: Record<string, string>;
  private readonly runner: ProcessRunner;

  private constructor(
    executable: string,
    env: Record<string, string>,
    runner: ProcessRunner,
  ) {
    this.executable = executable;
    this.env = env;
    this.runner = runner;
  }

  static async create(
    options: {
      projectDir?: string;
      source?: NodeJS.ProcessEnv;
      runner?: ProcessRunner;
      executable?: string;
    } = {},
  ): Promise<PodmanClient> {
    if (options.executable) {
      if (!isAbsolute(options.executable))
        fail("Podman executable must be an absolute path");
      const { env } = await buildHostEnvironment({
        projectDir: options.projectDir,
        source: options.source,
      });
      return new PodmanClient(
        options.executable,
        env,
        options.runner ?? bunProcessRunner,
      );
    }
    const resolved = await resolvePodman(options.projectDir, options.source);
    return new PodmanClient(
      resolved.path,
      resolved.env,
      options.runner ?? bunProcessRunner,
    );
  }

  async invoke(
    args: string[],
    options: {
      cwd?: string;
      stdio?: "inherit" | "pipe";
      stdin?: "inherit" | Uint8Array;
      signal?: AbortSignal;
      onStdout?: (chunk: Uint8Array) => void;
      onStderr?: (chunk: Uint8Array) => void;
    } = {},
  ): Promise<CommandResult> {
    return this.runner([this.executable, "--remote=false", ...args], {
      ...options,
      env: this.env,
    });
  }

  async checked(
    args: string[],
    options: { cwd?: string; stdio?: "inherit" | "pipe" } = {},
  ): Promise<CommandResult> {
    const result = await this.invoke(args, options);
    if (result.status !== 0)
      throw new ProcessError(
        `Podman ${args[0] ?? "command"} failed (exit ${result.status})`,
        result.status,
      );
    return result;
  }

  async preflight(
    network: "none" | "pasta" = "none",
  ): Promise<{ version: string; imageArch: string; selinuxEnabled: boolean }> {
    if (process.platform !== "linux" || process.arch !== "x64")
      fail("pi-sesh supports Linux x86-64 only");
    const result = await this.checked(["info", "--format", "json"]);
    let info: any;
    try {
      info = JSON.parse(result.stdout);
    } catch (cause) {
      fail("Podman returned invalid host information", cause);
    }
    const host = info.host;
    const version = info.version?.Version;
    if (typeof version !== "string" || compareVersion(version, "6.1.1") < 0) {
      fail("Podman 6.1.1 or later is required");
    }
    if (host?.security?.rootless !== true || host?.serviceIsRemote === true) {
      fail("A local rootless Podman engine is required");
    }
    if (host?.cgroupVersion !== "v2")
      fail("Rootless Podman with cgroup v2 is required");
    const controllers: string[] = host?.cgroupControllers ?? [];
    if (!controllers.includes("memory") || !controllers.includes("pids")) {
      fail(
        "Podman does not report required memory and PID controllers; refusing unrestricted sessions",
      );
    }
    if (
      network === "pasta" &&
      !host?.rootlessNetworkCmd?.toLowerCase().includes("pasta")
    ) {
      fail(
        "Rootless pasta networking was requested but Podman has no pasta backend",
      );
    }
    return {
      version,
      imageArch: info.version?.OsArch ?? "linux/amd64",
      selinuxEnabled: host?.security?.selinuxEnabled === true,
    };
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await this.invoke(["image", "exists", image]);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    fail(
      `Podman could not determine whether image ${image} exists (exit ${result.status})`,
    );
  }

  async imageId(image: string): Promise<string> {
    const result = await this.checked([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image,
    ]);
    const rawId = result.stdout.trim();
    const id = rawId.startsWith("sha256:")
      ? rawId.slice("sha256:".length)
      : rawId;
    if (!/^[0-9a-f]{64}$/i.test(id))
      fail("Podman returned an invalid immutable image ID");
    return id;
  }
}

function compareVersion(left: string, right: string): number {
  const leftCore = left.match(/^\d+(?:\.\d+)*/)?.[0];
  if (!leftCore) return -1;
  const a = leftCore.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function privateBuildDirectory(
  env: Record<string, string>,
): Promise<string> {
  const home = env.HOME;
  const dataHome =
    env.XDG_DATA_HOME || (home ? join(home, ".local", "share") : undefined);
  if (!dataHome || !isAbsolute(dataHome))
    fail(
      "HOME or absolute XDG_DATA_HOME is required for temporary build credentials",
    );
  const root = join(resolve(dataHome), "pi-sesh", "build-tmp");
  await ensureOwnedPrivateDirectory(
    root,
    "Build temporary directory has unexpected ownership or type",
    fail,
  );
  return mkdtemp(join(root, "build-"));
}

async function writeEmptyAuthFile(directory: string): Promise<string> {
  const authfile = join(directory, "auth.json");
  await writeFile(authfile, '{"auths":{}}\n', { mode: 0o600, flag: "wx" });
  return authfile;
}

async function rollbackTag(
  client: PodmanClient,
  oldId: string | undefined,
  tag: string,
): Promise<void> {
  if (oldId) {
    await client.checked(["image", "tag", oldId, tag]);
  } else {
    await client.checked(["image", "rm", "--force", tag]);
  }
}

export async function buildProjectImage(
  spec: EffectiveSpec,
  options: { pullMissingBases?: boolean; client?: PodmanClient } = {},
): Promise<{ tag: string; imageId: string; podmanVersion: string }> {
  if (!spec.build) fail("No build context and recipe were configured");
  const client =
    options.client ??
    (await PodmanClient.create({ projectDir: spec.projectDir }));
  const host = await client.preflight("pasta");
  const tag = `localhost/pi-sesh-intermediate:${randomUUID()}`;
  const oldId = (await client.imageExists(spec.image))
    ? await client.imageId(spec.image)
    : undefined;
  let buildTemp: string | undefined;
  let buildAttempted = false;
  let finalTagChanged = false;
  let primaryError: unknown;
  let built:
    | { tag: string; imageId: string; podmanVersion: string }
    | undefined;
  try {
    const args = [
      "build",
      "--file",
      spec.build.file,
      "--tag",
      tag,
      options.pullMissingBases ? "--pull=missing" : "--pull=never",
      "--http-proxy=false",
      "--network=pasta",
      "--jobs=1",
    ];
    if (options.pullMissingBases) {
      buildTemp = await privateBuildDirectory(client.env);
      const authfile = await writeEmptyAuthFile(buildTemp);
      args.push("--authfile", authfile);
    }
    args.push(spec.build.context);
    if (await client.imageExists(tag))
      fail("Temporary image tag collision; retry the build");
    buildAttempted = true;
    const buildResult = await client.invoke(args, { stdio: "inherit" });
    if (buildResult.status !== 0)
      throw new ProcessError(
        `Podman build failed (exit ${buildResult.status})`,
        buildResult.status,
      );
    const imageId = await client.imageId(tag);
    await client.checked(["image", "tag", tag, spec.image]);
    finalTagChanged = true;
    const outputId = await client.imageId(spec.image);
    if (outputId !== imageId)
      throw new PiSeshError(
        "PODMAN",
        "Output image tag did not resolve to the newly built image",
      );
    built = { tag: spec.image, imageId, podmanVersion: host.version };
  } catch (error) {
    primaryError = error;
    if (finalTagChanged) {
      try {
        await rollbackTag(client, oldId, spec.image);
      } catch {
        primaryError = new PiSeshError(
          "PODMAN",
          "Build failed and the previous image tag could not be restored",
          { cause: error },
        );
      }
    }
  }

  const cleanupErrors: unknown[] = [];
  if (buildAttempted) {
    try {
      if (await client.imageExists(tag)) {
        const cleanup = await client.invoke(["image", "rm", "--force", tag]);
        if (cleanup.status !== 0)
          throw new PiSeshError(
            "PODMAN",
            "Unable to clean the temporary build image tag",
          );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (buildTemp) {
    try {
      await rm(buildTemp, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0)
      throw new PiSeshError(
        "PODMAN",
        `Build failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}); cleanup also failed (${cleanupErrors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")})`,
        { cause: primaryError },
      );
    throw primaryError;
  }
  if (cleanupErrors.length > 0)
    fail(
      `Build succeeded but cleanup failed: ${cleanupErrors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
      cleanupErrors[0],
    );
  return built!;
}

export async function selectLocalImage(
  image: string,
  options: { client?: PodmanClient; projectDir?: string } = {},
): Promise<{ tag: string; imageId: string }> {
  const client =
    options.client ??
    (await PodmanClient.create({ projectDir: options.projectDir }));
  await client.preflight("none");
  if (!(await client.imageExists(image))) {
    fail(
      `Image ${image} is not present locally; run "pi-sesh build" or choose an existing local image`,
    );
  }
  return { tag: image, imageId: await client.imageId(image) };
}
