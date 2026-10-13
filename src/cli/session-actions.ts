import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  listSessions as defaultListSessions,
  removeSession as defaultRemoveSession,
  stopSession as defaultStopSession,
} from "../container/session";

interface SessionActionDependencies {
  listSessions?: typeof defaultListSessions;
  removeSession?: typeof defaultRemoveSession;
  stopSession?: typeof defaultStopSession;
  currentDirectory?: () => string;
}

export async function bulkSessionAction(
  action: "clean" | "stop-all",
  project: string | undefined,
  flags: { all?: boolean; yes?: boolean },
  dependencies: SessionActionDependencies,
): Promise<void> {
  if (flags.all && project)
    throw new Error("Do not combine a project folder with --all");
  const projectDir = flags.all
    ? undefined
    : await realpath(
        resolve(project ?? dependencies.currentDirectory?.() ?? process.cwd()),
      );
  const sessions = (
    await (dependencies.listSessions ?? defaultListSessions)({})
  ).filter(
    ({ record }) =>
      projectDir === undefined || record.projectDir === projectDir,
  );
  const selected = sessions.filter(({ status }) =>
    action === "clean"
      ? ["exited", "stopped", "created", "missing"].includes(status.state)
      : status.state === "running",
  );
  const verb = action === "clean" ? "Remove" : "Stop";
  if (action === "stop-all") {
    const paused = sessions.filter(({ status }) => status.state === "paused");
    if (paused.length)
      console.log(
        `Skipped ${paused.length} paused session(s); resume them before stopping.`,
      );
  }
  if (!selected.length) {
    console.log("No matching sessions.");
    return;
  }
  console.log(
    `${flags.yes ? "Selected" : "Preview"}: ${selected.length} session(s)${projectDir ? ` in ${projectDir}` : " across all projects"}`,
  );
  if (action === "clean")
    console.log(
      "Removal deletes retained output and session-owned clones. Project files, images, and shared agent settings are preserved.",
    );
  for (const { record, status } of selected)
    console.log(`${verb} ${record.name} (${record.id}) ${status.state}`);
  if (!flags.yes) {
    console.log(
      "No sessions were stopped or removed. Add --yes to apply this action.",
    );
    return;
  }
  for (const { record } of selected) {
    try {
      const options = { name: record.name, sessionId: record.id };
      if (action === "clean")
        await (dependencies.removeSession ?? defaultRemoveSession)(options);
      else await (dependencies.stopSession ?? defaultStopSession)(options);
      console.log(
        `${action === "clean" ? "Removed" : "Stopped"} ${record.name}`,
      );
    } catch (error) {
      console.error(
        `Could not ${verb.toLowerCase()} ${record.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
}
