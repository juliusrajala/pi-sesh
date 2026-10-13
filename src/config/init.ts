import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  loadConfig,
  validateImageReference,
  type WorkspaceMode,
} from "./config";

export interface InitProjectOptions {
  image?: string;
  file?: string;
  workspace?: WorkspaceMode;
}

/** Create project inputs. Do not change recipes or shared agent settings. */
export async function initProject(
  folder: string,
  options: InitProjectOptions = {},
) {
  const project = await realpath(resolve(folder));
  if (!(await stat(project)).isDirectory())
    throw new Error("Project must be a directory");
  const path = join(project, "pi-sesh.json");
  const existing = await loadConfig(project);
  if (existing.config) return { path, created: false };

  let recipe: string | undefined;
  for (const candidate of options.file
    ? [options.file]
    : ["Containerfile", "Dockerfile"]) {
    const target = resolve(project, candidate);
    const entry = await lstat(target).catch((error) => {
      if (error.code === "ENOENT" && !options.file) return undefined;
      throw error;
    });
    if (!entry) continue;
    const canonical = await realpath(target);
    const inside = relative(project, canonical);
    if (inside === ".." || inside.startsWith("../"))
      throw new Error("Build recipe must stay inside the project");
    if (!(await stat(canonical)).isFile())
      throw new Error("Build recipe must be a regular file");
    recipe = relative(project, target);
    break;
  }
  if (!recipe && !options.image)
    throw new Error(
      "No Containerfile or Dockerfile. Select an existing development image with --image, or add a project recipe first. No files were changed.",
    );

  const slug =
    basename(project)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40) || "project";
  const hash = new Bun.CryptoHasher("sha256")
    .update(project)
    .digest("hex")
    .slice(0, 8);
  const image = validateImageReference(
    options.image ?? `localhost/pi-sesh-${slug}:${hash}`,
  );
  const config = {
    version: 1,
    image,
    ...(recipe ? { build: { context: ".", file: recipe } } : {}),
    workspace: options.workspace ?? "mount",
    network: "none",
  };
  const file = await open(path, "wx", 0o644);
  try {
    await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
  } finally {
    await file.close();
  }
  return { path, created: true };
}
