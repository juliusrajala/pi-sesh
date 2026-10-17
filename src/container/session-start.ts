import { randomUUID } from "node:crypto";
import {
  DEFAULT_IMAGE,
  validateNetworkMode,
  validateWorkspaceMode,
  type EffectiveSpec,
} from "../config/config";
import { isLiteralArgv } from "../argv";
import { PiSeshError } from "../errors";
import { containerPathsOverlap } from "../path-utils";
import {
  handoffMountArgs,
  stageHandoffManifest,
  type StagedResource,
} from "../handoff/handoff";
import { runtimeMountArgs, type RuntimeMount } from "../launch/runtime";
import {
  prepareWorkspace,
  removeOwnedClone,
  type WorkspaceResult,
} from "../workspace/workspace";
import { PodmanClient, type CommandResult } from "./podman";
import {
  inspectOwnedContainer,
  isStoppedOrMissing,
  PENDING_CONTAINER_ID,
} from "./owned-container";
import type {
  buildContainerCreateArgs,
  ContainerStatus,
  SessionRecord,
  StartedSession,
  validateSessionName,
} from "./session";

type PreparedHandoff = {
  manifestPath: string;
  cleanup: () => Promise<void>;
};

export interface StartSessionOptions {
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
  }) => Promise<PreparedHandoff>;
}

export interface StartupServices {
  validateName: typeof validateSessionName;
  prepareStateRoot(client: PodmanClient, requested?: string): Promise<string>;
  reserveName(root: string, name: string, id: string): Promise<void>;
  releaseName(root: string, name: string, id: string): Promise<void>;
  writeRecord(root: string, record: SessionRecord): Promise<void>;
  deleteRecord(root: string, id: string): Promise<void>;
  cleanResources(
    root: string,
    record: SessionRecord,
    lifetime: "secret" | "all",
  ): Promise<void>;
  buildCreateArgs: typeof buildContainerCreateArgs;
}

type StartupRecord = SessionRecord & {
  resources: NonNullable<SessionRecord["resources"]>;
};
type PreparedWorkspace = { workspace: WorkspaceResult; record: StartupRecord };
type WorkspaceReady = PreparedWorkspace & { phase: "workspace-ready" };
type ResourcesReady = PreparedWorkspace & {
  phase: "resources-ready";
  createArgs: string[];
};
type ContainerCreated = PreparedWorkspace & { phase: "container-created" };
type RollbackSafeState =
  | { phase: "reserved" }
  | WorkspaceReady
  | ResourcesReady
  | (PreparedWorkspace & { phase: "container-absent" });
type StartupState =
  | RollbackSafeState
  | (PreparedWorkspace & { phase: "create-attempted" })
  | ContainerCreated
  | (PreparedWorkspace & { phase: "results-retained" });

type StartupAttempt = {
  options: StartSessionOptions;
  services: StartupServices;
  client: PodmanClient;
  stateRoot: string;
  id: string;
  imageId: string;
  selinux: boolean;
  runtimeArgs: string[];
  state: StartupState;
  temporaryHandoff?: PreparedHandoff;
};

