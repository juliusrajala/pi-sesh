import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { PiSeshError } from "../errors";
import { containerPathsOverlap } from "../path-utils";

export interface RuntimeMount {
  source: string;
  destination: string;
}

function fail(message: string): never {
  throw new PiSeshError("PRESET", message);
}

export function validateRuntimeMounts(value: unknown): RuntimeMount[] {
  if (!Array.isArray(value) || value.length > 32)
    fail("Runtime mounts must be an array with at most 32 entries");
  const targets: string[] = [];
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      fail("Runtime mount must be an object");
    if (
      Object.keys(raw).some((key) => key !== "source" && key !== "destination")
    )
      fail("Unsupported runtime mount field");
    const { source, destination } = raw as RuntimeMount;
    if (
      typeof source !== "string" ||
      !isAbsolute(source) ||
      /[\0\r\n:,]/.test(source)
    )
      fail("Runtime source must be an absolute path without mount separators");
    if (
      typeof destination !== "string" ||
      !destination.startsWith("/home/session/runtime/") ||
      posix.normalize(destination) !== destination ||
      destination.endsWith("/") ||
      /[\0\r\n:,]/.test(destination)
    )
      fail(
        "Runtime destination must be a canonical path below /home/session/runtime/",
      );
    if (targets.some((target) => containerPathsOverlap(target, destination)))
      fail("Runtime destinations must not overlap");
    targets.push(destination);
    return { source, destination };
  });
}

/** Validate selected program files. Do not relabel or change host files. */
export async function runtimeMountArgs(
  value: RuntimeMount[],
): Promise<string[]> {
  const mounts = validateRuntimeMounts(value);
  const args: string[] = [];
  const home = await realpath(homedir());
  const broadRoots = [
    "/",
    "/usr",
    "/usr/bin",
    "/usr/lib",
    "/usr/lib64",
    "/usr/share",
    "/usr/local",
    "/usr/local/bin",
    "/usr/local/lib",
    "/usr/local/share",
    "/opt",
    "/etc",
    "/var",
    "/tmp",
    "/home",
    "/mnt",
    "/media",
    home,
    join(home, ".local"),
    join(home, ".local/bin"),
    join(home, ".local/share"),
  ];
  const forbiddenTrees = [
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/etc",
    "/var",
    join(home, ".config"),
    join(home, ".ssh"),
    join(home, ".gnupg"),
    join(home, ".pi"),
    join(home, ".aws"),
    join(home, ".kube"),
    join(home, ".azure"),
    join(home, ".docker"),
    join(home, ".local/share/keyrings"),
  ];
  let entries = 0;
  for (const mount of mounts) {
    const source = await realpath(mount.source);
    if (/[\0\r\n:,]/.test(source))
      fail("Resolved runtime source contains unsupported mount separators");
    if (
      broadRoots.includes(source) ||
      broadRoots.some((root) => root.startsWith(`${source}/`)) ||
      forbiddenTrees.some(
        (root) => source === root || source.startsWith(`${root}/`),
      )
    )
      fail(
        "Runtime source must select program files, not a broad host directory or credential store",
      );
    const rootInfo = await lstat(source);
    if (!rootInfo.isDirectory() && !rootInfo.isFile())
      fail("Runtime source must be a regular file or directory");
    async function visit(path: string): Promise<void> {
      if (++entries > 100_000)
        fail("Runtime files exceed the 100000-entry limit");
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        if (target !== source && !target.startsWith(`${source}/`))
          fail("Runtime symlink escapes its selected program directory");
        return;
      }
      if (
        (!info.isDirectory() && !info.isFile()) ||
        (info.uid !== process.getuid?.() && info.uid !== 0)
      )
        fail("Runtime files contain a socket, special file, or foreign owner");
      if (info.isDirectory())
        for (const child of await readdir(path)) await visit(join(path, child));
    }
    await visit(source);
    args.push(
      "--mount",
      `type=bind,src=${source},dst=${mount.destination},ro,bind-propagation=rprivate,bind-nonrecursive`,
    );
  }
  return args;
}
