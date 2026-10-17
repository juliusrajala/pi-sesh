import {
  resolveEffectiveSpec,
  type NetworkMode,
  type WorkspaceMode,
} from "../config/config";
import {
  OPEN_ENVIRONMENT_COMMAND,
  getSessionStatusById,
  startSession,
  stopSession,
  validateSessionName,
  type StartedSession,
} from "../container/session";
import { isLiteralArgv } from "../argv";
import { PiSeshError } from "../errors";
import {
  cleanupPresetHandoff,
  loadLaunchPreset,
  preparePresetHandoff,
} from "./preset";

export interface PresetSessionInput {
  preset: string;
  projectDir: string;
  name: string;
  configFile?: string;
  image?: string;
  workspace?: WorkspaceMode;
  network?: NetworkMode;
  environment?: Record<string, string>;
  args?: string[];
  open?: boolean;
  detached?: boolean;
  tty?: boolean;
  signal?: AbortSignal;
  stateRoot?: string;
}

export interface PresetSessionDependencies {
  loadLaunchPreset?: typeof loadLaunchPreset;
  preparePresetHandoff?: typeof preparePresetHandoff;
  cleanupPresetHandoff?: typeof cleanupPresetHandoff;
  startSession?: typeof startSession;
}

/** Keep session identity available when a post-start operation fails. */
export class PresetSessionError extends PiSeshError {
  readonly session?: StartedSession;

  constructor(message: string, cause: unknown, session?: StartedSession) {
    super("PRESET", message, { cause });
    this.session = session;
  }
}

/** Launch a preset, or open its environment for later execution. */
export async function startPresetSession(
  input: PresetSessionInput,
  dependencies: PresetSessionDependencies = {},
) {
  input.signal?.throwIfAborted();
  validateSessionName(input.name);
  if (
    input.args !== undefined &&
    !isLiteralArgv(input.args, { allowEmpty: true })
  )
    throw new PiSeshError(
      "PRESET",
      "Preset arguments must be literal argv strings",
    );
  const preset = await (dependencies.loadLaunchPreset ?? loadLaunchPreset)(
    input.preset,
  );
  const command = [...preset.command, ...(input.args ?? [])];
  if (input.open && !isLiteralArgv(command, { maxArguments: 256 }))
    throw new PiSeshError(
      "PRESET",
      "Opened preset command must contain at most 256 literal argv strings",
    );
  const spec = await resolveEffectiveSpec({
    projectDir: input.projectDir,
    configFile: input.configFile,
    purpose: "start",
    projectDefaultsOnly: true,
    presetDefaults: {
      image: preset.image,
      workspace: preset.workspace,
      network: preset.network,
      ...(preset.environment ? { environment: preset.environment } : {}),
    },
    overrides: {
      image: input.image,
      workspace: input.workspace,
      network: input.network,
      command: input.open ? [...OPEN_ENVIRONMENT_COMMAND] : command,
      ...(input.environment ? { environment: input.environment } : {}),
    },
  });
  if (
    preset.prepare &&
    preset.image &&
    !input.image &&
    spec.image !== preset.image
  )
    throw new Error(
      "A project cannot select an image for a preset with host preparation; use --image to confirm the image explicitly",
    );

  let prepared: Awaited<ReturnType<typeof preparePresetHandoff>>;
  let session: StartedSession | undefined;
  let failed = false;
  let primaryError: unknown;
  try {
    input.signal?.throwIfAborted();
    prepared = await (
      dependencies.preparePresetHandoff ?? preparePresetHandoff
    )(preset, input.name, input.signal);
    input.signal?.throwIfAborted();
    session = await (dependencies.startSession ?? startSession)({
      name: input.name,
      spec,
      detached: input.open ? true : input.detached,
      tty: input.open ? false : input.tty,
      signal: input.signal,
      stateRoot: input.stateRoot,
      runtimeMounts: [
        ...(preset.runtime ?? []),
        ...(prepared?.runtimeMounts ?? []),
      ],
      ...(prepared ? { handoffManifestPath: prepared.manifestPath } : {}),
    });
    return { session, command };
  } catch (error) {
    failed = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      await (dependencies.cleanupPresetHandoff ?? cleanupPresetHandoff)(
        prepared,
      );
    } catch (cause) {
      const cleanupMessage = `Unable to remove private preset preparation data at ${prepared?.directory ?? "the temporary directory"} for session ${input.name}`;
      throw new PresetSessionError(
        failed
          ? `Preset startup failed (${primaryError instanceof Error ? primaryError.message : String(primaryError)}); ${cleanupMessage}`
          : `${cleanupMessage}; session ${session?.id ?? input.name} remains available for inspection`,
        failed
          ? new AggregateError(
              [primaryError, cause],
              "Preset startup and cleanup failed",
            )
          : cause,
        session,
      );
    }
  }
}

/** Verify readiness without deleting a session whose status is uncertain. */
export async function openPresetSession(
  input: Omit<PresetSessionInput, "open" | "args" | "detached" | "tty">,
  dependencies: PresetSessionDependencies & {
    getSessionStatusById?: typeof getSessionStatusById;
    stopSession?: typeof stopSession;
  } = {},
) {
  const { session, command } = await startPresetSession(
    { ...input, open: true },
    dependencies,
  );
  try {
    const details = await (
      dependencies.getSessionStatusById ?? getSessionStatusById
    )({
      id: session.id,
      stateRoot: input.stateRoot,
    });
    if (input.signal?.aborted) {
      await (dependencies.stopSession ?? stopSession)({
        name: session.name,
        sessionId: session.id,
        stateRoot: input.stateRoot,
      });
      input.signal.throwIfAborted();
    }
    if (details.status.state !== "running")
      throw new Error(
        `Preset environment is ${details.status.state}; the image requires /bin/sh and sleep`,
      );
    return { ...details, command };
  } catch (cause) {
    throw new PresetSessionError(
      `Unable to verify preset environment ${session.name} (${session.id}); inspect its status and logs before recovery`,
      cause,
      session,
    );
  }
}
