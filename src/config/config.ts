import { Buffer } from "node:buffer";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { PiSeshError } from "../errors";
import { isPathWithin } from "../path-utils";
import { isLiteralArgv } from "../argv";

export type WorkspaceMode = "mount" | "clone";
export type NetworkMode = "none" | "pasta";

export const DEFAULT_IMAGE = "localhost/pi-sesh-default:1";

export interface BuildConfig {
  context: string;
  file: string;
}

export interface ProjectConfig {
  version: 1;
  image?: string;
  build?: { context?: string; file?: string };
  workspace?: WorkspaceMode;
  command?: string[];
  network?: NetworkMode;
  environment?: Record<string, string>;
}

export interface SpecOverrides {
  image?: string;
  context?: string;
  file?: string;
  workspace?: WorkspaceMode;
  network?: NetworkMode;
  command?: string[];
  environment?: Record<string, string>;
}

export interface EffectiveSpec {
  projectDir: string;
  configFile?: string;
  image: string;
  build?: BuildConfig;
  workspace: WorkspaceMode;
  command?: string[];
  network: NetworkMode;
  environment?: Record<string, string>;
}

export interface PresetDefaults {
  image?: string;
  workspace: WorkspaceMode;
  network: NetworkMode;
  environment?: Record<string, string>;
}

export type SpecPurpose = "build" | "start";

const MAX_CONFIG_BYTES = 1024 * 1024;
const TOP_LEVEL_KEYS = new Set([
  "version",
  "image",
  "build",
  "workspace",
  "command",
  "network",
  "environment",
]);
const BUILD_KEYS = new Set(["context", "file"]);
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,254}$/;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED_ENVIRONMENT_NAME =
  /^(?:HOME|PATH|PWD|OLDPWD|TERM|COLORTERM|LANG|LC_ALL|NODE_OPTIONS|BASH_ENV|ENV|SHELLOPTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_(?:FILE|DIR)|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|XDG_.*|PI_.*|LD_.*|OPENAI_.*|ANTHROPIC_.*|GOOGLE_GENERATIVE_AI_.*|AZURE_OPENAI_.*|AWS_ENDPOINT_URL.*|GIT_CONFIG_.*|GIT_ASKPASS|GIT_SSH(?:_COMMAND)?|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|GIT_PAGER|SSH_ASKPASS|SSH_AUTH_SOCK)$/;
const SECRET_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|DATABASE_URL)(?:_|$)/i;
const MAX_ENVIRONMENT_ENTRIES = 64;
const MAX_ENVIRONMENT_VALUE_BYTES = 4096;
const MAX_ENVIRONMENT_TOTAL_BYTES = 16 * 1024;