function fail(message: string, cause?: unknown): never {
  throw new PiSeshError("SESSION", message, { cause });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startSessionWithServices(
  options: StartSessionOptions,
  services: StartupServices,
): Promise<StartedSession> {
  const attempt = await reserveStartup(options, services);
  try {
    const workspace = await prepareStartupWorkspace(attempt);
    const resources = await prepareStartupResources(attempt, workspace);
    const created = await createStartupContainer(attempt, resources);
    return await startCreatedContainer(attempt, created);
  } catch (error) {
    await recoverFailedStartup(attempt, error);
    if (error instanceof PiSeshError) throw error;
    fail(`Unable to start session: ${errorMessage(error)}`, error);
  }
}

async function validateStartupRequest(
  options: StartSessionOptions,
  services: StartupServices,
): Promise<string[]> {
  services.validateName(options.name);
  validateNetworkMode(options.spec.network);
  validateWorkspaceMode(options.spec.workspace);
  options.signal?.throwIfAborted();
  if (!isLiteralArgv(options.spec.command))
    fail("A non-empty literal command argv is required");
  const runtimeArgs = await runtimeMountArgs(options.runtimeMounts ?? []);
  if (options.handoffManifestPath && options.prepareHandoff)
    fail(
      "Use either an explicit handoff manifest or a trusted handoff preparer, not both",
    );
  return runtimeArgs;
}

async function requireLocalImage(
  client: PodmanClient,
  image: string,
): Promise<string> {
  if (!(await client.imageExists(image))) {
    const remedy =
      image === DEFAULT_IMAGE
        ? 'run "pi-sesh build-default" (use --pull if the base image is missing)'
        : "build or select an image";
    fail(`Image ${image} is not present locally; ${remedy} before starting`);
  }
  return client.imageId(image);
}

async function reserveStartup(
  options: StartSessionOptions,
  services: StartupServices,
): Promise<StartupAttempt> {
  const runtimeArgs = await validateStartupRequest(options, services);
  const client =
    options.client ??
    (await PodmanClient.create({ projectDir: options.spec.projectDir }));
  const host = await client.preflight(options.spec.network);
  const imageId = await requireLocalImage(client, options.spec.image);
  const stateRoot = await services.prepareStateRoot(client, options.stateRoot);
  const id = randomUUID();
  await services.reserveName(stateRoot, options.name, id);
  return {
    options,
    services,
    client,
    stateRoot,
    id,
    imageId,
    selinux: host.selinuxEnabled,
    runtimeArgs,
    state: { phase: "reserved" },
  };
}

async function prepareStartupWorkspace(
  attempt: StartupAttempt,
): Promise<WorkspaceReady> {
  const { options, stateRoot, id, imageId } = attempt;
  const workspace = await prepareWorkspace({
    projectDir: options.spec.projectDir,
    mode: options.spec.workspace,
    sessionId: id,
    stateRoot,
  });
  const record: StartupRecord = {
    version: 1,
    id,
    name: options.name,
    containerName: `pi-sesh-${id}`,
    containerId: PENDING_CONTAINER_ID,
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
  const state: WorkspaceReady = { phase: "workspace-ready", workspace, record };
  attempt.state = state;
  return state;
}

async function prepareStartupResources(
  attempt: StartupAttempt,
  prepared: WorkspaceReady,
): Promise<ResourcesReady> {
  const { options, services, client, stateRoot, id } = attempt;
  const { record, workspace } = prepared;
  if (options.prepareHandoff)
    attempt.temporaryHandoff = await options.prepareHandoff({
      sessionId: id,
      stateRoot,
      env: client.env,
    });
  const manifestPath =
    options.handoffManifestPath ?? attempt.temporaryHandoff?.manifestPath;
  const handoff = manifestPath
    ? await stageHandoffManifest({
        manifestPath,
        stateRoot,
        sessionId: id,
        register: async (resource) => {
          // Track the resource even if saving its recovery record fails.
          record.resources.push(resource);
          await services.writeRecord(stateRoot, record);
        },
      })
    : [];
  assertDisjointMountDestinations(handoff, options.runtimeMounts ?? []);
  await cleanTemporaryHandoff(attempt);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined)
    fail("Linux invoking UID/GID is unavailable");
  const createArgs = services.buildCreateArgs({
    record,
    spec: options.spec,
    workspace,
    uid,
    gid,
    tty: record.tty,
    interactive: !options.detached,
    runtimeMounts: attempt.runtimeArgs,
    selinux: attempt.selinux,
    handoffMounts: handoffMountArgs({
      resources: handoff,
      selinux: attempt.selinux,
    }),
    terminal: { term: client.env.TERM, colorTerm: client.env.COLORTERM },
  });
  const state: ResourcesReady = {
    phase: "resources-ready",
    workspace,
    record,
    createArgs,
  };
  attempt.state = state;
  return state;
}

function assertDisjointMountDestinations(
  handoff: StagedResource[],
  runtimeMounts: RuntimeMount[],
): void {
  for (const resource of handoff)
    for (const mount of runtimeMounts)
      if (containerPathsOverlap(resource.record.destination, mount.destination))
        fail("Runtime and handoff destinations must not overlap");
}

async function createStartupContainer(
  attempt: StartupAttempt,
  prepared: ResourcesReady,
): Promise<ContainerCreated> {
  const { record, workspace } = prepared;
  attempt.options.signal?.throwIfAborted();
  await attempt.services.writeRecord(attempt.stateRoot, record);
  // A failed create call does not prove that the container was never created.
  attempt.state = { phase: "create-attempted", workspace, record };
  const result = await attempt.client.checked(prepared.createArgs);
  const containerId = result.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(containerId))
    fail("Podman returned an invalid container ID");
  record.containerId = containerId;
  const state: ContainerCreated = {
    phase: "container-created",
    workspace,
    record,
  };
  attempt.state = state;
  await attempt.services.writeRecord(attempt.stateRoot, record);
  return state;
}

