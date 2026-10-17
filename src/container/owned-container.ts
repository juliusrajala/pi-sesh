import { PiSeshError } from "../errors";
import type { ContainerStatus, SessionRecord } from "./session";
import type { PodmanClient } from "./podman";

export const OWNER_LABEL = "io.pi-sesh.owner";
export const SESSION_LABEL = "io.pi-sesh.session-id";
export const PENDING_CONTAINER_ID = "0".repeat(64);

export type OwnedContainerInspection =
  | { kind: "absent"; status: { state: "missing" } }
  | { kind: "owned"; containerId: string; status: ContainerStatus };

function fail(message: string, cause?: unknown): never {
  throw new PiSeshError("SESSION", message, { cause });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseContainerInspect(output: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    fail("Podman returned invalid container inspection data", cause);
  }
  const result = objectValue(Array.isArray(parsed) ? parsed[0] : parsed);
  if (!result) fail("Podman returned empty container inspection data");
  return result;
}

/** Return verified identity and status without changing session metadata. */
export async function inspectOwnedContainer(
  client: PodmanClient,
  record: Readonly<SessionRecord>,
): Promise<OwnedContainerInspection> {
  const pending = record.containerId === PENDING_CONTAINER_ID;
  const target = pending ? record.containerName : record.containerId;
  const exists = await client.invoke(["container", "exists", target]);
  if (exists.status === 1)
    return { kind: "absent", status: { state: "missing" } };
  if (exists.status !== 0)
    fail(
      `Podman could not determine whether container ${target} exists (exit ${exists.status})`,
    );
  const result = await client.checked([
    "container",
    "inspect",
    "--format",
    "json",
    target,
  ]);
  const item = parseContainerInspect(result.stdout);
  const stateInfo = objectValue(item.State);
  const config = objectValue(item.Config);
  const labels = objectValue(config?.Labels ?? item.Labels);
  if (
    typeof item.Id !== "string" ||
    !/^[0-9a-f]{64}$/i.test(item.Id) ||
    !stateInfo ||
    typeof stateInfo.Status !== "string" ||
    typeof stateInfo.ExitCode !== "number" ||
    !Number.isInteger(stateInfo.ExitCode)
  )
    fail("Podman returned incomplete container inspection data");
  if (!labels) fail("Podman returned invalid container labels");
  if (
    (!pending && item.Id !== record.containerId) ||
    labels[OWNER_LABEL] !== "pi-sesh" ||
    labels[SESSION_LABEL] !== record.id
  )
    fail(
      "Refusing to operate on a container not owned by this pi-sesh session",
    );

  const rawState = stateInfo.Status.toLowerCase();
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
  return {
    kind: "owned",
    containerId: item.Id,
    status:
      state === "running" || state === "created" || state === "paused"
        ? { state }
        : { state, exitCode: stateInfo.ExitCode },
  };
}

export function isStoppedOrMissing(state: ContainerStatus["state"]): boolean {
  return state === "exited" || state === "stopped" || state === "missing";
}