function fail(message: string): never {
  throw new PiSeshError("CONFIG", message);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Unsupported ${where} field: ${key}`);
  }
}

export function validateContainerEnvironment(
  value: unknown,
  label = "environment",
): Record<string, string> {
  const input = asRecord(value, label);
  const entries = Object.entries(input);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES)
    fail(`${label} has more than ${MAX_ENVIRONMENT_ENTRIES} entries`);
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const [name, rawValue] of entries) {
    if (!ENVIRONMENT_NAME.test(name))
      fail(`${label} contains an invalid variable name`);
    if (
      RESERVED_ENVIRONMENT_NAME.test(name) ||
      SECRET_ENVIRONMENT_NAME.test(name)
    ) {
      fail(`${label} cannot set reserved or credential-like variable ${name}`);
    }
    if (
      typeof rawValue !== "string" ||
      rawValue.includes("\0") ||
      rawValue.includes("\n") ||
      rawValue.includes("\r")
    ) {
      fail(`${label} values must be single-line literal strings`);
    }
    const valueBytes = Buffer.byteLength(rawValue, "utf8");
    if (valueBytes > MAX_ENVIRONMENT_VALUE_BYTES)
      fail(
        `${label} value for ${name} exceeds ${MAX_ENVIRONMENT_VALUE_BYTES} bytes`,
      );
    totalBytes += Buffer.byteLength(name, "utf8") + valueBytes + 1;
    if (totalBytes > MAX_ENVIRONMENT_TOTAL_BYTES)
      fail(`${label} exceeds ${MAX_ENVIRONMENT_TOTAL_BYTES} bytes`);
    result[name] = rawValue;
  }
  return result;
}

export function validateImageReference(value: unknown): string {
  if (
    typeof value !== "string" ||
    !IMAGE_REFERENCE.test(value) ||
    value.startsWith("-")
  ) {
    return fail("image must be a valid local container image reference");
  }
  return value;
}

function validatePath(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return fail(`${where} must be a non-empty path string`);
  }
  return value;
}

function validateConfig(value: unknown): ProjectConfig {
  const input = asRecord(value, "Configuration");
  rejectUnknownKeys(input, TOP_LEVEL_KEYS, "configuration");
  if (input.version !== 1) fail("Configuration version must be 1");

  let build: ProjectConfig["build"];
  if (input.build !== undefined) {
    const item = asRecord(input.build, "build");
    rejectUnknownKeys(item, BUILD_KEYS, "build");
    build = {
      ...(item.context === undefined
        ? {}
        : { context: validatePath(item.context, "build.context") }),
      ...(item.file === undefined
        ? {}
        : { file: validatePath(item.file, "build.file") }),
    };
  }

  let workspace: WorkspaceMode | undefined;
  if (input.workspace !== undefined) {
    if (input.workspace !== "mount" && input.workspace !== "clone") {
      fail('workspace must be "mount" or "clone"');
    }
    workspace = input.workspace;
  }

  let network: NetworkMode | undefined;
  if (input.network !== undefined) {
    if (input.network !== "none" && input.network !== "pasta") {
      fail('network must be "none" or "pasta"');
    }
    network = input.network;
  }

  let environment: Record<string, string> | undefined;
  if (input.environment !== undefined) {
    environment = validateContainerEnvironment(
      input.environment,
      "project environment",
    );
  }

  let command: string[] | undefined;
  if (input.command !== undefined) {
    if (!isLiteralArgv(input.command)) {
      fail("command must be a non-empty array of non-empty strings");
    }
    command = [...input.command];
  }

  return {
    version: 1,
    ...(input.image === undefined
      ? {}
      : { image: validateImageReference(input.image) }),
    ...(build === undefined ? {} : { build }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(command === undefined ? {} : { command }),
    ...(network === undefined ? {} : { network }),
    ...(environment === undefined ? {} : { environment }),
  };
}

async function canonicalExistingPath(
  path: string,
  label: string,
): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    throw new PiSeshError("CONFIG", `${label} does not exist: ${path}`, {
      cause,
    });
  }
}

export async function loadConfig(
  projectDir: string,
  explicitConfig?: string,
): Promise<{
  config?: ProjectConfig;
  configFile?: string;
}> {
  const requestedPath = explicitConfig
    ? resolve(explicitConfig)
    : resolve(projectDir, "pi-sesh.json");
  let fileInfo;
  try {
    fileInfo = await (explicitConfig
      ? stat(requestedPath)
      : lstat(requestedPath));
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
    if (missing && !explicitConfig) return {};
    if (missing)
      throw new PiSeshError(
        "CONFIG",
        `Explicit config file not found: ${requestedPath}`,
        { cause },
      );
    throw new PiSeshError(
      "CONFIG",
      `Unable to inspect config file: ${requestedPath}`,
      { cause },
    );
  }

  if (fileInfo.isSymbolicLink?.()) {
    try {
      fileInfo = await stat(requestedPath);
    } catch (cause) {
      throw new PiSeshError(
        "CONFIG",
        `Unable to inspect config target: ${requestedPath}`,
        { cause },
      );
    }
  }
  if (!fileInfo.isFile())
    fail(`Config must be a regular file: ${requestedPath}`);
  const configFile = await canonicalExistingPath(requestedPath, "Config file");
  if (!explicitConfig && !isPathWithin(projectDir, configFile)) {
    fail(
      "Default pi-sesh.json symlink must resolve inside the selected project",
    );
  }
  const file = Bun.file(configFile);
  if (file.size > MAX_CONFIG_BYTES)
    fail(`Config file exceeds ${MAX_CONFIG_BYTES} bytes`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (cause) {
    throw new PiSeshError("CONFIG", `Invalid JSON in ${configFile}`, { cause });
  }
  return { config: validateConfig(parsed), configFile };
}

async function resolveContainedPath(
  base: string,
  path: string,
  projectDir: string,
  label: string,
  kind: "directory" | "file",
): Promise<string> {
  const candidate = await canonicalExistingPath(resolve(base, path), label);
  const info = await stat(candidate);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    fail(`${label} must be a ${kind}: ${candidate}`);
  }
  if (!isPathWithin(projectDir, candidate))
    fail(`${label} must stay inside the selected project`);
  return candidate;
}

export async function resolveEffectiveSpec(options: {
  projectDir: string;
  configFile?: string;
  overrides?: SpecOverrides;
  purpose: SpecPurpose;
  ignoreProjectConfig?: boolean;
  projectDefaultsOnly?: boolean;
  presetDefaults?: PresetDefaults;
}): Promise<EffectiveSpec> {
  const projectDir = await canonicalExistingPath(
    resolve(options.projectDir),
    "Selected project",
  );
  if (!(await stat(projectDir)).isDirectory())
    fail("Selected project must be a directory");

  const loaded = options.ignoreProjectConfig
    ? {}
    : await loadConfig(projectDir, options.configFile);
  const config = loaded.config ?? { version: 1 as const };
  const overrides = options.overrides ?? {};
  const image =
    overrides.image ??
    config.image ??
    options.presetDefaults?.image ??
    (options.purpose === "start" ? DEFAULT_IMAGE : undefined);
  if (!image)
    fail("Specify an image with --image, pi-sesh.json, or the user preset");
  validateImageReference(image);

  const configBase = loaded.configFile
    ? dirname(loaded.configFile)
    : projectDir;
  const contextPath = overrides.context ?? config.build?.context;
  const filePath = overrides.file ?? config.build?.file;
  let build: BuildConfig | undefined;
  if (
    !options.projectDefaultsOnly &&
    (options.purpose === "build" ||
      contextPath !== undefined ||
      filePath !== undefined)
  ) {
    if (!contextPath || !filePath)
      fail("Both build context and recipe file are required");
    const context = await resolveContainedPath(
      overrides.context !== undefined || !loaded.configFile
        ? projectDir
        : configBase,
      contextPath,
      projectDir,
      "Build context",
      "directory",
    );
    const file = await resolveContainedPath(
      overrides.file !== undefined || !loaded.configFile
        ? projectDir
        : configBase,
      filePath,
      projectDir,
      "Build recipe",
      "file",
    );
    if (!isPathWithin(context, file))
      fail("Build recipe must be inside the build context");
    build = { context, file };
  }

  const command =
    overrides.command ??
    (options.projectDefaultsOnly ? undefined : config.command);
  if (options.purpose === "start" && (!command || command.length === 0)) {
    fail("Specify a command after -- or in pi-sesh.json");
  }
  if (command && !isLiteralArgv(command)) {
    fail("Command argv must contain non-empty strings without NUL bytes");
  }

  const environment = validateContainerEnvironment(
    {
      ...(options.presetDefaults?.environment ?? {}),
      ...(config.environment ?? {}),
      ...(overrides.environment ?? {}),
    },
    "effective environment",
  );

  return {
    projectDir,
    ...(loaded.configFile ? { configFile: loaded.configFile } : {}),
    image,
    ...(build ? { build } : {}),
    workspace:
      overrides.workspace ??
      config.workspace ??
      options.presetDefaults?.workspace ??
      "mount",
    ...(command ? { command: [...command] } : {}),
    network:
      overrides.network ??
      (options.projectDefaultsOnly
        ? (options.presetDefaults?.network ?? "none")
        : (config.network ?? "none")),
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
  };
}
