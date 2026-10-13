import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IMAGE, resolveEffectiveSpec } from "./config";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi sesh config "));
  temporaryDirectories.push(root);
  const project = join(root, "selected project");
  await mkdir(project);
  await writeFile(join(project, "Containerfile"), "FROM scratch\n");
  return { root, project };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeConfig(project: string, value: unknown) {
  await Bun.write(join(project, "pi-sesh.json"), JSON.stringify(value));
}

test("resolves config defaults and canonical build paths", async () => {
  const { project } = await fixture();
  await writeConfig(project, {
    version: 1,
    image: "localhost/example-dev:local",
    build: { context: ".", file: "Containerfile" },
    command: ["sh", "-lc", "printf '$HOME'"],
  });

  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
  });
  expect(spec.projectDir).toBe(project);
  expect(spec.build).toEqual({
    context: project,
    file: join(project, "Containerfile"),
  });
  expect(spec.command).toEqual(["sh", "-lc", "printf '$HOME'"]);
  expect(spec.workspace).toBe("mount");
  expect(spec.network).toBe("none");
});

test("CLI values override file values and command argv replaces config command", async () => {
  const { project } = await fixture();
  await writeConfig(project, {
    version: 1,
    image: "localhost/from-file:tag",
    workspace: "clone",
    network: "pasta",
    command: ["from-config"],
  });

  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
    overrides: {
      image: "localhost/from-cli:tag",
      workspace: "mount",
      network: "none",
      command: ["sh", "-lc", "echo '$HOME'"],
    },
  });
  expect(spec.image).toBe("localhost/from-cli:tag");
  expect(spec.workspace).toBe("mount");
  expect(spec.network).toBe("none");
  expect(spec.command).toEqual(["sh", "-lc", "echo '$HOME'"]);
});

test("trusted launch presets can ignore project config completely", async () => {
  const { project } = await fixture();
  await writeConfig(project, {
    version: 1,
    image: "localhost/from-project:tag",
    command: ["project-launcher"],
    prepare: ["project-script"],
  });
  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
    ignoreProjectConfig: true,
    overrides: {
      image: "localhost/user-preset:tag",
      workspace: "mount",
      network: "none",
      command: ["pi", "--literal", "$HOME"],
    },
  });
  expect(spec.image).toBe("localhost/user-preset:tag");
  expect(spec.command).toEqual(["pi", "--literal", "$HOME"]);
  expect(spec.network).toBe("none");
  expect(spec.configFile).toBeUndefined();
});

test("preset defaults merge safe project values without using project commands, builds, or network", async () => {
  const { project } = await fixture();
  await writeConfig(project, {
    version: 1,
    image: "localhost/project-image:local",
    build: { context: "../outside", file: "missing.Containerfile" },
    workspace: "clone",
    command: ["project-command"],
    network: "pasta",
    environment: { PROJECT_PROFILE: "project", SHARED_VALUE: "project" },
  });

  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
    projectDefaultsOnly: true,
    presetDefaults: {
      image: "localhost/user-image:local",
      workspace: "mount",
      network: "none",
      environment: { USER_VALUE: "preset", SHARED_VALUE: "preset" },
    },
    overrides: {
      command: ["pi", "--offline"],
      environment: { CLI_VALUE: "explicit", SHARED_VALUE: "cli" },
    },
  });
  expect(spec.image).toBe("localhost/project-image:local");
  expect(spec.workspace).toBe("clone");
  expect(spec.network).toBe("none");
  expect(spec.build).toBeUndefined();
  expect(spec.command).toEqual(["pi", "--offline"]);
  expect(spec.environment).toEqual({
    USER_VALUE: "preset",
    SHARED_VALUE: "cli",
    PROJECT_PROFILE: "project",
    CLI_VALUE: "explicit",
  });

  const explicit = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
    projectDefaultsOnly: true,
    presetDefaults: {
      image: "localhost/user-image:local",
      workspace: "mount",
      network: "none",
    },
    overrides: {
      image: "localhost/cli-image:local",
      workspace: "mount",
      network: "pasta",
      command: ["pi"],
    },
  });
  expect(explicit.image).toBe("localhost/cli-image:local");
  expect(explicit.workspace).toBe("mount");
  expect(explicit.network).toBe("pasta");
});