async function retainInterruptedResults(
  attempt: StartupAttempt,
  created: ContainerCreated,
  status: ContainerStatus,
): Promise<void> {
  if (!isStoppedOrMissing(status.state))
    fail("Cannot verify stop after an attached transport failure");
  // Set retention before secret cleanup, so a cleanup error cannot delete results.
  attempt.state = { ...created, phase: "results-retained" };
  await attempt.services.cleanResources(
    attempt.stateRoot,
    created.record,
    "secret",
  );
}

async function handleAttachedInterruption(
  attempt: StartupAttempt,
  created: ContainerCreated,
): Promise<void> {
  const { client } = attempt;
  const { record } = created;
  const before = await inspectOwnedContainer(client, record);
  if (before.status.state === "running")
    await client.checked([
      "container",
      "stop",
      "--time",
      "0",
      record.containerId,
    ]);
  const after = await inspectOwnedContainer(client, record);
  if (after.status.state === "created") return;
  if (!isStoppedOrMissing(after.status.state))
    fail(
      "Cannot verify launch cancellation; refusing to delete resources before verified container removal",
    );
  await retainInterruptedResults(attempt, created, after.status);
}

async function recoverAndRethrowStartError(
  attempt: StartupAttempt,
  created: ContainerCreated,
  error: unknown,
): Promise<never> {
  if (!attempt.options.detached) {
    try {
      await handleAttachedInterruption(attempt, created);
    } catch (cause) {
      throw new AggregateError(
        [error, cause],
        "Attached launch and interruption recovery failed",
      );
    }
  }
  throw error;
}

async function invokeContainerStart(
  attempt: StartupAttempt,
  created: ContainerCreated,
): Promise<CommandResult> {
  const { options, client } = attempt;
  const { record } = created;
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
  try {
    options.signal?.throwIfAborted();
    const result = await client.invoke(startArgs, {
      stdio: detached ? "pipe" : "inherit",
      ...(detached ? {} : { signal: options.signal }),
    });
    if (options.signal?.aborted) throw new Error("Launch cancelled");
    return result;
  } catch (error) {
    return recoverAndRethrowStartError(attempt, created, error);
  }
}

async function resolveStartOutcome(
  attempt: StartupAttempt,
  created: ContainerCreated,
  result: CommandResult,
): Promise<ContainerStatus> {
  const { client } = attempt;
  const { record } = created;
  const detached = attempt.options.detached ?? false;
  const current = await inspectOwnedContainer(client, record);
  if (current.kind === "absent")
    fail("Podman container disappeared during startup");
  if (!detached && result.status !== 0 && current.status.state === "running") {
    await client.checked([
      "container",
      "stop",
      "--time",
      "0",
      record.containerId,
    ]);
    const after = await inspectOwnedContainer(client, record);
    await retainInterruptedResults(attempt, created, after.status);
    fail(`Podman attached transport failed (exit ${result.status})`);
  }
  if (
    result.status !== 0 &&
    (detached ||
      current.status.state === "running" ||
      current.status.state === "created")
  ) {
    const diagnostic = summarizeEngineDiagnostic(result.stderr);
    fail(
      `Podman failed to start the session (exit ${result.status})${diagnostic ? `: ${diagnostic}` : ""}`,
    );
  }
  return current.status;
}

