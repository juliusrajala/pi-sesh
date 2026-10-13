import { Crust, type CrustPlugin } from "@crustjs/core";
import { helpPlugin, noColorPlugin, renderHelp } from "@crustjs/plugins";
import { initProject } from "../config/init";
import packageInfo from "../../package.json";
import { setupPrompt } from "./setup-prompt";
import {
  resolveEffectiveSpec,
  validateContainerEnvironment,
  type NetworkMode,
  type WorkspaceMode,
} from "../config/config";
import { buildProjectImage } from "../container/podman";
import { defaultStateRoot } from "../workspace/workspace";
import { stagedResourcePath } from "../handoff/handoff";
import {
  cleanupPresetHandoff,
  generatedSessionName,
  loadLaunchPreset,
  preparePresetHandoff,
} from "../launch/preset";
import {
  attachSession,
  executeSession,
  getSessionStatus,
  listSessions,
  removeSession,
  showSessionLogs,
  startSession,
  stopSession,
} from "../container/session";
import { bulkSessionAction } from "./session-actions";
import { outputUsesColor, printSessionList } from "./session-list";

const version = packageInfo.version;

const nativeColorPlugin = noColorPlugin();
const colorPlugin: CrustPlugin = {
  ...nativeColorPlugin,
  middleware(context, next) {
    if (
      context.input &&
      context.input.flags.color === undefined &&
      !outputUsesColor()
    ) {
      context = {
        ...context,
        input: {
          ...context.input,
          flags: { ...context.input.flags, color: false },
        },
      };
    }
    return nativeColorPlugin.middleware!(context, next);
  },
};

const nativeHelpPlugin = helpPlugin();
const cliHelpPlugin: CrustPlugin = {
  ...nativeHelpPlugin,
  middleware(context, next) {
    if (
      context.route &&
      context.input?.flags.help === true &&
      (context.input.flags.color === false ||
        (context.input.flags.color !== true && !outputUsesColor()))
    ) {
      console.log(
        Bun.stripANSI(
          renderHelp(context.route.command, [...context.route.commandPath]),
        ),
      );
      return;
    }
    return nativeHelpPlugin.middleware!(context, next);
  },
};

const versionPlugin: CrustPlugin = {
  name: "pi-sesh-version",
  middleware: ({ route, input }, next) => {
    if (!route || !input) return next();
    const flags = input.flags as Record<string, unknown>;
    if (flags.version === true) {
      console.log(`pi-sesh ${version}`);
      process.exitCode = 0;
      return;
    }
    return next();
  },
};

export interface CliDependencies {
  buildImage?: typeof buildProjectImage;
  startSession?: typeof startSession;
  executeSession?: typeof executeSession;
  attachSession?: typeof attachSession;
  getSessionStatus?: typeof getSessionStatus;
  listSessions?: typeof listSessions;
  removeSession?: typeof removeSession;
  showSessionLogs?: typeof showSessionLogs;
  stopSession?: typeof stopSession;
  loadLaunchPreset?: typeof loadLaunchPreset;
  preparePresetHandoff?: typeof preparePresetHandoff;
  cleanupPresetHandoff?: typeof cleanupPresetHandoff;
  currentDirectory?: () => string;
}

type PresetLaunchFlags = {
  config?: string;
  env?: string[];
  image?: string;
  name?: string;
  workspace?: string;
  network?: string;
  detach?: boolean;
  tty?: boolean;
};

const presetLaunchFlags = {
  config: { type: "string", description: "Select safe project defaults" },
  env: {
    type: "string",
    multiple: true,
    description: "Set a literal container variable as NAME=VALUE",
  },
  image: {
    type: "string",
    description: "Select the project development image",
  },
  name: {
    type: "string",
    description: "Session name (generated when omitted)",
  },
  workspace: {
    type: "string",
    choices: ["mount", "clone"],
    description: "Override the workspace mode",
  },
  network: {
    type: "string",
    choices: ["none", "pasta"],
    description: "Override the preset network mode",
  },
  detach: { type: "boolean", description: "Return after launch" },
  tty: { type: "boolean", description: "Allocate a TTY" },
} as const;

