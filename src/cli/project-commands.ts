import type { Crust } from "@crustjs/core";
import { initProject } from "../config/init";
import { resolveEffectiveSpec, type WorkspaceMode } from "../config/config";
import { buildProjectImage } from "../container/podman";
import { buildDefaultImage } from "../container/default-image";
import { setupPrompt } from "./setup-prompt";
import type { CliDependencies } from "./cli";

export function registerProjectCommands(
  cli: Crust<any, any, any>,
  dependencies: CliDependencies,
): Crust<any, any, any> {
  return cli
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
    .command("build-default", (command) =>
      command
        .meta({ description: "Build the shared default image with Git" })
        .flags({
          pull: {
            type: "boolean",
            description: "Pull a missing public base image",
          },
        })
        .run(async ({ flags }) => {
          const result = (dependencies.buildDefaultImage ?? buildDefaultImage)({
            pullMissingBases: flags.pull,
          });
          const built = await result;
          console.log(`Built ${built.tag} (${built.imageId})`);
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
            { pullMissingBases: flags.pull },
          );
          console.log(`Built ${result.tag} (${result.imageId})`);
        }),
    );
}
