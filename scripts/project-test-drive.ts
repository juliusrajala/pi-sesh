import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const usage = `Opt-in, no-network workspace smoke using the compiled pi-sesh binary.

bun scripts/project-test-drive.ts --project <directory> --representative <relative-file> [options]

Options:
  --pi-sesh <absolute path>       Compiled pi-sesh (default: dist/pi-sesh)
  --image <local image>           Image with bash, git, fd, and rg
  --workload-exit <0-255>         Requested workload exit for lifecycle testing

The driver ignores project pi-sesh.json and mounts the caller project read/write,
but runs only fixed read-only checks. It never loads host auth or contacts a provider.`;

function parseArgs(argv: string[]) {
  if (argv.length === 0 || argv.includes("--help")) {
    console.log(usage);
    process.exit(0);
  }
  const allowed = new Set([
    "--project",
    "--representative",
    "--pi-sesh",
    "--image",
    "--workload-exit",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!;
    if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${key} requires a value`);
    values.set(key, value);
  }
  const project = values.get("--project");
  const representative = values.get("--representative");
  const image = values.get("--image");
  if (!project || !representative || !image)
    throw new Error("--project, --representative, and --image are required");
  const workloadExit = Number(values.get("--workload-exit") ?? "0");
  if (!Number.isInteger(workloadExit) || workloadExit < 0 || workloadExit > 255)
    throw new Error("--workload-exit must be an integer from 0 through 255");
  const defaultBinary = resolve(import.meta.dir, "../dist/pi-sesh");
  const piSesh = resolve(values.get("--pi-sesh") ?? defaultBinary);
  if (!isAbsolute(piSesh))
    throw new Error("--pi-sesh must be an absolute path");
  return {
    project: resolve(project),
    representative,
    piSesh,
    image,
    workloadExit,
  };
}

async function run(
  args: string[],
  cwd?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn({
    cmd: args,
    ...(cwd ? { cwd } : {}),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { status, stdout, stderr };
}

async function piSesh(binary: string, args: string[], cwd: string) {
  const result = await run([binary, ...args], cwd);
  if (result.status !== 0)
    throw new Error(
      `pi-sesh ${args[0]} failed (exit ${result.status}): ${result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const project = await realpath(options.project);
  const projectInfo = await lstat(project);
  if (projectInfo.isSymbolicLink() || !projectInfo.isDirectory())
    throw new Error("--project must resolve to a regular directory");
  const relativePath = options.representative;
  if (
    isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "--representative must be a normalized relative path inside the project",
    );
  const hostFile = resolve(project, relativePath);
  if (!isWithin(project, hostFile))
    throw new Error("Representative file escapes the project");
  const fileInfo = await lstat(hostFile);
  const canonicalFile = await realpath(hostFile);
  if (
    fileInfo.isSymbolicLink() ||
    !fileInfo.isFile() ||
    canonicalFile !== hostFile ||
    !isWithin(project, canonicalFile)
  ) {
    throw new Error(
      "Representative path must be a regular in-project file, not a symlink",
    );
  }
  await access(hostFile, constants.R_OK);
  await access(options.piSesh, constants.X_OK);

  const configDir = await mkdtemp(join(tmpdir(), "pi-sesh-drive-"));
  const configFile = join(configDir, "config.json");
  const sessionName = `drive-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    await writeFile(
      configFile,
      `${JSON.stringify({ version: 1, image: options.image, workspace: "mount", network: "none" })}\n`,
      { mode: 0o600 },
    );
    const command = [
      "bash",
      "-c",
      'set -eu; printf "cwd=%s\\n" "$PWD"; test -r "$1"; printf "representative=readable\\n"; printf "git="; git --version; printf "rg="; rg --version | head -n 1; printf "fd="; fd --version; exit "$2"',
      "pi-sesh-test-drive",
      `/workspace/${relativePath}`,
      String(options.workloadExit),
    ];
    const result = await run(
      [
        options.piSesh,
        "start",
        "--config",
        configFile,
        "--name",
        sessionName,
        "--image",
        options.image,
        "--network",
        "none",
        "--workspace",
        "mount",
        "--detach",
        project,
        "--",
        ...command,
      ],
      project,
    );
    if (result.status !== 0)
      throw new Error(
        `pi-sesh start failed (exit ${result.status}): ${result.stderr.trim()}`,
      );
    started = true;

    let inspection: Record<string, unknown> | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const value = await piSesh(
        options.piSesh,
        ["inspect", sessionName],
        project,
      );
      inspection = JSON.parse(value) as Record<string, unknown>;
      if (inspection.state === "exited") break;
      await Bun.sleep(100);
    }
    if (!inspection || inspection.state !== "exited") {
      await piSesh(options.piSesh, ["stop", sessionName], project);
      inspection = JSON.parse(
        await piSesh(options.piSesh, ["inspect", sessionName], project),
      ) as Record<string, unknown>;
    }
    if (
      inspection.name !== sessionName ||
      inspection.workspace !== "mount" ||
      inspection.network !== "none" ||
      typeof inspection.imageId !== "string" ||
      !/^[0-9a-f]{64}$/i.test(inspection.imageId)
    )
      throw new Error(
        "Session inspection did not match the requested smoke policy",
      );

    const logResult = await run([options.piSesh, "logs", sessionName], project);
    if (logResult.status !== 0)
      throw new Error(
        `pi-sesh logs failed (exit ${logResult.status}): ${logResult.stderr.trim()}`,
      );
    const exitCode = inspection.exitCode;
    const expected = options.workloadExit;
    const log = logResult.stdout;
    if (
      exitCode !== expected ||
      !log.includes(`cwd=/workspace`) ||
      !log.includes("representative=readable") ||
      !log.includes("git=") ||
      !log.includes("rg=") ||
      !log.includes("fd=")
    )
      throw new Error(
        `Workspace smoke did not match expected exit ${expected}`,
      );

    console.log(
      JSON.stringify({
        project,
        representative: relativePath,
        image: options.image,
        imageId: inspection.imageId,
        sessionId: inspection.id,
        workspace: inspection.workspace,
        network: inspection.network,
        exitCode,
        evidence:
          "cwd=/workspace; representative readable; git/rg/fd available; logs retained",
      }),
    );
  } finally {
    if (started) {
      try {
        const value = await piSesh(
          options.piSesh,
          ["inspect", sessionName],
          project,
        );
        const inspection = JSON.parse(value) as Record<string, unknown>;
        if (inspection.name === sessionName && inspection.state === "exited")
          await piSesh(options.piSesh, ["remove", sessionName], project);
      } catch {
        console.error(
          `pi-sesh test-drive cleanup incomplete for owned session ${sessionName}; inspect it before manual recovery`,
        );
      }
    }
    await rm(configDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(
    `project-test-drive: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
