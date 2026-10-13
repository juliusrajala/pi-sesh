import type { listSessions } from "../container/session";

export function outputUsesColor(): boolean {
  return (
    Boolean(process.stdout.isTTY) &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== "dumb"
  );
}

function styleOutput(
  text: string,
  code: number | undefined,
  color: boolean,
): string {
  return color && code !== undefined ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function printSessionList(
  sessions: Awaited<ReturnType<typeof listSessions>>,
): void {
  if (!process.stdout.isTTY) {
    for (const { record, status } of sessions) {
      console.log(
        `${record.name}\t${status.state}\t${status.exitCode === undefined ? "-" : `exit=${status.exitCode}`}\t${record.id}\t${JSON.stringify(record.projectDir)}`,
      );
    }
    return;
  }
  if (!sessions.length) {
    console.log("No sessions.");
    return;
  }

  const color = outputUsesColor();
  const headers = ["NAME", "STATE", "EXIT", "SESSION ID", "PROJECT FOLDER"];
  const rows = sessions.map(({ record, status }) => [
    record.name,
    status.state,
    status.exitCode === undefined ? "-" : String(status.exitCode),
    record.id,
    JSON.stringify(record.projectDir),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (cells: string[], codes: (number | undefined)[]) =>
    cells
      .map((cell, index) => {
        const padding =
          index === cells.length - 1
            ? ""
            : " ".repeat(widths[index]! - cell.length + 2);
        return `${styleOutput(cell, codes[index], color)}${padding}`;
      })
      .join("");
  const lines = [
    formatRow(
      headers,
      headers.map(() => 1),
    ),
  ];
  for (const [index, { status }] of sessions.entries()) {
    const exitColor =
      status.exitCode === undefined
        ? undefined
        : status.exitCode === 0
          ? 32
          : 31;
    const stateColor =
      status.state === "missing"
        ? 31
        : status.state === "running"
          ? 32
          : status.state === "paused" || status.state === "created"
            ? 33
            : exitColor;
    lines.push(
      formatRow(rows[index]!, [
        36,
        stateColor,
        exitColor,
        undefined,
        undefined,
      ]),
    );
  }
  console.log(lines.join("\n"));
}
