import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  validateContainerEnvironment,
  type EffectiveSpec,
} from "../config/config";
import { PiSeshError } from "../errors";
import {
  handoffMountArgs,
  removeStagedResource,
  stageHandoffManifest,
  type StagedResource,
  type StagedResourceRecord,
} from "../handoff/handoff";
import { PodmanClient, type CommandResult } from "./podman";
import { runtimeMountArgs, type RuntimeMount } from "../launch/runtime";
import {
  defaultStateRoot,
  prepareWorkspace,
  removeOwnedClone,
  type WorkspaceResult,
} from "../workspace/workspace";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OWNER_LABEL = "io.pi-sesh.owner";
const SESSION_LABEL = "io.pi-sesh.session-id";

function summarizeEngineDiagnostic(stderr: string): string | undefined {
  const message = stderr
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) return undefined;
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
}

export interface SessionRecord {
  version: 1;
  id: string;
  name: string;
  containerName: string;
  containerId: string;
  projectDir: string;
  workspaceMode: "mount" | "clone";
  workspacePath: string;
  sourceRevision?: string;
  imageId: string;
  network: "none" | "pasta";
  tty: boolean;
  createdAt: string;
  resources?: StagedResourceRecord[];
}

export interface ContainerStatus {
  state: "running" | "exited" | "created" | "stopped" | "paused" | "missing";
  exitCode?: number;
}

export interface StartedSession {
  id: string;
  name: string;
  containerId: string;
  state: ContainerStatus["state"];
  exitCode?: number;
  detached: boolean;
}

function fail(message: string, cause?: unknown): never {
  throw new PiSeshError(
    "SESSION",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function validateName(name: string): void {
  if (!NAME.test(name))
    fail(
      "Session name must start with a letter or number and contain only letters, numbers, '.', '_' or '-' (max 64 characters)",
    );
}

function sessionPath(stateRoot: string, id: string): string {
  return join(stateRoot, "sessions", `${id}.json`);
}

function namePath(stateRoot: string, name: string): string {
  return join(
    stateRoot,
    "names",
    `${Buffer.from(name).toString("base64url")}.json`,
  );
}

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.()
  ) {
    fail(`Session state directory has unexpected type or owner: ${path}`);
  }
  await chmod(path, 0o700);
  return resolve(path);
}

async function prepareStateRoot(
  client: PodmanClient,
  requested?: string,
): Promise<string> {
  const root = resolve(requested ?? defaultStateRoot(client.env));
  const canonical = await privateDirectory(root);
  await privateDirectory(join(canonical, "sessions"));
  await privateDirectory(join(canonical, "names"));
  return canonical;
}

async function writeRecord(
  stateRoot: string,
  record: SessionRecord,
): Promise<void> {
  const path = sessionPath(stateRoot, record.id);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {});
    fail("Unable to atomically persist session metadata", cause);
  }
}

function validateRecord(value: unknown, id?: string): SessionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("Session metadata is invalid");
  const record = value as SessionRecord;
  if (
    record.version !== 1 ||
    !UUID.test(record.id) ||
    (id !== undefined && record.id !== id) ||
    !NAME.test(record.name) ||
    !record.containerName.startsWith("pi-sesh-") ||
    !/^[0-9a-f]{64}$/i.test(record.containerId) ||
    !/^[0-9a-f]{64}$/i.test(record.imageId) ||
    !isAbsolute(record.projectDir) ||
    !isAbsolute(record.workspacePath) ||
    (record.workspaceMode !== "mount" && record.workspaceMode !== "clone") ||
    (record.network !== "none" && record.network !== "pasta") ||
    typeof record.tty !== "boolean" ||
    typeof record.createdAt !== "string"
  ) {
    fail("Session metadata failed validation");
  }
  if (record.resources !== undefined) {
    if (!Array.isArray(record.resources) || record.resources.length > 32)
      fail("Session handoff resource metadata failed validation");
    const ids = new Set<string>();
    for (const resource of record.resources) {
      if (
        !resource ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(resource.id) ||
        ids.has(resource.id) ||
        typeof resource.destination !== "string" ||
        !resource.destination.startsWith("/home/session/") ||
        !["snapshot", "owned-directory"].includes(resource.kind) ||
        !["ro", "rw"].includes(resource.access) ||
        !["retained", "secret"].includes(resource.lifetime) ||
        (resource.kind === "owned-directory" &&
          (resource.access !== "rw" || resource.lifetime !== "retained")) ||
        (resource.lifetime === "secret" && resource.access !== "rw") ||
        !UUID.test(resource.stageToken) ||
        !Number.isInteger(resource.stageDevice) ||
        !Number.isInteger(resource.stageInode)
      )
        fail("Session handoff resource metadata failed validation");
      ids.add(resource.id);
    }
  }
  return record;
}

