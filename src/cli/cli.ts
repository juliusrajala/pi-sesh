import { Crust, type CrustPlugin } from "@crustjs/core";
import { helpPlugin, noColorPlugin, renderHelp } from "@crustjs/plugins";
import packageInfo from "../../package.json";
import { buildDefaultImage } from "../container/default-image";
import { buildProjectImage } from "../container/podman";
import {
  resolveEffectiveSpec,
  validateContainerEnvironment,
  type NetworkMode,
  type WorkspaceMode,
} from "../config/config";
import { generatedSessionName } from "../launch/preset";
import {
  startPresetSession,
  type PresetSessionDependencies,
} from "../launch/session";
import {
  OPEN_ENVIRONMENT_COMMAND,
  attachSession,
  executeSession,
  getSessionStatus,
  listSessions,
  removeSession,
  showSessionLogs,
  startSession,
  stopSession,
} from "../container/session";
import { outputUsesColor } from "./session-list";
import { registerLifecycleCommands } from "./lifecycle-commands";
import { registerProjectCommands } from "./project-commands";

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

export interface CliDependencies extends PresetSessionDependencies {
  buildImage?: typeof buildProjectImage;
  buildDefaultImage?: typeof buildDefaultImage;
  executeSession?: typeof executeSession;
  attachSession?: typeof attachSession;
  getSessionStatus?: typeof getSessionStatus;
  listSessions?: typeof listSessions;
  removeSession?: typeof removeSession;
  showSessionLogs?: typeof showSessionLogs;
  stopSession?: typeof stopSession;
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
  const sessionName = flags.name ?? generatedSessionName();
  const projectDir = dependencies.currentDirectory?.() ?? process.cwd();
  const environment = parseEnvironmentFlags(flags.env);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    console.error(`Launching preset ${presetName} as session ${sessionName}`);
    const { session: result } = await startPresetSession(
      {
        preset: presetName,
        projectDir,
        name: sessionName,
        configFile: flags.config,
        image: flags.image,
        workspace: flags.workspace as WorkspaceMode | undefined,
        network: flags.network as NetworkMode | undefined,
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
        args: rawArgs,
        detached: flags.detach,
        tty:
          flags.tty ??
          (!flags.detach &&
            Boolean(process.stdin.isTTY && process.stdout.isTTY)),
        signal: controller.signal,
      },
      dependencies,
    );
    console.error(
      `Preset ${presetName} session ${result.name} (${result.id}) ${result.state}${result.exitCode === undefined ? "" : ` exit=${result.exitCode}`}`,
    );
    if (!result.detached) process.exitCode = result.exitCode ?? 0;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

export type CliCommandTree = ReturnType<typeof createRootCli>;

function createRootCli(dependencies: CliDependencies) {
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
    });
}

export function createCli(dependencies: CliDependencies = {}) {
  const projectTree = registerProjectCommands(
    createRootCli(dependencies),
    dependencies,
  );
  const sessionTree = projectTree
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
              command: [...OPEN_ENVIRONMENT_COMMAND],
            },
          });
          const started = await (dependencies.startSession ?? startSession)({
            name: flags.name,
            spec,
            detached: true,
            tty: false,
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
    );
  return registerLifecycleCommands(sessionTree, dependencies);
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<void> {
  await createCli(dependencies).execute({ argv });
}
