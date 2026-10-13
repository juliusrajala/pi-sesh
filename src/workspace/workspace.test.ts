import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace, removeOwnedClone } from "./workspace";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh workspace "));
  temporaryDirectories.push(root);
  const project = join(root, "source project");
  const stateRoot = join(root, "session state");
  await mkdir(project);
  return { root, project, stateRoot };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function initCommittedRepo(project: string) {
  await git(project, ["init", "--initial-branch=main"]);
  await git(project, ["config", "user.name", "Test User"]);
  await git(project, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(project, ".gitignore"), "ignored-secret\n");
  await writeFile(join(project, "source.txt"), "committed at local HEAD\n");
  await git(project, ["add", ".gitignore", "source.txt"]);
  await git(project, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial",
  ]);
}

const sessionId = "11111111-1111-4111-8111-111111111111";

test("mount workspace resolves a symlink and never owns caller data", async () => {
  const { root, project } = await fixture();
  await writeFile(join(project, "keep.txt"), "keep me");
  const alias = join(root, "project alias");
  await symlink(project, alias);
  const workspace = await prepareWorkspace({
    projectDir: alias,
    mode: "mount",
    sessionId,
  });
  expect(workspace.path).toBe(project);
  await writeFile(join(workspace.path, "edit.txt"), "caller-owned");
  expect(await readFile(join(project, "edit.txt"), "utf8")).toBe(
    "caller-owned",
  );
  expect(workspace.mode).toBe("mount");
  expect(workspace.ownershipToken).toBeUndefined();
  expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("keep me");
});

