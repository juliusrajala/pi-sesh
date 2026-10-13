import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Measure allocated bytes without following symlinks. */
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 256;

export async function writablePathBytes(paths: string[]): Promise<number> {
  let total = 0;
  let entries = 0;
  for (const path of paths)
    total += await pathBytes(path, 0, () => {
      entries += 1;
      if (entries > MAX_ENTRIES)
        throw new Error("Writable session data exceeds the file-count limit");
    });
  return total;
}

async function pathBytes(
  path: string,
  depth: number,
  countEntry: () => void,
): Promise<number> {
  const root = await lstat(path);
  if (root.isSymbolicLink())
    throw new Error(`Writable session path is a symbolic link: ${path}`);
  if (!root.isDirectory())
    return root.blocks > 0 ? root.blocks * 512 : root.size;
  if (depth > MAX_DEPTH)
    throw new Error("Writable session data exceeds the directory-depth limit");
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    countEntry();
    const entryPath = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await pathBytes(entryPath, depth + 1, countEntry);
      continue;
    }
    const metadata = await lstat(entryPath);
    total += metadata.blocks > 0 ? metadata.blocks * 512 : metadata.size;
  }
  return total;
}
