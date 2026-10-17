import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Return true when child is parent or a descendant of parent. */
export function isPathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** Compare canonical container paths without matching sibling name prefixes. */
export function containerPathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export async function ensureOwnedPrivateDirectory(
  path: string,
  message: string,
  fail: (message: string, cause?: unknown) => never,
): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.()
  )
    fail(message);
  await chmod(path, 0o700);
  return resolve(path);
}
