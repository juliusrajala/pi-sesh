import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PiSeshError } from "../errors";
import type { WorkspaceMode } from "../config/config";

const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const MAX_ATTRIBUTE_FILES = 512;
const MAX_ATTRIBUTE_FILE_BYTES = 1024 * 1024;
const MAX_ATTRIBUTE_TOTAL_BYTES = 8 * 1024 * 1024;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_OVERRIDES = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "diff.external=",
  "-c",
  "difftool.prompt=false",
];

export interface WorkspaceResult {
  mode: WorkspaceMode;
  path: string;
  projectDir: string;
  sourceRevision?: string;
  ownershipToken?: string;
}

interface OwnerRecord {
  version: 1;
  sessionId: string;
  mode: "clone";
  sourcePath: string;
  sourceRevision: string;
  workspacePath: string;
  workspaceDev: number;
  workspaceIno: number;
  token: string;
}

function fail(message: string, cause?: unknown): never {
  throw new PiSeshError(
    "WORKSPACE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function canonicalDirectory(
  path: string,
  label: string,
): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(resolve(path));
  } catch (cause) {
    return fail(`${label} does not exist: ${path}`, cause);
  }
  if (!(await stat(canonical)).isDirectory())
    fail(`${label} must be a directory: ${canonical}`);
  return canonical;
}

async function trustedPath(projectDir: string): Promise<string> {
  const rawPath = process.env.PATH ?? "/usr/bin:/bin";
  const safe: string[] = [];
  for (const entry of rawPath.split(delimiter).filter(isAbsolute)) {
    try {
      const canonical = await realpath(entry);
      if (!within(projectDir, canonical)) safe.push(canonical);
    } catch {
      // Nonexistent PATH entries cannot provide a trusted executable.
    }
  }
  return safe.join(delimiter) || "/usr/bin:/bin";
}

async function findGit(
  projectDir: string,
): Promise<{ path: string; envPath: string }> {
  const envPath = await trustedPath(projectDir);
  const path = Bun.which("git", { PATH: envPath });
  if (!path || !isAbsolute(path))
    fail("Git is required for clone workspaces; install Git and retry");
  return { path, envPath };
}

async function collectProcess(
  child: ReturnType<typeof Bun.spawn>,
  label: string,
) {
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_COMMAND_OUTPUT) {
          child.kill();
          fail(`${label} output exceeded the safety limit`);
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const [stdout, stderr, status] = await Promise.all([
      collect(child.stdout as ReadableStream<Uint8Array>),
      collect(child.stderr as ReadableStream<Uint8Array>),
      child.exited,
    ]);
    return { stdout, stderr, status };
  } catch (error) {
    child.kill();
    await child.exited.catch(() => {});
    throw error;
  }
}

