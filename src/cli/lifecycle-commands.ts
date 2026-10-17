import type { CliCommandTree, CliDependencies } from "./cli";
import { defaultStateRoot } from "../workspace/workspace";
import { stagedResourcePath } from "../handoff/handoff";
import {
  attachSession,
  getSessionStatus,
  listSessions,
  removeSession,
  showSessionLogs,
  stopSession,
} from "../container/session";
import { bulkSessionAction } from "./session-actions";
import { printSessionList } from "./session-list";

export function registerLifecycleCommands(
  cli: CliCommandTree,
  dependencies: CliDependencies,
): CliCommandTree {
  return cli
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
        .args([{ name: "name", type: "string", required: true }])
        .run(async ({ args }) => {
          const status = await (dependencies.stopSession ?? stopSession)({
            name: args.name,
          });
          console.log(
            `Session ${args.name} ${status.state}${status.exitCode === undefined ? "" : ` exit=${status.exitCode}`}`,
          );
        }),
    )
    .command("remove", (command) =>
      command
        .meta({ description: "Remove an exited session and its owned clone" })
        .args([{ name: "name", type: "string", required: true }])
        .run(async ({ args }) => {
          await (dependencies.removeSession ?? removeSession)({
            name: args.name,
          });
          console.log(`Removed session ${args.name}`);
        }),
    );
}