async function startCreatedContainer(
  attempt: StartupAttempt,
  created: ContainerCreated,
): Promise<StartedSession> {
  const { options } = attempt;
  const { record } = created;
  const detached = options.detached ?? false;
  const result = await invokeContainerStart(attempt, created);
  const status = await resolveStartOutcome(attempt, created, result);
  if (isStoppedOrMissing(status.state))
    await attempt.services.cleanResources(attempt.stateRoot, record, "secret");
  if (detached) options.signal?.throwIfAborted();
  return {
    id: record.id,
    name: record.name,
    containerId: record.containerId,
    state: status.state,
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    detached,
  };
}

function summarizeEngineDiagnostic(stderr: string): string | undefined {
  const message = stderr
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) return undefined;
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
}

async function cleanTemporaryHandoff(attempt: StartupAttempt): Promise<void> {
  if (!attempt.temporaryHandoff) return;
  await attempt.temporaryHandoff.cleanup();
  attempt.temporaryHandoff = undefined;
}

async function verifyRollbackPermission(
  attempt: StartupAttempt,
): Promise<RollbackSafeState> {
  const state = attempt.state;
  switch (state.phase) {
    case "reserved":
    case "workspace-ready":
    case "resources-ready":
    case "container-absent":
      return state;
    case "results-retained":
      fail("Refusing to roll back retained session results");
    case "create-attempted":
    case "container-created": {
      const before = await inspectOwnedContainer(attempt.client, state.record);
      if (before.kind === "owned") {
        state.record.containerId = before.containerId;
        await attempt.client.invoke([
          "container",
          "rm",
          "--force",
          before.containerId,
        ]);
      }
      const after = await inspectOwnedContainer(attempt.client, state.record);
      if (after.kind !== "absent")
        fail("Container removal could not be verified");
      const absent: RollbackSafeState = { ...state, phase: "container-absent" };
      attempt.state = absent;
      return absent;
    }
  }
}

async function cleanRollbackResources(
  attempt: StartupAttempt,
  state: RollbackSafeState,
): Promise<unknown[]> {
  if (state.phase === "reserved") return [];
  const failures: unknown[] = [];
  try {
    await attempt.services.cleanResources(
      attempt.stateRoot,
      state.record,
      "all",
    );
  } catch (cause) {
    failures.push(cause);
  }
  if (state.workspace.mode === "clone") {
    try {
      await removeOwnedClone({
        stateRoot: attempt.stateRoot,
        sessionId: attempt.id,
        expectedWorkspacePath: state.workspace.path,
        containerAbsent: true,
      });
    } catch (cause) {
      failures.push(cause);
    }
  }
  return failures;
}

async function recoverFailedStartup(
  attempt: StartupAttempt,
  error: unknown,
): Promise<void> {
  if (attempt.state.phase === "results-retained")
    fail(
      `Launch interrupted; stopped session ${attempt.options.name} and its results remain available`,
      error,
    );

  const failures: unknown[] = [];
  let rollback: RollbackSafeState | undefined;
  try {
    rollback = await verifyRollbackPermission(attempt);
  } catch (cause) {
    failures.push(cause);
  }
  // Temporary inputs are not mounted. They can be removed even when container status is unknown.
  try {
    await cleanTemporaryHandoff(attempt);
  } catch (cause) {
    failures.push(cause);
  }
  if (rollback)
    failures.push(...(await cleanRollbackResources(attempt, rollback)));
  if (failures.length === 0) {
    try {
      await attempt.services.deleteRecord(attempt.stateRoot, attempt.id);
      await attempt.services.releaseName(
        attempt.stateRoot,
        attempt.options.name,
        attempt.id,
      );
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0)
    await reportStartupRecoveryFailure(attempt, error, failures);
}

async function reportStartupRecoveryFailure(
  attempt: StartupAttempt,
  error: unknown,
  failures: unknown[],
): Promise<never> {
  const state = attempt.state;
  if (state.phase !== "reserved") {
    try {
      await attempt.services.writeRecord(attempt.stateRoot, state.record);
    } catch (cause) {
      failures.push(cause);
    }
  }
  throw new PiSeshError(
    "SESSION",
    `Startup failed (${errorMessage(error)}) and owned resources could not be fully cleaned (${failures.map(errorMessage).join("; ")}); session ${attempt.options.name} remains reserved for recovery`,
    {
      cause: new AggregateError(
        [error, ...failures],
        "Startup and recovery failed",
      ),
    },
  );
}
