import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IMAGE } from "../config/config";
import { buildProjectImage } from "./podman";

export const DEFAULT_CONTAINERFILE = `FROM docker.io/oven/bun:1.3.14
RUN apt-get update \\
    && apt-get install -y --no-install-recommends git \\
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
`;

export async function buildDefaultImage(
  options: {
    pullMissingBases?: boolean;
  } = {},
) {
  const context = await mkdtemp(join(tmpdir(), "pi-sesh-default-image-"));
  try {
    const file = join(context, "Containerfile");
    await writeFile(file, DEFAULT_CONTAINERFILE, { mode: 0o600 });
    return await buildProjectImage(
      {
        projectDir: context,
        image: DEFAULT_IMAGE,
        build: { context, file },
        workspace: "mount",
        network: "none",
      },
      options,
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
