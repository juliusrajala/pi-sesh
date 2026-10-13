import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PiSeshError } from "../errors";
import { validateRuntimeMounts, type RuntimeMount } from "./runtime";
import {
  validateContainerEnvironment,
  validateImageReference,
} from "../config/config";

const CONFIG_LIMIT = 1024 * 1024;
const PREPARATION_PATH = "/usr/bin:/bin";
const RESERVED_NAMES = new Set([
  "init",
  "clean",
  "stop-all",
  "setup-prompt",
  "build",
  "open",
  "exec",
  "launch",
  "start",
  "list",
  "inspect",
  "attach",
  "logs",
  "stop",
  "remove",
]);

export type LaunchPreset = {
  image?: string;
  runtime?: RuntimeMount[];
  command: string[];
  workspace: "mount" | "clone";
  network: "none" | "pasta";
  environment?: Record<string, string>;
  prepare?: string[];
};

export type PreparedPresetHandoff = {
  directory: string;
  manifestPath: string;
  runtimeMounts?: RuntimeMount[];
};

function fail(message: string, cause?: unknown): never {
  throw new PiSeshError(
    "PRESET",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function stringArgv(value: unknown, label: string, maximum = 128): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximum ||
    value.some(
      (part) =>
        typeof part !== "string" ||
        part.length === 0 ||
        part.length > 8192 ||
        part.includes("\0"),
    )
  ) {
    return fail(`${label} must be a non-empty array of literal strings`);
  }
  return value as string[];
}

function validatePreset(value: unknown, name: string): LaunchPreset {
  const input = record(value, `Preset ${name}`);
  const allowed = new Set([
    "image",
    "command",
    "workspace",
    "network",
    "environment",
    "prepare",
    "runtime",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`Unsupported preset field: ${key}`);
  }
  const image =
    input.image === undefined ? undefined : validateImageReference(input.image);
  const runtime =
    input.runtime === undefined
      ? undefined
      : validateRuntimeMounts(input.runtime);
  const command = stringArgv(input.command, `Preset ${name} command`);
  if (input.workspace !== "mount" && input.workspace !== "clone")
    fail(`Preset ${name} workspace must be mount or clone`);
  if (input.network !== "none" && input.network !== "pasta")
    fail(`Preset ${name} network must be none or pasta`);
  const environment =
    input.environment === undefined
      ? undefined
      : validateContainerEnvironment(
          input.environment,
          `Preset ${name} environment`,
        );
  let prepare: string[] | undefined;
  if (input.prepare !== undefined) {
    prepare = stringArgv(input.prepare, `Preset ${name} prepare`);
    if (!isAbsolute(prepare[0]!))
      fail(`Preset ${name} prepare executable must use an absolute path`);
  }
  return {
    ...(image ? { image } : {}),
    ...(runtime ? { runtime } : {}),
    command,
    workspace: input.workspace,
    network: input.network,
    ...(environment ? { environment } : {}),
    ...(prepare ? { prepare } : {}),
  };
}

export function launchPresetsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configHome = env.XDG_CONFIG_HOME;
  const root =
    configHome && isAbsolute(configHome)
      ? configHome
      : join(homedir(), ".config");
  return join(root, "pi-sesh", "launchers.json");
}

async function readPrivateConfig(path: string): Promise<unknown> {
  const directory = dirname(path);
  let directoryInfo;
  try {
    directoryInfo = await lstat(directory);
  } catch (cause) {
    return fail(
      `No user launch preset file. Create ${path} with a private user preset.`,
      cause,
    );
  }
  if (
    directoryInfo.isSymbolicLink() ||
    !directoryInfo.isDirectory() ||
    directoryInfo.uid !== process.getuid?.() ||
    (directoryInfo.mode & 0o077) !== 0
  ) {
    fail(
      `Launch preset directory must be user-owned and private: ${directory}`,
    );
  }

  let before;
  try {
    before = await lstat(path);
  } catch (cause) {
    return fail(
      `No user launch preset file. Create ${path} with a private user preset.`,
      cause,
    );
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o077) !== 0 ||
    before.size > CONFIG_LIMIT
  ) {
    fail(
      "Launch preset file must be user-owned, private, regular, and bounded",
    );
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== process.getuid?.() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > CONFIG_LIMIT ||
      (opened.mode & 0o077) !== 0
    ) {
      fail("Launch preset changed while it was being read");
    }
    const bytes = await handle.readFile();
    if (bytes.length > CONFIG_LIMIT)
      fail(`Launch preset file exceeds ${CONFIG_LIMIT} bytes`);
    try {
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (cause) {
      return fail("Launch preset file must contain valid JSON", cause);
    }
  } finally {
    await handle?.close();
  }
}