async function runGit(
  gitPath: string,
  envPath: string,
  cwd: string,
  args: string[],
  label: string,
): Promise<string> {
  const env = {
    PATH: envPath,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ALLOW_PROTOCOL: "file",
  };
  const child = Bun.spawn({
    cmd: [gitPath, ...GIT_OVERRIDES, ...args],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const { stdout, status } = await collectProcess(child, label);
  if (status !== 0) fail(`${label} failed with exit code ${status}`);
  return stdout;
}

function parseGitConfig(output: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\n");
    if (separator < 0) fail("Unable to safely parse local Git configuration");
    entries.push([
      record.slice(0, separator).toLowerCase(),
      record.slice(separator + 1),
    ]);
  }
  return entries;
}

function localConfigKeyAllowed(key: string): boolean {
  if (
    [
      "core.repositoryformatversion",
      "core.filemode",
      "core.bare",
      "core.logallrefupdates",
      "core.ignorecase",
      "core.symlinks",
      "core.precomposeunicode",
      "core.quotepath",
      "core.autocrlf",
      "core.safecrlf",
      "extensions.objectformat",
    ].includes(key)
  ) {
    return true;
  }
  if (/^user\.(name|email)$/.test(key)) return true;
  if (/^branch\.[^.]+\.(remote|merge|description)$/.test(key)) return true;
  if (/^remote\.[^.]+\.(url|pushurl|fetch|push|tagopt|mirror|prune)$/.test(key))
    return true;
  return false;
}

async function verifyLocalConfig(
  gitPath: string,
  envPath: string,
  projectDir: string,
): Promise<void> {
  const dotGit = join(projectDir, ".git");
  const gitInfo = await lstat(dotGit).catch((cause) =>
    fail("Clone mode requires a real in-tree .git directory", cause),
  );
  if (gitInfo.isSymbolicLink() || !gitInfo.isDirectory()) {
    fail(
      "Clone mode requires a real in-tree .git directory; linked worktrees and .git files are unsupported",
    );
  }
  const configPath = join(dotGit, "config");
  const configInfo = await lstat(configPath).catch((cause) =>
    fail("Git repository config is missing", cause),
  );
  if (configInfo.isSymbolicLink() || !configInfo.isFile())
    fail("Symlinked or non-regular .git/config is unsupported");

  for (const relativePath of ["commondir", "objects/info/alternates"]) {
    try {
      await lstat(join(dotGit, relativePath));
      fail(
        `Git ${relativePath} is unsupported because it redirects or shares repository data`,
      );
    } catch (cause) {
      if (cause instanceof PiSeshError) throw cause;
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
        fail(`Unable to inspect Git ${relativePath}`, cause);
    }
  }
  try {
    await lstat(join(dotGit, "worktrees"));
    fail("Git linked worktree metadata is unsupported in clone mode");
  } catch (cause) {
    if (cause instanceof PiSeshError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      fail("Unable to inspect Git worktree metadata", cause);
  }
  try {
    await lstat(join(dotGit, "modules"));
    fail("Git submodule metadata is unsupported in clone mode");
  } catch (cause) {
    if (cause instanceof PiSeshError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      fail("Unable to inspect Git submodule metadata", cause);
  }

  const output = await runGit(
    gitPath,
    envPath,
    projectDir,
    ["config", "--file", configPath, "--no-includes", "--null", "--list"],
    "Reading local Git config",
  );
  for (const [key, value] of parseGitConfig(output)) {
    if (!localConfigKeyAllowed(key))
      fail(`Unsupported execution-affecting local Git config: ${key}`);
    if (key === "core.bare" && value.toLowerCase() === "true")
      fail("Bare Git repositories are unsupported in clone mode");
    if (key === "extensions.objectformat" && value.toLowerCase() !== "sha1") {
      fail("Only SHA-1 Git repositories are supported in clone mode");
    }
  }
}

async function listAttributePaths(
  gitPath: string,
  envPath: string,
  projectDir: string,
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(
      gitPath,
      envPath,
      projectDir,
      [
        "ls-files",
        "--stage",
        "-z",
        "--",
        ".gitattributes",
        "**/.gitattributes",
      ],
      "Listing tracked Git attributes",
    ),
    runGit(
      gitPath,
      envPath,
      projectDir,
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".gitattributes",
        "**/.gitattributes",
      ],
      "Listing untracked Git attributes",
    ),
  ]);
  const paths = new Set<string>();
  for (const record of tracked.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0)
      fail("Unable to safely parse Git index while inspecting attributes");
    const mode = record.slice(0, tab).split(" ")[0];
    const path = record.slice(tab + 1);
    if (mode === "120000")
      fail(`Symlinked Git attribute file is unsupported: ${path}`);
    paths.add(path);
  }
  for (const path of untracked.split("\0")) if (path) paths.add(path);
  if (paths.size > MAX_ATTRIBUTE_FILES)
    fail("Repository has too many Git attribute files to inspect safely");
  return [...paths];
}

function rejectFilterAttributes(content: string, file: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tokens = trimmed.split(/\s+/).slice(1);
    if (
      tokens.some(
        (token) => token.replace(/^[-!+]/, "").split("=")[0] === "filter",
      )
    ) {
      fail(`Git filter attributes are unsupported: ${file}`);
    }
  }
}

async function verifyAttributes(
  gitPath: string,
  envPath: string,
  projectDir: string,
): Promise<void> {
  let totalBytes = 0;
  const paths = await listAttributePaths(gitPath, envPath, projectDir);
  paths.push(".git/info/attributes");
  for (const path of paths) {
    const absolute = join(projectDir, path);
    let info;
    try {
      info = await lstat(absolute);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      fail(`Unable to inspect Git attribute file: ${path}`, cause);
    }
    if (info.isSymbolicLink() || !info.isFile())
      fail(
        `Symlinked or non-regular Git attribute file is unsupported: ${path}`,
      );
    if (info.size > MAX_ATTRIBUTE_FILE_BYTES)
      fail(`Git attribute file is too large to inspect: ${path}`);
    totalBytes += info.size;
    if (totalBytes > MAX_ATTRIBUTE_TOTAL_BYTES)
      fail("Git attribute data exceeds the inspection limit");
    const content = await readFile(absolute, "utf8");
    rejectFilterAttributes(content, path);
  }
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.()
  ) {
    fail(`Session state directory has unexpected ownership or type: ${path}`);
  }
  const canonical = await realpath(path);
  await chmod(path, 0o700);
  return canonical;
}

