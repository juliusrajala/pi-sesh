import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEffectiveSpec,
  validateContainerEnvironment,
  validateImageReference,
} from "../config/config";
import { buildProjectImage, selectLocalImage } from "../container/podman";
import {
  getSessionStatusById,
  listSessions,
  executeSession,
  readSessionLogsById,
  removeSession,
  startSession,
  stopSession,
  type ContainerStatus,
  type SessionRecord,
} from "../container/session";
import { PiSeshError } from "../errors";
export { PiSeshError } from "../errors";
import { stagedResourcePath } from "../handoff/handoff";
import { defaultStateRoot } from "../workspace/workspace";
import { writablePathBytes } from "./usage";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WRITABLE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_WRITABLE_BYTES = 64 * 1024 * 1024 * 1024;

export type PiSeshNetwork = "none" | "pasta";
export type PiSeshWorkspaceMode = "mount" | "clone";
export type PiSeshSessionState =
  | "created"
  | "running"
  | "exited"
  | "stopped"
  | "missing"
  | "paused";

export interface PiSeshSessionStatus {
  state: PiSeshSessionState;
  exitCode?: number;
}

export interface BuildImageResult {
  tag: string;
  imageId: string;
  podmanVersion: string;
}

export interface SelectedImage {
  tag: string;
  imageId: string;
}

export interface BuildImageInput {
  projectDir: string;
  image: string;
  context: string;
  file: string;
  pullMissingBases?: boolean;
}

export interface SessionArtifactInput {
  id: string;
  destination: string;
}

export interface SessionSecretInput {
  id: string;
  destination: string;
  content: string | Uint8Array;
}

export interface StartSessionInput {
  name: string;
  image: string;
  workspace: { path: string; mode: PiSeshWorkspaceMode };
  command: string[];
  network?: PiSeshNetwork;
  environment?: Record<string, string>;
  /** Explicit secret files. Pi-sesh removes them when the worker stops. */
  secrets?: SessionSecretInput[];
  artifacts?: SessionArtifactInput[];
}

export interface SessionArtifact {
  id: string;
  destination: string;
  hostPath: string;
}

export interface PiSeshSession {
  id: string;
  name: string;
  imageId: string;
  projectDir: string;
  workspacePath: string;
  workspace: PiSeshWorkspaceMode;
  network: PiSeshNetwork;
  state: PiSeshSessionState;
  exitCode?: number;
  artifacts: SessionArtifact[];
}

export interface SessionResult extends PiSeshSession {
  reason?: "workspace-limit" | "missing";
}

export interface SessionExecOutput {
  stream: "stdout" | "stderr";
  chunk: Uint8Array;
}

export interface SessionExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  onOutput?: (output: SessionExecOutput) => void;
}

export interface SessionExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface SessionLogs {
  /** Podman combines the workload's stdout and stderr in its logs output. */
  output: string;
  /** Exit status of the Podman logs command, not the worker. */
  engineStatus: number;
  diagnostic: string;
}

export interface PiSeshControlOptions {
  /** Use the same private state root after service restarts. */
  stateRoot?: string;
  /** Aggregate writable-data byte limit for the workspace and handoff resources. */
  maxWritableBytes?: number;
  /** Status and workspace-size polling interval. */
  pollIntervalMs?: number;
}

export interface PiSeshControl {
  images: {
    build(input: BuildImageInput): Promise<BuildImageResult>;
    select(image: string, projectDir: string): Promise<SelectedImage>;
  };
  sessions: {
    start(input: StartSessionInput): Promise<PiSeshSession>;
    list(): Promise<PiSeshSession[]>;
    inspect(id: string): Promise<PiSeshSession>;
    wait(
      id: string,
      options?: { signal?: AbortSignal },
    ): Promise<SessionResult>;
    exec(
      id: string,
      argv: string[],
      options?: SessionExecOptions,
    ): Promise<SessionExecResult>;
    logs(id: string): Promise<SessionLogs>;
    artifacts(id: string): Promise<SessionArtifact[]>;
    stop(id: string): Promise<PiSeshSessionStatus>;
    remove(id: string): Promise<void>;
  };
}

