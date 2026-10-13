import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPresetHandoff,
  generatedSessionName,
  launchPresetsPath,
  loadLaunchPreset,
  preparePresetHandoff,
  type LaunchPreset,
} from "./preset";

const temporaryDirectories: string[] = [];

async function configFixture(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh preset "));
  temporaryDirectories.push(root);
  const configDirectory = join(root, "pi-sesh");
  await mkdir(configDirectory, { mode: 0o700 });
  const path = join(configDirectory, "launchers.json");
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return { root, configDirectory, path, env: { XDG_CONFIG_HOME: root } };
}

const validPreset: LaunchPreset = {
  image: "localhost/user-agent:local",
  command: ["pi", "--no-approve"],
  workspace: "mount",
  network: "none",
};

async function validConfig(preset: unknown = validPreset) {
  return configFixture({ version: 1, presets: { pi: preset } });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("uses the absolute XDG config location and ignores project paths", () => {
  expect(launchPresetsPath({ XDG_CONFIG_HOME: "/tmp/user config" })).toBe(
    "/tmp/user config/pi-sesh/launchers.json",
  );
  expect(launchPresetsPath({ XDG_CONFIG_HOME: "relative" })).toContain(
    "/.config/pi-sesh/launchers.json",
  );
});

test("loads a bounded user-owned preset with literal argv", async () => {
  const { env } = await validConfig({
    ...validPreset,
    command: ["pi", "--model", "openai-codex/example model", "$HOME"],
    environment: { NODE_ENV: "development", LITERAL_VALUE: "$HOME" },
    prepare: ["/usr/bin/bash", "/home/user/pi-prepare.sh"],
  });
  const preset = await loadLaunchPreset("pi", env);
  expect(preset.command).toEqual([
    "pi",
    "--model",
    "openai-codex/example model",
    "$HOME",
  ]);
  expect(preset.environment).toEqual({
    NODE_ENV: "development",
    LITERAL_VALUE: "$HOME",
  });
  expect(preset.prepare).toEqual(["/usr/bin/bash", "/home/user/pi-prepare.sh"]);
});

test("rejects malformed, unknown, and lifecycle-reserved preset config", async () => {
  const cases = [
    { version: 2, presets: { pi: validPreset } },
    { version: 1, presets: { pi: { ...validPreset, extra: true } } },
    { version: 1, presets: { pi: { ...validPreset, command: ["pi", ""] } } },
    { version: 1, presets: { attach: validPreset, pi: validPreset } },
    { version: 1, presets: { launch: validPreset, pi: validPreset } },
    { version: 1, presets: { "build-default": validPreset, pi: validPreset } },
    { version: 1, presets: { "setup-prompt": validPreset, pi: validPreset } },
    {
      version: 1,
      presets: { pi: { ...validPreset, environment: { HOME: "/host" } } },
    },
    {
      version: 1,
      presets: {
        pi: { ...validPreset, environment: { OPENAI_API_KEY: "fake" } },
      },
    },
  ];
  for (const value of cases) {
    const { env } = await configFixture(value);
    await expect(loadLaunchPreset("pi", env)).rejects.toThrow();
  }
});

test("agent presets may use the project image and selected external programs", async () => {
  const { env } = await validConfig({
    command: ["/home/session/runtime/agent/agent"],
    workspace: "clone",
    network: "none",
    runtime: [
      {
        source: "/selected/program",
        destination: "/home/session/runtime/agent",
      },
    ],
  });
  const loaded = await loadLaunchPreset("pi", env);
  expect(loaded.image).toBeUndefined();
  expect(loaded.runtime?.[0]?.source).toBe("/selected/program");
});

test("reports an unknown preset name", async () => {
  const { env } = await validConfig();
  await expect(loadLaunchPreset("missing", env)).rejects.toThrow(
    'No user launch preset named "missing"',
  );
});

test("rejects missing presets and config files with broad permissions", async () => {
  const missing = await configFixture({ version: 1, presets: {} });
  await expect(loadLaunchPreset("pi", missing.env)).rejects.toThrow(
    "No user launch preset named",
  );

  const publicConfig = await validConfig();
  await chmod(publicConfig.path, 0o644);
  await expect(loadLaunchPreset("pi", publicConfig.env)).rejects.toThrow(
    "private",
  );
});

test("rejects symlinked preset files", async () => {
  const fixture = await validConfig();
  const real = join(fixture.root, "real.json");
  await writeFile(real, await Bun.file(fixture.path).text(), { mode: 0o600 });
  await rm(fixture.path);
  await symlink(real, fixture.path);
  await expect(loadLaunchPreset("pi", fixture.env)).rejects.toThrow(
    "private, regular, and bounded",
  );
});

test("generates usable session names", () => {
  expect(generatedSessionName()).toMatch(/^pi-[0-9a-f]{32}$/);
});

test("preparation ignores project node_modules executables in caller PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh prepare path "));
  temporaryDirectories.push(root);
  const projectBin = join(root, "project", "node_modules", ".bin");
  await mkdir(projectBin, { recursive: true, mode: 0o700 });
  const marker = join(root, "intercepted");
  const fakeLs = join(projectBin, "ls");
  await writeFile(
    fakeLs,
    `#!/usr/bin/bash\nprintf intercepted > '${marker}'\nexit 99\n`,
    { mode: 0o700 },
  );
  await chmod(fakeLs, 0o700);

  const previousPath = process.env.PATH;
  process.env.PATH = `:${projectBin}::`;
  let prepared: Awaited<ReturnType<typeof preparePresetHandoff>>;
  try {
    prepared = await preparePresetHandoff(
      {
        ...validPreset,
        prepare: [
          "/usr/bin/bash",
          "-c",
          'set -e; umask 077; ls --version >/dev/null 2>&1; printf \'{"version":1,"resources":[]}\\n\' > "$PI_SESH_PREPARE_DIR/handoff.json"',
        ],
      },
      "pi-path-test",
    );
    expect(prepared).toBeDefined();
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await cleanupPresetHandoff(prepared);
  }
});