function parseEnvironmentFlags(values: string[] | undefined) {
  const environment = Object.create(null) as Record<string, string>;
  for (const entry of values ?? []) {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("--env must use NAME=VALUE syntax");
    const name = entry.slice(0, separator);
    if (Object.hasOwn(environment, name))
      throw new Error(`--env repeats variable ${name}`);
    environment[name] = entry.slice(separator + 1);
  }
  return validateContainerEnvironment(environment, "CLI environment");
}

async function launchUserPreset(
  presetName: string,
  flags: PresetLaunchFlags,
  rawArgs: string[],
  dependencies: CliDependencies,
): Promise<void> {
  const preset = await (dependencies.loadLaunchPreset ?? loadLaunchPreset)(
    presetName,
  );
  const sessionName = flags.name ?? generatedSessionName();
  const projectDir = dependencies.currentDirectory?.() ?? process.cwd();
  const environment = parseEnvironmentFlags(flags.env);
  const spec = await resolveEffectiveSpec({
    projectDir,
    configFile: flags.config,
    purpose: "start",
    projectDefaultsOnly: true,
    presetDefaults: {
      image: preset.image,
      workspace: preset.workspace,
      network: preset.network,
      ...(preset.environment ? { environment: preset.environment } : {}),
    },
    overrides: {
      image: flags.image,
      workspace: flags.workspace as WorkspaceMode | undefined,
      network: flags.network as NetworkMode | undefined,
      command: [...preset.command, ...rawArgs],
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
    },
  });
  if (
    preset.prepare &&
    preset.image &&
    !flags.image &&
    spec.image !== preset.image
  ) {
    throw new Error(
      "A project cannot select an image for a preset with host preparation; use --image to confirm the image explicitly",
    );
  }
  let prepared: Awaited<ReturnType<typeof preparePresetHandoff>>;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    prepared = await (
      dependencies.preparePresetHandoff ?? preparePresetHandoff
    )(preset, sessionName, controller.signal);
    console.error(`Launching preset ${presetName} as session ${sessionName}`);
    const result = await (dependencies.startSession ?? startSession)({
      name: sessionName,
      spec,
      detached: flags.detach,
      tty:
        flags.tty ??
        (!flags.detach && Boolean(process.stdin.isTTY && process.stdout.isTTY)),
      signal: controller.signal,
      runtimeMounts: [
        ...(preset.runtime ?? []),
        ...(prepared?.runtimeMounts ?? []),
      ],
      ...(prepared ? { handoffManifestPath: prepared.manifestPath } : {}),
    });
    console.error(
      `Preset ${presetName} session ${result.name} (${result.id}) ${result.state}${result.exitCode === undefined ? "" : ` exit=${result.exitCode}`}`,
    );
    if (!result.detached) process.exitCode = result.exitCode ?? 0;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    try {
      await (dependencies.cleanupPresetHandoff ?? cleanupPresetHandoff)(
        prepared,
      );
    } catch {
      console.error(
        `Unable to remove private preset preparation data at ${prepared?.directory ?? "the temporary directory"} for session ${sessionName}`,
      );
      process.exitCode = 1;
    }
  }
}