/** Create a Bun/Linux control plane over pi-sesh's existing session store. */
export function createPiSesh(
  options: PiSeshControlOptions = {},
): PiSeshControl {
  const stateRoot = options.stateRoot ?? defaultStateRoot(process.env);
  const maxWritableBytes =
    options.maxWritableBytes ?? DEFAULT_MAX_WRITABLE_BYTES;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  validateControlOptions(maxWritableBytes, pollIntervalMs);

  const inspectRecord = (id: string) => getSessionStatusById({ id, stateRoot });
  const inspect = async (id: string) =>
    toPublicSession(await inspectRecord(id), stateRoot);

  const artifacts = async (id: string) => {
    const { record } = await getSessionStatusById({ id, stateRoot });
    return sessionArtifacts(record, stateRoot);
  };
  const stopById = async (id: string) => {
    const { record } = await getSessionStatusById({ id, stateRoot });
    return stopSession({ name: record.name, sessionId: id, stateRoot });
  };

  return {
    images: {
      async build(input) {
        const spec = await resolveEffectiveSpec({
          projectDir: input.projectDir,
          purpose: "build",
          ignoreProjectConfig: true,
          overrides: {
            image: input.image,
            context: input.context,
            file: input.file,
          },
        });
        return buildProjectImage(spec, {
          pullMissingBases: input.pullMissingBases,
        });
      },
      select(image, projectDir) {
        return selectLocalImage(image, { projectDir });
      },
    },
    sessions: {
      async start(input) {
        if (!input.name || !input.workspace?.path)
          throw new Error("Session name and workspace path are required");
        if (
          input.workspace.mode !== "mount" &&
          input.workspace.mode !== "clone"
        )
          throw new Error('Workspace mode must be "mount" or "clone"');
        const command = validateCommand(input.command);
        const image = validateImageReference(input.image);
        const network = input.network ?? "none";
        if (network !== "none" && network !== "pasta")
          throw new Error('Network must be "none" or "pasta"');
        const environment = validateContainerEnvironment(
          input.environment ?? {},
          "session environment",
        );
        const artifactInputs = validateArtifactInputs(input.artifacts ?? []);
        const secretInputs = validateSecretInputs(
          input.secrets ?? [],
          artifactInputs,
        );
        const spec = {
          projectDir: input.workspace.path,
          image,
          workspace: input.workspace.mode,
          command,
          network,
          environment,
        };
        const started = await startSession({
          name: input.name,
          spec,
          detached: true,
          tty: false,
          stateRoot,
          ...(artifactInputs.length || secretInputs.length
            ? {
                prepareHandoff: () =>
                  createHandoffManifest(artifactInputs, secretInputs),
              }
            : {}),
        });
        return inspect(started.id);
      },
      async list() {
        const sessions = await listSessions({ stateRoot });
        return Promise.all(
          sessions.map(({ record, status }) =>
            toPublicSession({ record, status }, stateRoot),
          ),
        );
      },
      inspect,
      async wait(id, waitOptions = {}) {
        while (true) {
          waitOptions.signal?.throwIfAborted();
          const details = await inspectRecord(id);
          const session = toPublicSession(details, stateRoot);
          if (session.state === "missing")
            return { ...session, reason: "missing" };
          if (isTerminal(session.state)) {
            let finalBytes: number;
            try {
              finalBytes = await measureWritableData(
                session,
                details.record,
                stateRoot,
              );
            } catch (cause) {
              throw new PiSeshError(
                "SESSION",
                "Unable to measure final writable session data",
                { cause },
              );
            }
            return {
              ...session,
              ...(finalBytes > maxWritableBytes
                ? { reason: "workspace-limit" as const }
                : {}),
            };
          }
          if (session.state !== "running")
            throw new PiSeshError(
              "SESSION",
              `Cannot wait for session ${session.name} while it is ${session.state}`,
            );
          let bytes: number;
          try {
            bytes = await measureWritableData(
              session,
              details.record,
              stateRoot,
            );
          } catch (cause) {
            await stopById(id);
            throw new PiSeshError(
              "SESSION",
              "Unable to measure writable session data; the session was stopped",
              { cause },
            );
          }
          if (bytes > maxWritableBytes) {
            const status = await stopById(id);
            return {
              ...session,
              state: status.state,
              ...(status.exitCode === undefined
                ? {}
                : { exitCode: status.exitCode }),
              reason: "workspace-limit",
            };
          }
          await delay(pollIntervalMs, waitOptions.signal);
        }
      },
      async exec(id, argv, execOptions = {}) {
        const { record } = await inspectRecord(id);
        const result = await executeSession({
          name: record.name,
          sessionId: id,
          argv,
          cwd: execOptions.cwd,
          timeout: execOptions.timeout,
          signal: execOptions.signal,
          ...(execOptions.onOutput
            ? {
                onStdout: (chunk) =>
                  execOptions.onOutput?.({ stream: "stdout", chunk }),
                onStderr: (chunk) =>
                  execOptions.onOutput?.({ stream: "stderr", chunk }),
              }
            : {}),
          stdio: "pipe",
          stateRoot,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          status: result.status,
        };
      },
      async logs(id) {
        const result = await readSessionLogsById({ id, stateRoot });
        return {
          output: result.stdout,
          diagnostic: result.stderr,
          engineStatus: result.status,
        };
      },
      artifacts,
      stop: stopById,
      async remove(id) {
        const { record } = await getSessionStatusById({ id, stateRoot });
        await removeSession({ name: record.name, sessionId: id, stateRoot });
      },
    },
  };
}

function validateControlOptions(
  maxBytes: number,
  pollIntervalMs: number,
): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_WRITABLE_BYTES
  )
    throw new Error(
      `maxWritableBytes must be between 1 and ${MAX_WRITABLE_BYTES}`,
    );
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 50 ||
    pollIntervalMs > MAX_POLL_INTERVAL_MS
  )
    throw new Error(
      `pollIntervalMs must be between 50 and ${MAX_POLL_INTERVAL_MS}`,
    );
}