test("project environment rejects reserved, credential-like, and unsafe values", async () => {
  const { project } = await fixture();
  for (const environment of [
    { HOME: "/tmp/host" },
    { PI_CODING_AGENT_DIR: "/tmp/agent" },
    { OPENAI_API_KEY: "not-a-real-key" },
    { OPENAI_BASE_URL: "https://provider.invalid" },
    { HTTPS_PROXY: "https://proxy.invalid" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { GIT_CONFIG_COUNT: "1" },
    { GIT_SSH_COMMAND: "./workspace-helper" },
    { SSH_AUTH_SOCK: "/host/socket" },
    { NODE_OPTIONS: "--require injected.js" },
    { database_url: "not-a-secret" },
    { NODE_ENV: "one\ntwo" },
    { NODE_ENV: "x".repeat(4097) },
    Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`VALUE_${index}`, "x"]),
    ),
    Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `VALUE_${index}`,
        "x".repeat(4000),
      ]),
    ),
  ]) {
    await writeConfig(project, { version: 1, environment });
    await expect(
      resolveEffectiveSpec({
        projectDir: project,
        purpose: "start",
        projectDefaultsOnly: true,
        presetDefaults: {
          image: "localhost/user-image:local",
          workspace: "mount",
          network: "none",
        },
        overrides: { command: ["pi"] },
      }),
    ).rejects.toThrow();
  }
});

test("project preset fields cannot select host preparation or resources", async () => {
  const { project } = await fixture();
  for (const extra of [
    { prepare: ["/tmp/host-script"] },
    { resources: ["/home/host-secret"] },
    { auth: "/home/host/.pi/agent/auth.json" },
  ]) {
    await writeConfig(project, { version: 1, ...extra });
    await expect(
      resolveEffectiveSpec({
        projectDir: project,
        purpose: "start",
        projectDefaultsOnly: true,
        presetDefaults: {
          image: "localhost/user-image:local",
          workspace: "mount",
          network: "none",
        },
        overrides: { command: ["pi"] },
      }),
    ).rejects.toThrow("Unsupported configuration field");
  }
});

test("an absent project image uses the shared default image", async () => {
  const { project } = await fixture();
  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
    overrides: { command: ["tool", "--literal"] },
  });
  expect(spec.image).toBe(DEFAULT_IMAGE);
  expect(spec.command).toEqual(["tool", "--literal"]);
});

test("a user preset image takes precedence over the shared default", async () => {
  const { project } = await fixture();
  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
    presetDefaults: {
      image: "localhost/user-agent:local",
      workspace: "mount",
      network: "none",
    },
    overrides: { command: ["agent"] },
  });
  expect(spec.image).toBe("localhost/user-agent:local");
});

test("an absent default config works with explicit image and command", async () => {
  const { project } = await fixture();
  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
    overrides: {
      image: "localhost/tool:local",
      command: ["tool", "--literal"],
    },
  });
  expect(spec.configFile).toBeUndefined();
  expect(spec.image).toBe("localhost/tool:local");
  expect(spec.command).toEqual(["tool", "--literal"]);
});

test("build resolution does not require a runtime command", async () => {
  const { project } = await fixture();
  await writeConfig(project, {
    version: 1,
    image: "localhost/build-only:local",
    build: { context: ".", file: "Containerfile" },
  });
  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "build",
  });
  expect(spec.command).toBeUndefined();
});