export function createCli(dependencies: CliDependencies = {}) {
  return new Crust("pi-sesh")
    .meta({
      description: "Rootless containerized command sessions",
      usage: "pi-sesh <command|preset> [options] [-- agent-argv...]",
    })
    .flags({
      ...presetLaunchFlags,
      version: {
        type: "boolean",
        noNegate: true,
        description: "Show version",
        inherit: true,
      },
    })
    .use(versionPlugin)
    .use(colorPlugin)
    .use(cliHelpPlugin)
    .args([
      {
        name: "preset",
        type: "string",
        description: "Shared user agent preset",
      },
      {
        name: "command",
        type: "string",
        variadic: true,
        description: "Pass agent arguments after --",
      },
    ])
    .run(async ({ flags, args, rawArgs, command }) => {
      if (!args.preset) {
        if (rawArgs.length)
          throw new Error("Select a shared user preset before --");
        const text = renderHelp(command, ["pi-sesh"]);
        const color = (flags as Record<string, unknown>).color;
        console.log(
          color === true || (color !== false && outputUsesColor())
            ? text
            : Bun.stripANSI(text),
        );
        return;
      }
      if (args.command.length) throw new Error("Pass preset argv after --");
      await launchUserPreset(args.preset, flags, rawArgs, dependencies);
    })
    .command("init", (command) =>
      command
        .meta({ description: "Create project config; preserve existing files" })
        .flags({
          image: { type: "string", description: "Select a development image" },
          file: {
            type: "string",
            description: "Select an existing project recipe",
          },
          workspace: {
            type: "string",
            choices: ["mount", "clone"],
            description: "Workspace mode (default: mount)",
          },
        })
        .args([
          {
            name: "project",
            type: "string",
            description: "Project folder (default: current folder)",
          },
        ])
        .run(async ({ args, flags }) => {
          const result = await initProject(
            args.project ?? dependencies.currentDirectory?.() ?? process.cwd(),
            {
              image: flags.image,
              file: flags.file,
              workspace: flags.workspace as WorkspaceMode | undefined,
            },
          );
          console.log(
            `${result.created ? "Created" : "Using existing"} ${result.path}`,
          );
          if (result.created)
            console.log(
              "Mount mode writes to the original project unless you selected clone. Agent settings were not changed.",
            );
        }),
    )
    .command("setup-prompt", (command) =>
      command
        .meta({
          description:
            "Print a setup prompt for the current folder; do not change files",
        })
        .run(() => {
          console.log(
            setupPrompt(dependencies.currentDirectory?.() ?? process.cwd()),
          );
        }),
    )
    .command("build", (command) =>
      command
        .meta({ description: "Build the configured project image" })
        .flags({
          config: {
            type: "string",
            description: "Use an explicit config file",
          },
          image: {
            type: "string",
            description: "Override the configured image tag",
          },
          context: {
            type: "string",
            description: "Override the build context",
          },
          file: {
            type: "string",
            description: "Override the Containerfile path",
          },
          pull: {
            type: "boolean",
            description: "Pull missing public base images",
          },
        })
        .args([{ name: "project", type: "string", required: true }])
        .run(async ({ args, flags }) => {
          const spec = await resolveEffectiveSpec({
            projectDir: args.project,
            configFile: flags.config,
            purpose: "build",
            overrides: {
              image: flags.image,
              context: flags.context,
              file: flags.file,
            },
          });
          const result = await (dependencies.buildImage ?? buildProjectImage)(
            spec,
            {
              pullMissingBases: flags.pull,
            },
          );
          console.log(`Built ${result.tag} (${result.imageId})`);
        }),
    )
    .command("start", (command) =>
      command
        .meta({ description: "Start an arbitrary command in a named session" })
        .flags({
          config: {
            type: "string",
            description: "Use an explicit config file",
          },
          image: {
            type: "string",
            description: "Override the configured image",
          },
          name: {
            type: "string",
            required: true,
            description: "Unique user-visible session name",
          },
          workspace: {
            type: "string",
            choices: ["mount", "clone"],
            description: "Choose workspace mode",
          },
          network: {
            type: "string",
            choices: ["none", "pasta"],
            description: "Choose runtime network mode",
          },
          detach: {
            type: "boolean",
            description: "Return after the container starts",
          },
          tty: {
            type: "boolean",
            description: "Allocate a TTY, including for detached sessions",
          },
          handoff: {
            type: "string",
            description: "Explicit versioned resource handoff manifest",
          },
        })
        .args([
          { name: "project", type: "string", required: true },
          { name: "command", type: "string", variadic: true },
        ])
        .run(async ({ args, flags, rawArgs }) => {
          if (args.command.length > 0 && rawArgs.length === 0)
            throw new Error("Pass workload argv after --");
          const spec = await resolveEffectiveSpec({
            projectDir: args.project,
            configFile: flags.config,
            purpose: "start",
            overrides: {
              image: flags.image,
              workspace: flags.workspace as WorkspaceMode | undefined,
              network: flags.network as NetworkMode | undefined,
              ...(rawArgs.length > 0 ? { command: rawArgs } : {}),
            },
          });
          const result = await (dependencies.startSession ?? startSession)({
            name: flags.name,
            spec,
            detached: flags.detach,
            tty: flags.tty,
            handoffManifestPath: flags.handoff,
          });
          console.log(
            `Session ${result.name} (${result.id}) ${result.state}${result.exitCode === undefined ? "" : ` exit=${result.exitCode}`}`,
          );
          if (!result.detached) process.exitCode = result.exitCode ?? 0;
        }),
    )
    .command("open", (command) =>
      command
        .meta({
          description: "Open a project environment for container-backed tools",
        })
        .flags({
          config: { type: "string", description: "Select project defaults" },
          image: {
            type: "string",
            description: "Select an existing local project image",
          },
          name: {
            type: "string",
            required: true,
            description: "Unique session name",
          },
          workspace: {
            type: "string",
            choices: ["mount", "clone"],
            description: "Workspace mode (default: clone)",
          },
          network: {
            type: "string",
            choices: ["none", "pasta"],
            description: "Container network (default: none)",
          },
          handoff: {
            type: "string",
            description: "Explicit versioned resource handoff manifest",
          },
        })
        .args([{ name: "project", type: "string", required: true }])
        .run(async ({ args, flags }) => {
          const spec = await resolveEffectiveSpec({
            projectDir: args.project,
            configFile: flags.config,
            purpose: "start",
            projectDefaultsOnly: true,
            overrides: {
              image: flags.image,
              workspace: (flags.workspace ?? "clone") as WorkspaceMode,
              network: (flags.network ?? "none") as NetworkMode,
              command: [
                "/bin/sh",
                "-c",
                "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
              ],
            },
          });
          const started = await (dependencies.startSession ?? startSession)({
            name: flags.name,
            spec,
            detached: true,
            tty: false,
            handoffManifestPath: flags.handoff,
          });
          const { record, status } = await (
            dependencies.getSessionStatus ?? getSessionStatus
          )({ name: started.name });
          if (status.state !== "running")
            throw new Error(
              "Project environment did not stay running; inspect its logs (requires /bin/sh and sleep)",
            );
          console.log(
            JSON.stringify({
              name: record.name,
              id: record.id,
              containerId: record.containerId,
              imageId: record.imageId,
              state: status.state,
              projectDir: record.projectDir,
              workspacePath: record.workspacePath,
              workspace: record.workspaceMode,
              network: record.network,
            }),
          );
        }),
    )
    .command("exec", (command) =>
      command
        .meta({
          description: "Execute literal argv in an owned running session",
        })
        .flags({
          "session-id": {
            type: "string",
            required: true,
            description: "Immutable ID from open or inspect",
          },
          cwd: {
            type: "string",
            description: "Container working directory (default: /workspace)",
          },
          timeout: {
            type: "number",
            description: "Timeout in seconds; stops the session container",
          },
        })
        .args([
          { name: "name", type: "string", required: true },
          { name: "command", type: "string", variadic: true },
        ])
        .run(async ({ args, flags, rawArgs }) => {
          if (!rawArgs.length) throw new Error("Pass command argv after --");
          const controller = new AbortController();
          const abort = () => controller.abort();
          process.on("SIGINT", abort);
          process.on("SIGTERM", abort);
          try {
            const result = await (
              dependencies.executeSession ?? executeSession
            )({
              name: args.name,
              sessionId: flags["session-id"],
              argv: rawArgs,
              cwd: flags.cwd,
              timeout: flags.timeout,
              signal: controller.signal,
              stdin: "inherit",
              stdio: "inherit",
            });
            process.exitCode = result.status;
          } finally {
            process.off("SIGINT", abort);
            process.off("SIGTERM", abort);
          }
        }),
    )
    .command("launch", (command) =>
      command
        .meta({ description: "Launch a trusted named user preset" })
        .flags(presetLaunchFlags)
        .args([
          {
            name: "preset",
            type: "string",
            required: true,
            description: "Shared user agent preset",
          },
          {
            name: "command",
            type: "string",
            variadic: true,
            description: "Pass agent arguments after --",
          },
        ])
        .run(async ({ args, flags, rawArgs }) => {
          if (args.command.length > 0 && rawArgs.length === 0)
            throw new Error("Pass preset argv after --");
          await launchUserPreset(args.preset, flags, rawArgs, dependencies);
        }),
    )
    .command("clean", (command) =>
      command
        .meta({ description: "Remove stopped sessions; preview by default" })
        .flags({
          all: {
            type: "boolean",
            description: "Include sessions from all projects",
          },
          yes: {
            type: "boolean",
            description: "Confirm removal, including retained output",
          },
        })
        .args([
          {
            name: "project",
            type: "string",
            description: "Project folder (default: current folder)",
          },
        ])
        .run(({ args, flags }) =>
          bulkSessionAction("clean", args.project, flags, dependencies),
        ),
    )
    .command("stop-all", (command) =>
      command
        .meta({ description: "Stop running sessions; preview by default" })
        .flags({
          all: {
            type: "boolean",
            description: "Include sessions from all projects",
          },
          yes: {
            type: "boolean",
            description: "Confirm stopping; retain session results",
          },
        })
        .args([
          {
            name: "project",
            type: "string",
            description: "Project folder (default: current folder)",
          },
        ])
        .run(({ args, flags }) =>
          bulkSessionAction("stop-all", args.project, flags, dependencies),
        ),
    )
    .command("list", (command) =>
      command.meta({ description: "List pi-sesh sessions" }).run(async () => {
        const sessions = await (dependencies.listSessions ?? listSessions)({});
        printSessionList(sessions);
      }),
    )
    .command("inspect", (command) =>
      command
        .meta({
          description:
            "Inspect a session without loading project configuration",
        })
        .args([{ name: "name", type: "string", required: true }])
        .run(async ({ args }) => {
          const { record, status } = await (
            dependencies.getSessionStatus ?? getSessionStatus
          )({ name: args.name });
          console.log(
            JSON.stringify({
              name: record.name,
              id: record.id,
              containerId: record.containerId,
              imageId: record.imageId,
              state: status.state,
              ...(status.exitCode === undefined
                ? {}
                : { exitCode: status.exitCode }),
              projectDir: record.projectDir,
              workspacePath: record.workspacePath,
              sourceRevision: record.sourceRevision,
              workspace: record.workspaceMode,
              network: record.network,
              resources: (record.resources ?? []).map((resource) => ({
                id: resource.id,
                hostPath: stagedResourcePath(
                  defaultStateRoot(process.env),
                  record.id,
                  resource.id,
                ),
                destination: resource.destination,
                kind: resource.kind,
                access: resource.access,
                lifetime: resource.lifetime,
              })),
            }),
          );
        }),
    )
    .command("attach", (command) =>
      command
        .meta({ description: "Attach to the same running process" })
        .args([{ name: "name", type: "string", required: true }])
        .run(async ({ args }) => {
          const code = await (dependencies.attachSession ?? attachSession)({
            name: args.name,
          });
          process.exitCode = code;
        }),
    )
    .command("logs", (command) =>
      command
        .meta({ description: "Show retained container logs" })
        .args([{ name: "name", type: "string", required: true }])
        .run(async ({ args }) => {
          const result = await (
            dependencies.showSessionLogs ?? showSessionLogs
          )({ name: args.name });
          if (result.status !== 0) process.exitCode = result.status;
        }),
    )
    .command("stop", (command) =>
      command
        .meta({ description: "Stop a running session" })
        .flags({
          "session-id": {
            type: "string",
            description: "Require the immutable session ID",
          },
        })
        .args([{ name: "name", type: "string", required: true }])
        .run(async ({ args, flags }) => {
          const status = await (dependencies.stopSession ?? stopSession)({
            name: args.name,
            ...(flags["session-id"] ? { sessionId: flags["session-id"] } : {}),
          });
          console.log(
            `Session ${args.name} ${status.state}${status.exitCode === undefined ? "" : ` exit=${status.exitCode}`}`,
          );
        }),
    )
    .command("remove", (command) =>
      command
        .meta({ description: "Remove an exited session and its owned clone" })
        .flags({
          "session-id": {
            type: "string",
            description: "Require the immutable session ID",
          },
        })
        .args([{ name: "name", type: "string", required: true }])
        .run(async ({ args, flags }) => {
          await (dependencies.removeSession ?? removeSession)({
            name: args.name,
            ...(flags["session-id"] ? { sessionId: flags["session-id"] } : {}),
          });
          console.log(`Removed session ${args.name}`);
        }),
    );
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<void> {
  await createCli(dependencies).execute({ argv });
}