test("loads a private prepared runtime manifest without retaining temporary program sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh prepared-runtime "));
  temporaryDirectories.push(root);
  const runtime = join(root, "program");
  await mkdir(runtime);
  const mounts = [
    { source: runtime, destination: "/home/session/runtime/agent" },
  ];
  const prepared = await preparePresetHandoff(
    {
      ...validPreset,
      prepare: [
        "/bin/sh",
        "-c",
        'umask 077; printf \'{"version":1,"resources":[]}\\n\' > "$PI_SESH_PREPARE_DIR/handoff.json"; printf "%s\\n" "$1" > "$PI_SESH_PREPARE_DIR/runtime.json"',
        "preparer",
        JSON.stringify({ version: 1, mounts }),
      ],
    },
    "prepared-agent",
  );
  try {
    expect(prepared?.runtimeMounts).toEqual(mounts);
  } finally {
    await cleanupPresetHandoff(prepared);
  }
});

test("preparation cancellation removes its private staging directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh prepare-cancel "));
  temporaryDirectories.push(root);
  const marker = join(root, "directory");
  const controller = new AbortController();
  const failed = preparePresetHandoff(
    {
      ...validPreset,
      prepare: [
        "/bin/sh",
        "-c",
        'printf "%s" "$PI_SESH_PREPARE_DIR" > "$1"; exec /bin/sleep 120',
        "preparer",
        marker,
      ],
    },
    "cancel-prepare",
    controller.signal,
  ).then(
    () => undefined,
    (error) => error,
  );
  try {
    for (
      let attempt = 0;
      !(await Bun.file(marker).exists()) && attempt < 100;
      attempt++
    )
      await Bun.sleep(10);
    const directory = await Bun.file(marker).text();
    controller.abort();
    expect(await failed).toBeInstanceOf(Error);
    await expect(
      import("node:fs/promises").then(({ stat }) => stat(directory)),
    ).rejects.toThrow();
  } finally {
    controller.abort();
    await failed;
  }
});

test("runs only the explicitly selected preparation argv and validates its manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sesh prepare "));
  temporaryDirectories.push(root);
  const script = join(root, "prepare.sh");
  await writeFile(
    script,
    'umask 077\nprintf \'{"version":1,"resources":[]}\\n\' > "$PI_SESH_PREPARE_DIR/handoff.json"\n',
    { mode: 0o700 },
  );
  const prepared = await preparePresetHandoff(
    { ...validPreset, prepare: ["/bin/sh", script] },
    "pi-test",
  );
  expect(prepared).toBeDefined();
  expect(await Bun.file(prepared!.manifestPath).text()).toContain(
    '"resources":[]',
  );
  await cleanupPresetHandoff(prepared);
  expect(await Bun.file(prepared!.directory).exists()).toBe(false);
});