async function readRecord(
  stateRoot: string,
  id: string,
): Promise<SessionRecord> {
  if (!UUID.test(id)) fail("Session ID is invalid");
  const path = sessionPath(stateRoot, id);
  const info = await lstat(path).catch((cause) =>
    fail(`Session metadata not found for ${id}`, cause),
  );
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    fail("Session metadata has unexpected type, owner, or permissions");
  }
  try {
    return validateRecord(JSON.parse(await readFile(path, "utf8")), id);
  } catch (cause) {
    if (cause instanceof PiSeshError) throw cause;
    fail("Session metadata is invalid JSON", cause);
  }
}

async function reserveName(
  stateRoot: string,
  name: string,
  id: string,
): Promise<void> {
  validateName(name);
  const path = namePath(stateRoot, name);
  try {
    await writeFile(path, `${JSON.stringify({ version: 1, name, id })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST")
      fail(`Session name is already reserved: ${name}`);
    fail("Unable to reserve session name", cause);
  }
}

async function releaseName(
  stateRoot: string,
  name: string,
  id: string,
): Promise<void> {
  const path = namePath(stateRoot, name);
  try {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.uid !== process.getuid?.()
    )
      fail("Session name reservation is unsafe");
    const value = JSON.parse(await readFile(path, "utf8")) as {
      name?: string;
      id?: string;
      version?: number;
    };
    if (value.version !== 1 || value.name !== name || value.id !== id)
      fail("Session name reservation does not match the session");
    await rm(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    if (cause instanceof PiSeshError) throw cause;
    fail("Unable to release session name", cause);
  }
}

async function recordByName(
  stateRoot: string,
  name: string,
): Promise<SessionRecord> {
  validateName(name);
  const path = namePath(stateRoot, name);
  let reservation: { version?: number; name?: string; id?: string };
  try {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.uid !== process.getuid?.()
    )
      fail("Session name reservation is unsafe");
    reservation = JSON.parse(
      await readFile(path, "utf8"),
    ) as typeof reservation;
  } catch (cause) {
    if (cause instanceof PiSeshError) throw cause;
    fail(`No pi-sesh session named ${name}`, cause);
  }
  if (
    reservation.version !== 1 ||
    reservation.name !== name ||
    !reservation.id ||
    !UUID.test(reservation.id)
  ) {
    fail("Session name reservation is invalid");
  }
  const record = await readRecord(stateRoot, reservation.id);
  if (record.name !== name)
    fail("Session reservation does not match its metadata");
  return record;
}

function parseContainerInspect(output: string): any {
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    fail("Podman returned invalid container inspection data", cause);
  }
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!item || typeof item !== "object")
    fail("Podman returned empty container inspection data");
  return item;
}

export function buildContainerCreateArgs(options: {
  record: Pick<SessionRecord, "id" | "name" | "containerName" | "imageId">;
  spec: EffectiveSpec;
  workspace: WorkspaceResult;
  uid: number;
  gid: number;
  tty: boolean;
  selinux: boolean;
  handoffMounts?: string[];
  runtimeMounts?: string[];
  interactive?: boolean;
  terminal?: { term?: string; colorTerm?: string };
}): string[] {
  if (options.uid < 0 || options.gid < 0)
    fail("Mapped host UID/GID must be non-negative");
  for (const path of [options.workspace.path]) {
    if (path.includes(":") || path.includes(","))
      fail(
        "Mount paths containing ':' or ',' are unsupported by Podman volume syntax",
      );
  }
  const selinux = options.selinux ? ",Z" : "";
  const args = [
    "create",
    "--name",
    options.record.containerName,
    "--label",
    `${OWNER_LABEL}=pi-sesh`,
    "--label",
    `${SESSION_LABEL}=${options.record.id}`,
    "--label",
    `io.pi-sesh.session-name=${options.record.name}`,
    "--pull=never",
    "--image-volume=ignore",
    "--http-proxy=false",
    "--network",
    options.spec.network,
    "--userns=keep-id",
    "--user",
    `${options.uid}:${options.gid}`,
    "--read-only",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--memory=4g",
    "--memory-swap=4g",
    "--cpus=4",
    "--pids-limit=512",
    "--tmpfs",
    `/home/session:rw,noexec,nosuid,nodev,size=1g,mode=1777`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777`,
    "--volume",
    `${options.workspace.path}:/workspace:rw${selinux}`,
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/home/session",
    "--env",
    "XDG_CONFIG_HOME=/home/session/.config",
    "--env",
    "XDG_DATA_HOME=/home/session/.local/share",
    "--env",
    "XDG_CACHE_HOME=/home/session/.cache",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    `PI_SESH_SESSION=${options.record.name}`,
    "--env",
    `PI_SESH_SESSION_ID=${options.record.id}`,
    "--env",
    `PI_SESH_NETWORK=${options.spec.network}`,
    "--env",
    `PI_SESH_WORKSPACE=${options.workspace.mode}`,
  ];
  const environment = validateContainerEnvironment(
    options.spec.environment ?? {},
    "effective environment",
  );
  for (const name of Object.keys(environment).sort()) {
    args.push("--env", `${name}=${environment[name]}`);
  }
  if (options.interactive || options.tty) args.push("--interactive");
  if (options.tty) {
    args.push("--tty");
    if (options.terminal?.term)
      args.push("--env", `TERM=${options.terminal.term}`);
    if (options.terminal?.colorTerm)
      args.push("--env", `COLORTERM=${options.terminal.colorTerm}`);
  }
  if (options.handoffMounts) args.push(...options.handoffMounts);
  if (options.runtimeMounts) args.push(...options.runtimeMounts);
  args.push(
    "--entrypoint",
    options.spec.command![0]!,
    options.record.imageId,
    ...options.spec.command!.slice(1),
  );
  return args;
}

async function inspectContainer(
  client: PodmanClient,
  record: SessionRecord,
): Promise<{ status: ContainerStatus; selinux: boolean }> {
  const exists = await client.invoke([
    "container",
    "exists",
    record.containerId,
  ]);
  if (exists.status === 1)
    return { status: { state: "missing" }, selinux: false };
  if (exists.status !== 0)
    fail(
      `Podman could not determine whether container ${record.containerId} exists (exit ${exists.status})`,
    );
  const result = await client.checked([
    "container",
    "inspect",
    "--format",
    "json",
    record.containerId,
  ]);
  const item = parseContainerInspect(result.stdout);
  if (
    typeof item.Id !== "string" ||
    !/^[0-9a-f]{64}$/i.test(item.Id) ||
    !item.State ||
    typeof item.State.Status !== "string" ||
    typeof item.State.ExitCode !== "number" ||
    !Number.isInteger(item.State.ExitCode)
  ) {
    fail("Podman returned incomplete container inspection data");
  }
  const labels = item.Config?.Labels ?? item.Labels ?? {};
  if (!labels || typeof labels !== "object")
    fail("Podman returned invalid container labels");
  if (
    item.Id !== record.containerId ||
    labels[OWNER_LABEL] !== "pi-sesh" ||
    labels[SESSION_LABEL] !== record.id
  ) {
    fail(
      "Refusing to operate on a container not owned by this pi-sesh session",
    );
  }
  const rawState = String(item.State?.Status ?? "").toLowerCase();
  const states: Record<string, ContainerStatus["state"]> = {
    running: "running",
    exited: "exited",
    stopped: "stopped",
    created: "created",
    configured: "created",
    paused: "paused",
  };
  const state = states[rawState];
  if (!state)
    fail(`Unsupported Podman container state: ${rawState || "unknown"}`);
  const exitCode = Number(item.State?.ExitCode);
  return {
    status:
      state === "running" || state === "created" || state === "paused"
        ? { state }
        : { state, exitCode },
    selinux: Boolean(
      item.HostConfig?.SecurityOpt?.some?.((value: string) =>
        value.includes("label"),
      ),
    ),
  };
}

function isStoppedOrMissing(state: ContainerStatus["state"]): boolean {
  return state === "exited" || state === "stopped" || state === "missing";
}

async function cleanHandoffResources(
  stateRoot: string,
  record: SessionRecord,
  lifetime: "secret" | "all",
): Promise<void> {
  if (!record.resources?.length) return;
  const retained: StagedResourceRecord[] = [];
  const failures: unknown[] = [];
  for (const resource of record.resources) {
    if (lifetime === "secret" && resource.lifetime !== "secret") {
      retained.push(resource);
      continue;
    }
    try {
      await removeStagedResource({
        stateRoot,
        sessionId: record.id,
        resource,
      });
    } catch (cause) {
      failures.push(cause);
      retained.push(resource);
    }
  }
  record.resources = retained;
  await writeRecord(stateRoot, record);
  if (failures.length > 0)
    fail(
      `Unable to clean ${failures.length} staged handoff resource(s); session data remains reserved for recovery`,
      failures[0],
    );
}

async function cleanSessionSecrets(
  stateRoot: string,
  record: SessionRecord,
): Promise<void> {
  await cleanHandoffResources(stateRoot, record, "secret");
}

async function removeSessionRecord(
  stateRoot: string,
  record: SessionRecord,
): Promise<void> {
  await rm(sessionPath(stateRoot, record.id), { force: false });
  await releaseName(stateRoot, record.name, record.id);
}

export async function startSession(options: {
  name: string;
  spec: EffectiveSpec;
  detached?: boolean;
  tty?: boolean;
  signal?: AbortSignal;
  runtimeMounts?: RuntimeMount[];
  client?: PodmanClient;
  stateRoot?: string;
  handoffManifestPath?: string;
  prepareHandoff?: (context: {
    sessionId: string;
    stateRoot: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<{ manifestPath: string; cleanup: () => Promise<void> }>;
}): Promise<StartedSession> {
  validateName(options.name);
  options.signal?.throwIfAborted();
  const runtimeArgs = await runtimeMountArgs(options.runtimeMounts ?? []);
  if (options.handoffManifestPath && options.prepareHandoff)
    fail(
      "Use either an explicit handoff manifest or a trusted handoff preparer, not both",
    );
  if (!options.spec.command?.length)
    fail("A non-empty command argv is required");
  const client =
    options.client ??
    (await PodmanClient.create({ projectDir: options.spec.projectDir }));
  const host = await client.preflight(options.spec.network);
  if (!(await client.imageExists(options.spec.image))) {
    fail(
      `Image ${options.spec.image} is not present locally; build or select an image before starting`,
    );
  }
  const imageId = await client.imageId(options.spec.image);
  const stateRoot = await prepareStateRoot(client, options.stateRoot);
  const id = randomUUID();
  const containerName = `pi-sesh-${id}`;
  await reserveName(stateRoot, options.name, id);

  let workspace: WorkspaceResult | undefined;
  let handoffSetup:
    | { manifestPath: string; cleanup: () => Promise<void> }
    | undefined;
  let handoff: StagedResource[] = [];
  let containerCreated = false;
  let retainAfterStartFailure = false;
  let record: SessionRecord | undefined;
  try {
    workspace = await prepareWorkspace({
      projectDir: options.spec.projectDir,
      mode: options.spec.workspace,
      sessionId: id,
      stateRoot,
    });
    if (options.prepareHandoff)
      handoffSetup = await options.prepareHandoff({
        sessionId: id,
        stateRoot,
        env: client.env,
      });
    record = {
      version: 1,
      id,
      name: options.name,
      containerName,
      containerId: "0".repeat(64),
      projectDir: workspace.projectDir,
      workspaceMode: workspace.mode,
      workspacePath: workspace.path,
      ...(workspace.sourceRevision
        ? { sourceRevision: workspace.sourceRevision }
        : {}),
      imageId,
      network: options.spec.network,
      tty: options.tty ?? !options.detached,
      createdAt: new Date().toISOString(),
      resources: [],
    };
    const manifestPath =
      options.handoffManifestPath ?? handoffSetup?.manifestPath;
    if (manifestPath) {
      handoff = await stageHandoffManifest({
        manifestPath,
        stateRoot,
        sessionId: id,
        register: async (resource) => {
          record!.resources!.push(resource);
          await writeRecord(stateRoot, record!);
        },
      });
    }
    for (const resource of handoff) {
      for (const mount of options.runtimeMounts ?? []) {
        const target = resource.record.destination;
        if (
          target === mount.destination ||
          target.startsWith(`${mount.destination}/`) ||
          mount.destination.startsWith(`${target}/`)
        )
          fail("Runtime and handoff destinations must not overlap");
      }
    }
    if (handoffSetup) {
      await handoffSetup.cleanup();
      handoffSetup = undefined;
    }
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined)
      fail("Linux invoking UID/GID is unavailable");
    const createArgs = buildContainerCreateArgs({
      record,
      spec: options.spec,
      workspace,
      uid,
      gid,
      tty: record.tty,
      interactive: !options.detached,
      runtimeMounts: runtimeArgs,
      selinux: host.selinuxEnabled,
      handoffMounts: handoffMountArgs({
        resources: handoff,
        selinux: host.selinuxEnabled,
      }),
      terminal: { term: client.env.TERM, colorTerm: client.env.COLORTERM },
    });
    // Podman host SELinux state is part of preflight information; the client resolves it for this create.
    options.signal?.throwIfAborted();
    const createResult = await client.checked(createArgs);
    containerCreated = true;
    const containerId = createResult.stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(containerId))
      fail("Podman returned an invalid container ID");
    record.containerId = containerId;
    await writeRecord(stateRoot, record);

    const detached = options.detached ?? false;
    const startArgs = detached
      ? ["container", "start", record.containerId]
      : [
          "container",
          "start",
          "--attach",
          "--interactive",
          "--detach-keys",
          "ctrl-p,ctrl-q",
          record.containerId,
        ];
    let startResult: CommandResult;
    try {
      options.signal?.throwIfAborted();
      startResult = await client.invoke(startArgs, {
        stdio: detached ? "pipe" : "inherit",
        ...(detached ? {} : { signal: options.signal }),
      });
      if (options.signal?.aborted) throw new Error("Launch cancelled");
    } catch (error) {
      if (!detached) {
        const before = await inspectContainer(client, record);
        if (before.status.state === "running")
          await client.checked([
            "container",
            "stop",
            "--time",
            "0",
            record.containerId,
          ]);
        const after = await inspectContainer(client, record);
        if (
          !isStoppedOrMissing(after.status.state) &&
          after.status.state !== "created"
        )
          fail(
            "Cannot verify launch cancellation; refusing to delete resources before verified container removal",
          );
        if (isStoppedOrMissing(after.status.state)) {
          retainAfterStartFailure = true;
          await cleanSessionSecrets(stateRoot, record);
        }
      }
      throw error;
    }
    const current = await inspectContainer(client, record);
    if (current.status.state === "missing")
      fail("Podman container disappeared during startup");
    if (
      !detached &&
      startResult.status !== 0 &&
      current.status.state === "running"
    ) {
      await client.checked([
        "container",
        "stop",
        "--time",
        "0",
        record.containerId,
      ]);
      const after = await inspectContainer(client, record);
      if (!isStoppedOrMissing(after.status.state))
        fail("Cannot verify stop after an attached transport failure");
      retainAfterStartFailure = true;
      await cleanSessionSecrets(stateRoot, record);
      fail(`Podman attached transport failed (exit ${startResult.status})`);
    }
    if (
      startResult.status !== 0 &&
      (detached ||
        current.status.state === "running" ||
        current.status.state === "created")
    ) {
      const diagnostic = summarizeEngineDiagnostic(startResult.stderr);
      fail(
        `Podman failed to start the session (exit ${startResult.status})${diagnostic ? `: ${diagnostic}` : ""}`,
      );
    }
    if (isStoppedOrMissing(current.status.state))
      await cleanSessionSecrets(stateRoot, record);
    return {
      id,
      name: options.name,
      containerId,
      state: current.status.state,
      ...(current.status.exitCode === undefined
        ? {}
        : { exitCode: current.status.exitCode }),
      detached,
    };
  } catch (error) {
    if (retainAfterStartFailure)
      fail(
        `Launch interrupted; stopped session ${options.name} and its results remain available`,
        error,
      );
    let cleanupProblem: unknown;
    if (containerCreated) {
      const target =
        record &&
        /^[0-9a-f]{64}$/i.test(record.containerId) &&
        record.containerId !== "0".repeat(64)
          ? record.containerId
          : containerName;
      try {
        await client.invoke(["container", "rm", "--force", target]);
        const exists = await client.invoke(["container", "exists", target]);
        if (exists.status !== 1) {
          cleanupProblem = new Error(
            `container removal could not be verified (exists exit ${exists.status})`,
          );
        }
      } catch (cause) {
        cleanupProblem = cause;
      }
    }
    const mayCleanResources = !containerCreated || !cleanupProblem;
    if (handoffSetup) {
      try {
        await handoffSetup.cleanup();
        handoffSetup = undefined;
      } catch (cause) {
        cleanupProblem ??= cause;
      }
    }
    if (mayCleanResources && record?.resources?.length) {
      try {
        await cleanHandoffResources(stateRoot, record, "all");
      } catch (cause) {
        cleanupProblem ??= cause;
      }
    }
    if (mayCleanResources && workspace?.mode === "clone") {
      try {
        await removeOwnedClone({
          stateRoot,
          sessionId: id,
          expectedWorkspacePath: workspace.path,
          containerAbsent: true,
        });
      } catch (cause) {
        cleanupProblem ??= cause;
      }
    }
    if (cleanupProblem) {
      if (record) await writeRecord(stateRoot, record).catch(() => {});
      throw new PiSeshError(
        "SESSION",
        `Startup failed (${error instanceof Error ? error.message : String(error)}) and owned resources could not be fully cleaned (${cleanupProblem instanceof Error ? cleanupProblem.message : String(cleanupProblem)}); session ${options.name} remains reserved for recovery`,
        { cause: error },
      );
    }
    await rm(sessionPath(stateRoot, id), { force: true }).catch(() => {});
    await releaseName(stateRoot, options.name, id).catch(() => {});
    if (error instanceof PiSeshError) throw error;
    fail(
      `Unable to start session: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

async function findStateRoot(options: {
  stateRoot?: string;
  client?: PodmanClient;
  projectDir?: string;
}): Promise<{ stateRoot: string; client: PodmanClient }> {
  const client =
    options.client ??
    (await PodmanClient.create({ projectDir: options.projectDir }));
  await client.preflight("none");
  return {
    stateRoot: await prepareStateRoot(client, options.stateRoot),
    client,
  };
}

export async function getSessionStatusById(options: {
  id: string;
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<{ record: SessionRecord; status: ContainerStatus }> {
  const { stateRoot, client } = await findStateRoot(options);
  const record = await readRecord(stateRoot, options.id);
  const inspected = await inspectContainer(client, record);
  if (isStoppedOrMissing(inspected.status.state))
    await cleanSessionSecrets(stateRoot, record);
  return { record, status: inspected.status };
}

export async function getSessionStatus(options: {
  name: string;
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<{ record: SessionRecord; status: ContainerStatus }> {
  const { stateRoot, client } = await findStateRoot(options);
  const record = await recordByName(stateRoot, options.name);
  const inspected = await inspectContainer(client, record);
  if (isStoppedOrMissing(inspected.status.state))
    await cleanSessionSecrets(stateRoot, record);
  return { record, status: inspected.status };
}

export async function listSessions(options: {
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<Array<{ record: SessionRecord; status: ContainerStatus }>> {
  const { stateRoot, client } = await findStateRoot(options);
  const entries = await readdir(join(stateRoot, "sessions"));
  const sessions: Array<{ record: SessionRecord; status: ContainerStatus }> =
    [];
  for (const entry of entries.filter((name) => name.endsWith(".json"))) {
    const id = entry.slice(0, -5);
    const record = await readRecord(stateRoot, id);
    const inspected = await inspectContainer(client, record);
    if (isStoppedOrMissing(inspected.status.state))
      await cleanSessionSecrets(stateRoot, record);
    sessions.push({ record, status: inspected.status });
  }
  return sessions;
}

export interface ExecutionReceipt {
  version: 1;
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status?: number;
  outcome: "running" | "completed" | "cancelled" | "timeout" | "error";
}

/** Execute literal argv in a verified session. Cancellation stops the container. */
export async function executeSession(options: {
  name: string;
  sessionId: string;
  argv: string[];
  cwd?: string;
  stdin?: "inherit" | Uint8Array;
  stdio?: "inherit" | "pipe";
  signal?: AbortSignal;
  timeout?: number;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<CommandResult> {
  if (!UUID.test(options.sessionId))
    fail("A valid immutable session ID is required");
  if (
    !options.argv.length ||
    options.argv.length > 256 ||
    options.argv.some(
      (value) => typeof value !== "string" || value.includes("\0"),
    ) ||
    !options.argv[0]
  )
    fail("Execution requires literal command argv without NUL bytes");
  const cwd = options.cwd ?? "/workspace";
  if (!isAbsolute(cwd) || cwd.includes("\0"))
    fail("Execution cwd must be an absolute container path");
  if (
    options.timeout !== undefined &&
    (!Number.isFinite(options.timeout) ||
      options.timeout <= 0 ||
      options.timeout > 86400)
  )
    fail("Execution timeout must be between 0 and 86400 seconds");
  options.signal?.throwIfAborted();
  const { stateRoot, client } = await findStateRoot(options);
  const record = await recordByName(stateRoot, options.name);
  if (record.id !== options.sessionId)
    fail("Session ID does not match the named session");
  const before = await inspectContainer(client, record);
  if (before.status.state !== "running")
    fail(
      `Session ${record.name} is ${before.status.state}; execution requires a running container`,
    );
  options.signal?.throwIfAborted();
  await privateDirectory(join(stateRoot, "executions"));
  const directory = await privateDirectory(
    join(stateRoot, "executions", record.id),
  );
  const receipt: ExecutionReceipt = {
    version: 1,
    id: randomUUID(),
    sessionId: record.id,
    startedAt: new Date().toISOString(),
    outcome: "running",
  };
  const path = join(directory, `${receipt.id}.json`);
  await writeFile(path, `${JSON.stringify(receipt)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const controller = new AbortController();
  let timedOut = false;
  let cancellation: Promise<void> | undefined;
  let cancellationError: unknown;
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    cancellation = (async () => {
      const current = await inspectContainer(client, record);
      if (current.status.state === "running")
        await client.checked([
          "container",
          "stop",
          "--time",
          "0",
          record.containerId,
        ]);
      const after = await inspectContainer(client, record);
      if (!isStoppedOrMissing(after.status.state))
        fail(
          "Unable to verify cancellation; the session container may still be live",
        );
      await cleanSessionSecrets(stateRoot, record);
    })().catch((error) => {
      cancellationError = error;
    });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer =
    options.timeout === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          abort();
        }, options.timeout * 1000);
  try {
    const result = await client.invoke(
      [
        "exec",
        "--interactive",
        "--workdir",
        cwd,
        "--",
        record.containerId,
        ...options.argv,
      ],
      {
        stdio: options.stdio ?? "pipe",
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        signal: controller.signal,
        ...(options.onStdout ? { onStdout: options.onStdout } : {}),
        ...(options.onStderr ? { onStderr: options.onStderr } : {}),
      },
    );
    receipt.status = result.status;
    if (controller.signal.aborted)
      fail(
        timedOut
          ? "Execution timed out; session container stopped"
          : "Execution cancelled; session container stopped",
      );
    receipt.outcome = "completed";
    return result;
  } catch (error) {
    const wasAborted = controller.signal.aborted;
    receipt.outcome = wasAborted
      ? timedOut
        ? "timeout"
        : "cancelled"
      : "error";
    // A lost exec client must not leave its command running in the container.
    if (!wasAborted) abort();
    if (wasAborted)
      fail(
        timedOut
          ? "Execution timed out; session cancellation requested"
          : "Execution cancelled; session cancellation requested",
      );
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await cancellation;
    receipt.endedAt = new Date().toISOString();
    if (cancellationError) receipt.outcome = "error";
    await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    if (cancellationError)
      fail(
        "Cancellation could not be verified; inspect and stop the session before further use",
        cancellationError,
      );
  }
}

export async function attachSession(options: {
  name: string;
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<number> {
  const { stateRoot, client } = await findStateRoot(options);
  const record = await recordByName(stateRoot, options.name);
  const before = await inspectContainer(client, record);
  if (isStoppedOrMissing(before.status.state)) {
    await cleanSessionSecrets(stateRoot, record);
    fail(
      `Session ${record.name} is ${before.status.state}; it will not be restarted`,
    );
  }
  const result = await client.invoke(
    [
      "container",
      "attach",
      "--detach-keys",
      "ctrl-p,ctrl-q",
      record.containerId,
    ],
    { stdio: "inherit" },
  );
  const after = await inspectContainer(client, record);
  if (isStoppedOrMissing(after.status.state))
    await cleanSessionSecrets(stateRoot, record);
  return result.status;
}

export async function readSessionLogsById(options: {
  id: string;
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<CommandResult> {
  const { stateRoot, client } = await findStateRoot(options);
  const record = await readRecord(stateRoot, options.id);
  const inspected = await inspectContainer(client, record);
  if (inspected.status.state === "missing")
    fail(`Container for session ${record.name} is missing`);
  const result = await client.invoke(
    ["container", "logs", record.containerId],
    { stdio: "pipe" },
  );
  if (isStoppedOrMissing(inspected.status.state))
    await cleanSessionSecrets(stateRoot, record);
  return result;
}

export async function showSessionLogs(options: {
  name: string;
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<CommandResult> {
  const { stateRoot, client } = await findStateRoot(options);
  const record = await recordByName(stateRoot, options.name);
  const status = await inspectContainer(client, record);
  if (status.status.state === "missing")
    fail(`Container for session ${record.name} is missing`);
  const result = await client.invoke(
    ["container", "logs", record.containerId],
    { stdio: "inherit" },
  );
  if (isStoppedOrMissing(status.status.state))
    await cleanSessionSecrets(stateRoot, record);
  return result;
}

export async function stopSession(options: {
  name: string;
  sessionId?: string;
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<ContainerStatus> {
  const { stateRoot, client } = await findStateRoot(options);
  const record = await recordByName(stateRoot, options.name);
  if (options.sessionId !== undefined && options.sessionId !== record.id)
    fail("Session identity changed; refusing to stop a different session");
  const before = await inspectContainer(client, record);
  if (before.status.state === "missing")
    fail(
      `Container for session ${record.name} is missing; remove the stale session explicitly`,
    );
  if (before.status.state === "paused")
    fail(
      "Session is paused; resume it before stopping so its state can be verified",
    );
  if (before.status.state === "running") {
    await client.checked([
      "container",
      "stop",
      "--time",
      "10",
      record.containerId,
    ]);
  }
  const after = await inspectContainer(client, record);
  if (!isStoppedOrMissing(after.status.state))
    fail("Podman stop returned but the workload is still live or not stopped");
  await cleanSessionSecrets(stateRoot, record);
  return after.status;
}

export async function removeSession(options: {
  name: string;
  sessionId?: string;
  stateRoot?: string;
  client?: PodmanClient;
}): Promise<void> {
  const { stateRoot, client } = await findStateRoot(options);
  const record = await recordByName(stateRoot, options.name);
  if (options.sessionId !== undefined && options.sessionId !== record.id)
    fail("Session identity changed; refusing to remove a different session");
  const before = await inspectContainer(client, record);
  if (before.status.state === "running" || before.status.state === "paused")
    fail("Stop the session before removing it");
  if (before.status.state !== "missing") {
    await client.invoke(["container", "rm", record.containerId]);
    const after = await inspectContainer(client, record);
    if (after.status.state !== "missing")
      fail("Podman removal returned but the owned container is still present");
  }
  const verified = await inspectContainer(client, record);
  if (verified.status.state !== "missing")
    fail("Refusing to delete session data while its container may still exist");
  await cleanHandoffResources(stateRoot, record, "all");
  if (record.workspaceMode === "clone") {
    await removeOwnedClone({
      stateRoot,
      sessionId: record.id,
      expectedWorkspacePath: record.workspacePath,
      containerAbsent: true,
    });
  }
  const executions = join(stateRoot, "executions", record.id);
  const executionInfo = await lstat(executions).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (executionInfo) {
    if (
      !executionInfo.isDirectory() ||
      executionInfo.isSymbolicLink() ||
      executionInfo.uid !== process.getuid?.()
    )
      fail("Execution receipt directory is unsafe; refusing removal");
    await rm(executions, { recursive: true });
  }
  await removeSessionRecord(stateRoot, record);
}