test("clone is independent, starts at local HEAD, and excludes ignored files", async () => {
  const { project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  await writeFile(join(project, "ignored-secret"), "must not be cloned");
  const revision = await git(project, ["rev-parse", "HEAD"]);
  const clone = await prepareWorkspace({
    projectDir: project,
    mode: "clone",
    sessionId,
    stateRoot,
  });
  expect(clone.sourceRevision).toBe(revision);
  expect(await readFile(join(clone.path, "source.txt"), "utf8")).toBe(
    "committed at local HEAD\n",
  );
  await expect(
    readFile(join(clone.path, "ignored-secret"), "utf8"),
  ).rejects.toThrow();
  await writeFile(join(clone.path, "source.txt"), "clone edit\n");
  expect(await readFile(join(project, "source.txt"), "utf8")).toBe(
    "committed at local HEAD\n",
  );
  await expect(
    readFile(join(clone.path, ".git", "objects", "info", "alternates"), "utf8"),
  ).rejects.toThrow();
  expect(await git(clone.path, ["remote", "-v"])).toBe("");
});

test("clone rejects dirty and untracked sources without changing them", async () => {
  const { project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  await writeFile(join(project, "source.txt"), "dirty edit\n");
  const id = "22222222-2222-4222-8222-222222222222";
  await expect(
    prepareWorkspace({
      projectDir: project,
      mode: "clone",
      sessionId: id,
      stateRoot,
    }),
  ).rejects.toThrow("requires a clean Git worktree");
  expect(await readFile(join(project, "source.txt"), "utf8")).toBe(
    "dirty edit\n",
  );
  await writeFile(join(project, "source.txt"), "committed at local HEAD\n");
  await writeFile(join(project, "untracked.txt"), "keep source file\n");
  await expect(
    prepareWorkspace({
      projectDir: project,
      mode: "clone",
      sessionId: id,
      stateRoot,
    }),
  ).rejects.toThrow("requires a clean Git worktree");
  expect(await readFile(join(project, "untracked.txt"), "utf8")).toBe(
    "keep source file\n",
  );
});

test("malicious local Git configuration is rejected before Git can execute it", async () => {
  const { root, project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  const marker = join(root, "host-marker");
  await git(project, [
    "config",
    "--local",
    "filter.test.clean",
    `touch ${marker}`,
  ]);
  const id = "33333333-3333-4333-8333-333333333333";
  await expect(
    prepareWorkspace({
      projectDir: project,
      mode: "clone",
      sessionId: id,
      stateRoot,
    }),
  ).rejects.toThrow(
    "Unsupported execution-affecting local Git config: filter.test.clean",
  );
  await expect(readFile(marker, "utf8")).rejects.toThrow();
});

test("Git includes are inspected but never followed", async () => {
  const { root, project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  const markerConfig = join(root, "included-config");
  await writeFile(
    markerConfig,
    `[core]\n    fsmonitor = !touch ${join(root, "included-marker")}\n`,
  );
  await git(project, ["config", "--local", "include.path", markerConfig]);
  await expect(
    prepareWorkspace({
      projectDir: project,
      mode: "clone",
      sessionId: "44444444-4444-4444-8444-444444444444",
      stateRoot,
    }),
  ).rejects.toThrow(
    "Unsupported execution-affecting local Git config: include.path",
  );
  await expect(
    readFile(join(root, "included-marker"), "utf8"),
  ).rejects.toThrow();
});

test("filter attributes and symlinked attribute files are rejected", async () => {
  const { root, project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  await writeFile(join(project, ".gitattributes"), "*.txt filter=custom\n");
  await expect(
    prepareWorkspace({
      projectDir: project,
      mode: "clone",
      sessionId: "55555555-5555-4555-8555-555555555555",
      stateRoot,
    }),
  ).rejects.toThrow("Git filter attributes are unsupported");

  await rm(join(project, ".gitattributes"));
  const external = join(root, "attributes");
  await writeFile(external, "*.txt text\n");
  await symlink(external, join(project, ".gitattributes"));
  await expect(
    prepareWorkspace({
      projectDir: project,
      mode: "clone",
      sessionId: "66666666-6666-4666-8666-666666666666",
      stateRoot,
    }),
  ).rejects.toThrow("Symlinked or non-regular Git attribute file");
});

test("shared Git storage, linked metadata and submodules are rejected", async () => {
  const { project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  await mkdir(join(project, ".git", "objects", "info"), { recursive: true });
  await writeFile(
    join(project, ".git", "objects", "info", "alternates"),
    "/tmp/other-objects\n",
  );
  await expect(
    prepareWorkspace({
      projectDir: project,
      mode: "clone",
      sessionId: "77777777-7777-4777-8777-777777777777",
      stateRoot,
    }),
  ).rejects.toThrow("objects/info/alternates is unsupported");
});

test("session IDs reserve clone paths and a duplicate cannot clean up the first clone", async () => {
  const { project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  const first = await prepareWorkspace({
    projectDir: project,
    mode: "clone",
    sessionId,
    stateRoot,
  });
  await expect(
    prepareWorkspace({
      projectDir: project,
      mode: "clone",
      sessionId,
      stateRoot,
    }),
  ).rejects.toThrow();
  expect(await readFile(join(first.path, "source.txt"), "utf8")).toContain(
    "committed",
  );
});

test("clone removal refuses running, forged, or path-substituted ownership", async () => {
  const { project, stateRoot, root } = await fixture();
  await initCommittedRepo(project);
  const clone = await prepareWorkspace({
    projectDir: project,
    mode: "clone",
    sessionId,
    stateRoot,
  });
  await expect(
    removeOwnedClone({
      stateRoot,
      sessionId,
      expectedWorkspacePath: clone.path,
      containerAbsent: false,
    }),
  ).rejects.toThrow("while its container exists");

  const recordPath = join(stateRoot, "workspace-records", `${sessionId}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  record.workspacePath = root;
  await writeFile(recordPath, JSON.stringify(record));
  await expect(
    removeOwnedClone({
      stateRoot,
      sessionId,
      expectedWorkspacePath: clone.path,
      containerAbsent: true,
    }),
  ).rejects.toThrow("ownership record does not match");
  expect(await readFile(join(clone.path, "source.txt"), "utf8")).toContain(
    "committed",
  );

  record.workspacePath = clone.path;
  await writeFile(recordPath, JSON.stringify(record));
  const movedPath = `${clone.path}.moved`;
  await rename(clone.path, movedPath);
  await symlink(root, clone.path);
  await expect(
    removeOwnedClone({
      stateRoot,
      sessionId,
      expectedWorkspacePath: clone.path,
      containerAbsent: true,
    }),
  ).rejects.toThrow("replaced or foreign clone workspace");
  expect(await readFile(join(movedPath, "source.txt"), "utf8")).toContain(
    "committed",
  );
});

test("explicit remove deletes only the session-owned clone", async () => {
  const { project, stateRoot } = await fixture();
  await initCommittedRepo(project);
  const clone = await prepareWorkspace({
    projectDir: project,
    mode: "clone",
    sessionId,
    stateRoot,
  });
  const workspaceInfo = await Bun.file(clone.path).stat();
  const ownerInfo = await Bun.file(
    join(stateRoot, "workspace-records", `${sessionId}.json`),
  ).stat();
  expect(workspaceInfo.mode & 0o777).toBe(0o700);
  expect(ownerInfo.mode & 0o777).toBe(0o600);
  await removeOwnedClone({
    stateRoot,
    sessionId,
    expectedWorkspacePath: clone.path,
    containerAbsent: true,
  });
  await expect(readFile(clone.path, "utf8")).rejects.toThrow();
  expect(await readFile(join(project, "source.txt"), "utf8")).toContain(
    "committed",
  );
});