export async function loadLaunchPreset(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LaunchPreset> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name))
    fail("Preset name must be a lowercase simple name");
  if (RESERVED_NAMES.has(name))
    fail(`Preset name is reserved by a pi-sesh lifecycle command: ${name}`);
  const path = launchPresetsPath(env);
  const value = record(await readPrivateConfig(path), "Launch preset file");
  if (Object.keys(value).some((key) => key !== "version" && key !== "presets"))
    fail("Launch preset file contains unsupported fields");
  if (value.version !== 1) fail("Launch preset file version must be 1");
  const presets = record(value.presets, "Launch presets");
  for (const presetName of Object.keys(presets)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(presetName))
      fail("Launch preset names must be lowercase simple names");
    if (RESERVED_NAMES.has(presetName))
      fail(
        `Launch preset name is reserved by a lifecycle command: ${presetName}`,
      );
  }
  const preset = presets[name];
  if (preset === undefined)
    fail(`No user launch preset named "${name}" exists in ${path}`);
  return validatePreset(preset, name);
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export function generatedSessionName(): string {
  return `pi-${randomUUID().replaceAll("-", "")}`;
}

export async function preparePresetHandoff(
  preset: LaunchPreset,
  sessionName: string,
  signal?: AbortSignal,
): Promise<PreparedPresetHandoff | undefined> {
  signal?.throwIfAborted();
  if (!preset.prepare) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "pi-sesh-preset-"));
  try {
    await chmod(directory, 0o700);
    const processHandle = Bun.spawn({
      cmd: preset.prepare,
      cwd: homedir(),
      env: {
        PATH: PREPARATION_PATH,
        HOME: homedir(),
        PI_SESH_PREPARE_DIR: directory,
        PI_SESH_SESSION_NAME: sessionName,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const abort = () => processHandle.kill();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let status: number;
    try {
      status = await processHandle.exited;
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    if (status !== 0)
      fail(`Trusted preset preparation command failed (exit ${status})`);

    const manifestPath = join(directory, "handoff.json");
    const info = await lstat(manifestPath).catch((cause) =>
      fail("Preset preparation did not create handoff.json", cause),
    );
    const canonicalDirectory = await realpath(directory);
    const canonicalManifest = await realpath(manifestPath);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      canonicalManifest !== manifestPath ||
      !within(canonicalDirectory, canonicalManifest)
    ) {
      fail(
        "Preset handoff manifest must be private and inside its prepare directory",
      );
    }
    const runtimePath = join(directory, "runtime.json");
    let runtimeMounts: RuntimeMount[] | undefined;
    const runtimeInfo = await lstat(runtimePath).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (runtimeInfo) {
      const value = record(
        await readPrivateConfig(runtimePath),
        "Prepared runtime manifest",
      );
      if (
        value.version !== 1 ||
        Object.keys(value).some((key) => key !== "version" && key !== "mounts")
      )
        fail("Prepared runtime manifest requires version 1 and mounts");
      runtimeMounts = validateRuntimeMounts(value.mounts);
      for (const mount of runtimeMounts) {
        if (within(canonicalDirectory, await realpath(mount.source)))
          fail(
            "Runtime sources must stay outside the temporary preparation directory",
          );
      }
    }
    return {
      directory,
      manifestPath,
      ...(runtimeMounts ? { runtimeMounts } : {}),
    };
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      fail(
        `Preset preparation failed and private staging data remains at ${directory}`,
        error,
      );
    }
    throw error;
  }
}

export async function cleanupPresetHandoff(
  prepared: PreparedPresetHandoff | undefined,
): Promise<void> {
  if (prepared) await rm(prepared.directory, { recursive: true, force: false });
}