function validateCommand(command: string[]): string[] {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 256 ||
    command.some(
      (part) =>
        typeof part !== "string" || part.length === 0 || part.includes("\0"),
    )
  )
    throw new Error("Command must be a non-empty literal argv array");
  return [...command];
}

function validateArtifactInputs(
  artifacts: SessionArtifactInput[],
): SessionArtifactInput[] {
  if (!Array.isArray(artifacts) || artifacts.length > 8)
    throw new Error("A session can select at most 8 artifact directories");
  return artifacts.map((artifact) => {
    if (
      !artifact ||
      typeof artifact.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(artifact.id) ||
      typeof artifact.destination !== "string" ||
      !artifact.destination.startsWith("/home/session/")
    )
      throw new Error("Artifact IDs and destinations are invalid");
    return { id: artifact.id, destination: artifact.destination };
  });
}

function validateSecretInputs(
  secrets: SessionSecretInput[],
  artifacts: SessionArtifactInput[],
): SessionSecretInput[] {
  if (!Array.isArray(secrets) || secrets.length > 24)
    throw new Error("A session can select at most 24 secret files");
  const ids = new Set(artifacts.map(({ id }) => id));
  let totalBytes = 0;
  const validated = secrets.map((secret) => {
    if (
      !secret ||
      typeof secret.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(secret.id) ||
      ids.has(secret.id) ||
      typeof secret.destination !== "string" ||
      !secret.destination.startsWith("/home/session/") ||
      (typeof secret.content !== "string" &&
        !(secret.content instanceof Uint8Array))
    )
      throw new Error("Secret file IDs, destinations, or content are invalid");
    ids.add(secret.id);
    const content =
      typeof secret.content === "string"
        ? new TextEncoder().encode(secret.content)
        : new Uint8Array(secret.content);
    totalBytes += content.byteLength;
    if (totalBytes > 64 * 1024 * 1024)
      throw new Error("Secret files exceed the 64 MiB handoff limit");
    return { ...secret, content };
  });
  return validated;
}

async function createHandoffManifest(
  artifacts: SessionArtifactInput[],
  secrets: SessionSecretInput[],
): Promise<{ manifestPath: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sesh-control-"));
  try {
    await chmod(directory, 0o700);
    const manifestPath = join(directory, "handoff.json");
    const resources: Record<string, string>[] = artifacts.map(
      ({ id, destination }) => ({
        id,
        kind: "owned-directory",
        destination,
        lifetime: "retained",
      }),
    );
    if (secrets.length)
      await mkdir(join(directory, "secret-files"), { mode: 0o700 });
    for (const secret of secrets) {
      const source = `secret-files/${secret.id}`;
      const content =
        typeof secret.content === "string"
          ? new TextEncoder().encode(secret.content)
          : new Uint8Array(secret.content);
      await writeFile(join(directory, source), content, {
        mode: 0o600,
        flag: "wx",
      });
      resources.push({
        id: secret.id,
        kind: "snapshot",
        source,
        destination: secret.destination,
        access: "rw",
        lifetime: "secret",
      });
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify({ version: 1, resources })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return {
      manifestPath,
      cleanup: () => rm(directory, { recursive: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function measureWritableData(
  session: PiSeshSession,
  record: SessionRecord,
  stateRoot: string,
): Promise<number> {
  return writablePathBytes([
    session.workspacePath,
    ...sessionWritablePaths(record, stateRoot),
  ]);
}

function sessionWritablePaths(
  record: SessionRecord,
  stateRoot: string,
): string[] {
  return (record.resources ?? [])
    .filter(
      (resource) =>
        resource.kind === "owned-directory" ||
        (resource.kind === "snapshot" && resource.access === "rw"),
    )
    .map((resource) => stagedResourcePath(stateRoot, record.id, resource.id));
}

function sessionArtifacts(
  record: SessionRecord,
  stateRoot: string,
): SessionArtifact[] {
  return (record.resources ?? [])
    .filter((resource) => resource.kind === "owned-directory")
    .map((resource) => ({
      id: resource.id,
      destination: resource.destination,
      hostPath: stagedResourcePath(stateRoot, record.id, resource.id),
    }));
}

function toPublicSession(
  value: { record: SessionRecord; status: ContainerStatus },
  stateRoot: string,
): PiSeshSession {
  const { record, status } = value;
  return {
    id: record.id,
    name: record.name,
    imageId: record.imageId,
    projectDir: record.projectDir,
    workspacePath: record.workspacePath,
    workspace: record.workspaceMode,
    network: record.network,
    state: status.state,
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    artifacts: sessionArtifacts(record, stateRoot),
  };
}

function isTerminal(state: PiSeshSessionState): boolean {
  return state === "exited" || state === "stopped" || state === "missing";
}

async function delay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
