import type {
  PiSeshSession,
  PiSeshSessionState,
  SessionArtifact,
} from "./index";
import type { ContainerStatus, SessionRecord } from "../container/session";
import { stagedResourcePath } from "../handoff/handoff";
import { writablePathBytes } from "./usage";

export function measureWritableData(
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

export function sessionArtifacts(
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

export function toPublicSession(
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

export function isTerminal(state: PiSeshSessionState): boolean {
  return state === "exited" || state === "stopped" || state === "missing";
}

export async function delay(
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
