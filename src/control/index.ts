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
} from "../container/session";
import { PiSeshError } from "../errors";
export { PiSeshError } from "../errors";
import { defaultStateRoot } from "../workspace/workspace";
import { openPresetSession } from "../launch/session";
export { PresetSessionError } from "../launch/session";
import {
  createHandoffManifest,
  validateArtifactInputs,
  validateCommand,
  validateControlOptions,
  validateSecretInputs,
} from "./input";
import {
  delay,
  isTerminal,
  measureWritableData,
  sessionArtifacts,
  toPublicSession,
} from "./session-data";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WRITABLE_BYTES = 4 * 1024 * 1024 * 1024;
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

export interface OpenPresetInput {
  preset: string;
  name: string;
  projectDir: string;
  image?: string;
  workspace?: PiSeshWorkspaceMode;
  network?: PiSeshNetwork;
  signal?: AbortSignal;
}

export interface PresetSession extends PiSeshSession {
  /** Resolved preset argv. Append workload arguments when calling exec. */
  command: string[];
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
    openPreset(input: OpenPresetInput): Promise<PresetSession>;
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
      async openPreset(input) {
        const { record, status, command } = await openPresetSession({
          preset: input.preset,
          name: input.name,
          projectDir: input.projectDir,
          image: input.image,
          workspace: input.workspace,
          network: input.network,
          signal: input.signal,
          stateRoot,
        });
        return { ...toPublicSession({ record, status }, stateRoot), command };
      },
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