function ownerRecordPath(stateRoot: string, sessionId: string): string {
  return join(stateRoot, "workspace-records", `${sessionId}.json`);
}

export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_DATA_HOME ||
    (env.HOME ? join(env.HOME, ".local", "share") : undefined);
  if (!base || !isAbsolute(base))
    fail("HOME or absolute XDG_DATA_HOME is required for session state");
  return resolve(base, "pi-sesh");
}

export async function prepareWorkspace(options: {
  projectDir: string;
  mode: WorkspaceMode;
  sessionId: string;
  stateRoot?: string;
}): Promise<WorkspaceResult> {
  if (!SESSION_ID.test(options.sessionId)) fail("Session ID must be a UUID");
  const projectDir = await canonicalDirectory(
    options.projectDir,
    "Selected project",
  );
  if (options.mode === "mount")
    return { mode: "mount", path: projectDir, projectDir };
  return prepareClone({ ...options, projectDir });
}

async function prepareClone(options: {
  projectDir: string;
  sessionId: string;
  stateRoot?: string;
}): Promise<WorkspaceResult> {
  const stateRoot = await ensurePrivateDirectory(
    resolve(options.stateRoot ?? defaultStateRoot()),
  );
  const workspacesDir = await ensurePrivateDirectory(
    join(stateRoot, "workspaces"),
  );
  await ensurePrivateDirectory(join(stateRoot, "workspace-records"));
  const workspacePath = join(workspacesDir, options.sessionId);
  const recordPath = ownerRecordPath(stateRoot, options.sessionId);
  const token = randomUUID();
  const git = await findGit(options.projectDir);
  await verifyLocalConfig(git.path, git.envPath, options.projectDir);
  await verifyAttributes(git.path, git.envPath, options.projectDir);

  const index = await runGit(
    git.path,
    git.envPath,
    options.projectDir,
    ["ls-files", "--stage", "-z"],
    "Inspecting Git index",
  );
  for (const entry of index.split("\0")) {
    if (!entry) continue;
    if (entry.startsWith("160000 "))
      fail(
        "Git submodules are unsupported in clone mode; use mount workspace mode",
      );
  }
  try {
    await lstat(join(options.projectDir, ".gitmodules"));
    fail(
      "Git submodules are unsupported in clone mode; use mount workspace mode",
    );
  } catch (cause) {
    if (cause instanceof PiSeshError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
      fail("Unable to inspect .gitmodules", cause);
  }

  const status = await runGit(
    git.path,
    git.envPath,
    options.projectDir,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    "Checking Git worktree status",
  );
  if (status.length > 0)
    fail(
      "Clone mode requires a clean Git worktree (tracked and untracked changes found)",
    );
  const revision = (
    await runGit(
      git.path,
      git.envPath,
      options.projectDir,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      "Reading Git HEAD",
    )
  ).trim();
  if (!/^[0-9a-f]{40}$/i.test(revision))
    fail("Git returned an unsupported HEAD object ID");

  const templateDir = await ensurePrivateDirectory(
    join(stateRoot, "empty-git-template"),
  );
  let recordCreated = false;
  let reserved = false;
  let identity: { dev: number; ino: number } | undefined;
  try {
    await mkdir(workspacePath, { mode: 0o700 });
    reserved = true;
    const createdInfo = await lstat(workspacePath);
    identity = { dev: createdInfo.dev, ino: createdInfo.ino };
    const record: OwnerRecord = {
      version: 1,
      sessionId: options.sessionId,
      mode: "clone",
      sourcePath: options.projectDir,
      sourceRevision: revision,
      workspacePath,
      workspaceDev: createdInfo.dev,
      workspaceIno: createdInfo.ino,
      token,
    };
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    recordCreated = true;
    const cloneEnv = {
      PATH: git.envPath,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ALLOW_PROTOCOL: "file",
      GIT_TEMPLATE_DIR: templateDir,
    };
    const clone = Bun.spawn({
      cmd: [
        git.path,
        ...GIT_OVERRIDES,
        "clone",
        "--no-checkout",
        "--no-hardlinks",
        "--no-local",
        "--no-tags",
        "--no-recurse-submodules",
        options.projectDir,
        workspacePath,
      ],
      cwd: options.projectDir,
      env: cloneEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const { status: cloneStatus } = await collectProcess(clone, "Git clone");
    if (cloneStatus !== 0)
      fail(
        `Creating independent Git clone failed with exit code ${cloneStatus}`,
      );

    await runGit(
      git.path,
      git.envPath,
      workspacePath,
      ["remote", "remove", "origin"],
      "Removing clone origin",
    );
    const checkedOut = (
      await runGit(
        git.path,
        git.envPath,
        workspacePath,
        ["checkout", "--detach", "--force", revision],
        "Checking out cloned revision",
      )
    ).trim();
    void checkedOut;
    const cloneRevision = (
      await runGit(
        git.path,
        git.envPath,
        workspacePath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "Verifying cloned HEAD",
      )
    ).trim();
    if (cloneRevision !== revision)
      fail("Independent clone does not match the recorded source revision");
    const remotes = await runGit(
      git.path,
      git.envPath,
      workspacePath,
      ["remote", "-v"],
      "Verifying clone remotes",
    );
    if (remotes.trim()) fail("New clone unexpectedly contains a Git remote");
    try {
      await lstat(join(workspacePath, ".git", "objects", "info", "alternates"));
      fail("New clone unexpectedly uses a shared Git object store");
    } catch (cause) {
      if (cause instanceof PiSeshError) throw cause;
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
        fail("Unable to verify clone object storage", cause);
    }
    const finalInfo = await lstat(workspacePath);
    if (
      finalInfo.isSymbolicLink() ||
      finalInfo.dev !== identity.dev ||
      finalInfo.ino !== identity.ino
    ) {
      fail("Clone workspace path changed during setup");
    }
    await chmod(workspacePath, 0o700);
    return {
      mode: "clone",
      path: workspacePath,
      projectDir: options.projectDir,
      sourceRevision: revision,
      ownershipToken: token,
    };
  } catch (error) {
    if (reserved && identity) {
      try {
        const current = await lstat(workspacePath);
        if (
          !current.isSymbolicLink() &&
          current.isDirectory() &&
          current.dev === identity.dev &&
          current.ino === identity.ino
        ) {
          await rm(workspacePath, { recursive: true, force: true });
        }
      } catch {}
    }
    if (recordCreated) await rm(recordPath, { force: true }).catch(() => {});
    if (error instanceof PiSeshError) throw error;
    fail(
      `Unable to prepare clone workspace: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

export async function removeOwnedClone(options: {
  stateRoot: string;
  sessionId: string;
  expectedWorkspacePath: string;
  containerAbsent: boolean;
}): Promise<void> {
  if (!options.containerAbsent)
    fail("Refusing to remove a clone while its container exists");
  if (!SESSION_ID.test(options.sessionId)) fail("Session ID must be a UUID");
  const stateRoot = await canonicalDirectory(
    options.stateRoot,
    "Session state root",
  );
  const workspacesDir = await canonicalDirectory(
    join(stateRoot, "workspaces"),
    "Workspace state directory",
  );
  const expected = join(workspacesDir, options.sessionId);
  const expectedWorkspacePath = resolve(options.expectedWorkspacePath);
  if (expected !== expectedWorkspacePath)
    fail("Workspace metadata path does not match the session-owned location");

  const recordPath = ownerRecordPath(stateRoot, options.sessionId);
  let record: OwnerRecord;
  try {
    const recordInfo = await lstat(recordPath);
    if (
      recordInfo.isSymbolicLink() ||
      !recordInfo.isFile() ||
      recordInfo.uid !== process.getuid?.()
    ) {
      fail("Workspace ownership record has unexpected type or owner");
    }
    record = JSON.parse(await readFile(recordPath, "utf8")) as OwnerRecord;
  } catch (cause) {
    fail("Workspace ownership record is missing or invalid", cause);
  }
  if (
    record.version !== 1 ||
    record.mode !== "clone" ||
    record.sessionId !== options.sessionId ||
    record.workspacePath !== expected ||
    !SESSION_ID.test(record.sessionId) ||
    !/^[0-9a-f-]{36}$/i.test(record.token)
  ) {
    fail(
      "Workspace ownership record does not match its session-owned location",
    );
  }
  const workspace = await lstat(expected).catch((cause) =>
    fail("Owned clone workspace is missing", cause),
  );
  if (
    workspace.isSymbolicLink() ||
    !workspace.isDirectory() ||
    workspace.uid !== process.getuid?.() ||
    workspace.dev !== record.workspaceDev ||
    workspace.ino !== record.workspaceIno
  ) {
    fail("Refusing to remove a replaced or foreign clone workspace");
  }
  const resolved = await realpath(expected);
  if (resolved !== expected)
    fail("Refusing to remove a path-substituted clone workspace");
  await rm(expected, { recursive: true, force: false });
  await rm(recordPath, { force: false });
}
