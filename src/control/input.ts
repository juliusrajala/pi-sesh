import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLiteralArgv } from "../argv";
import type { SessionArtifactInput, SessionSecretInput } from "./index";

const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_WRITABLE_BYTES = 64 * 1024 * 1024 * 1024;

export function validateControlOptions(
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

export function validateCommand(command: string[]): string[] {
  if (!isLiteralArgv(command, { maxArguments: 256 }))
    throw new Error("Command must be a non-empty literal argv array");
  return [...command];
}

export function validateArtifactInputs(
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

export function validateSecretInputs(
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

export async function createHandoffManifest(
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