test("an explicit config may live outside the project but cannot widen build access", async () => {
  const { root, project } = await fixture();
  const externalConfig = join(root, "external.json");
  await writeFile(
    externalConfig,
    JSON.stringify({
      version: 1,
      image: "localhost/external-config:local",
      build: { context: project, file: join(project, "Containerfile") },
    }),
  );
  const spec = await resolveEffectiveSpec({
    projectDir: project,
    configFile: externalConfig,
    purpose: "build",
  });
  expect(spec.configFile).toBe(externalConfig);
  expect(spec.build?.context).toBe(project);

  const outsideContext = join(root, "outside");
  await mkdir(outsideContext);
  await writeFile(join(outsideContext, "Containerfile"), "FROM scratch\n");
  await writeFile(
    externalConfig,
    JSON.stringify({
      version: 1,
      image: "localhost/outside:local",
      build: {
        context: outsideContext,
        file: join(outsideContext, "Containerfile"),
      },
    }),
  );
  await expect(
    resolveEffectiveSpec({
      projectDir: project,
      configFile: externalConfig,
      purpose: "build",
    }),
  ).rejects.toThrow("inside the selected project");
});

test("build paths resolve relative to the config directory and support spaces", async () => {
  const { project } = await fixture();
  await mkdir(join(project, "build context"));
  await writeFile(
    join(project, "build context", "Containerfile"),
    "FROM scratch\n",
  );
  await writeConfig(project, {
    version: 1,
    image: "localhost/path-test:local",
    build: { context: "build context", file: "build context/Containerfile" },
  });
  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "build",
  });
  expect(spec.build).toEqual({
    context: join(project, "build context"),
    file: join(project, "build context", "Containerfile"),
  });
});

test("missing explicit config is an error", async () => {
  const { project } = await fixture();
  await expect(
    resolveEffectiveSpec({
      projectDir: project,
      configFile: join(project, "absent.json"),
      purpose: "start",
    }),
  ).rejects.toThrow("Explicit config file not found");
});

test("bounded JSON loading rejects oversized files", async () => {
  const { project } = await fixture();
  await Bun.write(
    join(project, "pi-sesh.json"),
    `{"version":1,"padding":"${"x".repeat(1024 * 1024)}"}`,
  );
  await expect(
    resolveEffectiveSpec({ projectDir: project, purpose: "start" }),
  ).rejects.toThrow("exceeds 1048576 bytes");
});

test("invalid JSON, versions, and unknown fields are rejected", async () => {
  const { project } = await fixture();
  await Bun.write(join(project, "pi-sesh.json"), "{");
  await expect(
    resolveEffectiveSpec({ projectDir: project, purpose: "start" }),
  ).rejects.toThrow("Invalid JSON");

  await writeConfig(project, { version: 2 });
  await expect(
    resolveEffectiveSpec({ projectDir: project, purpose: "start" }),
  ).rejects.toThrow("version must be 1");

  await writeConfig(project, { version: 1, hostMount: "/home/user" });
  await expect(
    resolveEffectiveSpec({ projectDir: project, purpose: "start" }),
  ).rejects.toThrow("Unsupported configuration field");
});

test("default config symlinks may not escape the selected project", async () => {
  const { root, project } = await fixture();
  const external = join(root, "other.json");
  await writeFile(
    external,
    JSON.stringify({
      version: 1,
      image: "localhost/safe:local",
      command: ["true"],
    }),
  );
  await symlink(external, join(project, "pi-sesh.json"));
  await expect(
    resolveEffectiveSpec({ projectDir: project, purpose: "start" }),
  ).rejects.toThrow("symlink must resolve inside the selected project");
});

test("malicious-looking command text remains literal argv data", async () => {
  const { project } = await fixture();
  const command = ["sh", "-lc", "$(touch /tmp/no-host-exec) && $HOME"];
  await writeConfig(project, {
    version: 1,
    image: "localhost/literal:local",
    command,
  });
  const spec = await resolveEffectiveSpec({
    projectDir: project,
    purpose: "start",
  });
  expect(spec.command).toEqual(command);
});

test("invalid image and empty runtime command are rejected", async () => {
  const { project } = await fixture();
  await expect(
    resolveEffectiveSpec({
      projectDir: project,
      purpose: "start",
      overrides: { image: "--privileged", command: ["true"] },
    }),
  ).rejects.toThrow("image must be a valid");
  await expect(
    resolveEffectiveSpec({
      projectDir: project,
      purpose: "start",
      overrides: { image: "localhost/ok:tag" },
    }),
  ).rejects.toThrow("Specify a command");
});
