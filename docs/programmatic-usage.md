# Programmatic use

Use the `pi-sesh` executable as the stable programmatic interface. Pi-sesh also provides a Bun-first TypeScript control API for local integrations. This API is not a published or versioned SDK. `src/main.ts` remains the CLI entry point.

## Use the TypeScript control API

Import `pi-sesh/control` from a local Bun dependency. The API uses the same private session store and container security policy as the CLI. It does not expose Podman arguments or arbitrary host mounts. `command` is literal argv; pi-sesh uses its first item as the container entry point. Include an image wrapper in argv when the worker needs one.

```ts
import { createPiSesh } from "pi-sesh/control";

const piSesh = createPiSesh({
  stateRoot: process.env.PI_SESH_STATE_ROOT,
  maxWritableBytes: 4 * 1024 ** 3,
});

const session = await piSesh.sessions.start({
  name: `worker-${jobId}`,
  image: "localhost/pi-runner:dev",
  workspace: { path: preparedWorkspacePath, mode: "mount" },
  command: ["pi", "--print", prompt],
  network: "pasta",
  environment: { JOB_ID: jobId },
  secrets: [
    {
      id: "provider-env",
      destination: "/home/session/provider-env.json",
      content: JSON.stringify(selectedProviderEnvironment),
    },
  ],
  artifacts: [{ id: "job", destination: "/home/session/output" }],
});

const result = await piSesh.sessions.wait(session.id);
const logs = await piSesh.sessions.logs(session.id);
const [jobOutput] = await piSesh.sessions.artifacts(session.id);

if (result.reason === "workspace-limit") {
  throw new Error("Worker exceeded its writable-data limit");
}
if (result.exitCode !== 0) {
  throw new Error(`Worker exited with ${result.exitCode}: ${logs.output}`);
}
console.log(`Read retained output from ${jobOutput.hostPath}`);
```

`wait` checks aggregate writable data for the workspace and writable handoff resources. It stops a running session when it observes usage above the configured limit. This is a polling guard, not a hard filesystem quota; usage can exceed the limit between polls. It also checks final usage after exit. Resume the wait after a service restart with the same limit. The limit is not monitored while the service is down. Its `AbortSignal` cancels only the wait. Call `stop` to stop the worker. Read or copy retained artifacts before `remove` deletes them.

Secret file contents are staged in a private temporary directory and are removed after pi-sesh stages them. Pi-sesh removes secret resources when the worker stops. Do not pass credentials through `environment`.

`sessions.exec(id, argv, { onOutput, signal, timeout })` runs another literal command in the session. The callback receives stdout and stderr byte chunks while the command runs. The result also contains captured output and the command exit status. Cancellation or timeout stops the session.

`logs.output` combines the container's stdout and stderr. `logs.engineStatus` is the exit status of Podman's log command. `result.exitCode` is the container's initial command exit status.

Use `images.build` with explicit project, context, recipe, and tag to build a worker image. Base-image pulls are disabled unless `pullMissingBases: true`. Use `images.select` to verify that an image already exists locally. Session start never pulls an image.

This API currently targets Bun on Linux. Its public contract can change until pi-sesh defines a versioned SDK policy. Keep the CLI for stable scripts and external consumers.

## Build and locate the executable

From this repository, build the Linux x86-64 executable with Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run build
```

The executable is `dist/pi-sesh`. Use its absolute path in scripts that do not inherit this directory in `PATH`. The compiled executable does not need Bun.

## Run one command

Pass each argument as a separate argv item. Do not build a shell command from untrusted text.

```sh
pi-sesh start "$PROJECT" --name ci-check \
  --image localhost/project:dev \
  --workspace clone --network none \
  -- node --version
```

The image must exist locally. `clone` requires a clean, supported Git repository. The command runs in the selected image. Pi-sesh forwards its streams and returns its exit status. The session record and results remain after the command exits. Inspect them before removal:

```sh
pi-sesh inspect ci-check
pi-sesh logs ci-check
pi-sesh remove ci-check
```

Use `--workspace mount` only when the command can write to the original project folder.

## Open an environment and execute commands

Use `open` when a program needs to run several commands in one environment. It prints one JSON object on stdout. Launcher diagnostics use stderr.

```sh
pi-sesh open "$PROJECT" --name ci-tools \
  --image localhost/project:dev \
  --workspace clone --network none
```

The JSON object includes `name`, `id`, `containerId`, `imageId`, `state`, `projectDir`, `workspacePath`, `workspace`, and `network`. Use `id` as the immutable session identity. Do not use `containerId` for `exec`.

Pass the session name and immutable ID to `exec`. Put the command argv after `--`:

```sh
pi-sesh exec ci-tools --session-id <id> -- node --version
pi-sesh exec ci-tools --session-id <id> --cwd /workspace -- git status --short
```

Stop the environment before you remove it. Pass the immutable ID to protect against name reuse:

```sh
pi-sesh stop ci-tools --session-id <id>
pi-sesh remove ci-tools --session-id <id>
```

Use `open --handoff /path/to/manifest.json` when the environment needs snapshots or owned resource directories. Handoff uses the same staging and cleanup rules as `start --handoff`.

`exec` forwards stdin, stdout, and stderr. A timeout, cancellation, or transport failure stops the whole environment. Use `--timeout <seconds>` to set an execution deadline.

### Bun script example

This example opens an environment, runs one command, then stops and removes the session. It expects a configured project or an explicit local image. Clone mode requires a clean Git repository.

```ts
const project = process.cwd();
const open = Bun.spawn(
  [
    "pi-sesh",
    "open",
    project,
    "--name",
    `automation-${crypto.randomUUID()}`,
    "--image",
    "localhost/project:dev",
    "--workspace",
    "clone",
    "--network",
    "none",
  ],
  { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
);
const [openOutput, openStatus] = await Promise.all([
  open.stdout.text(),
  open.exited,
]);
if (openStatus !== 0) throw new Error(`pi-sesh open failed: ${openStatus}`);
const session = JSON.parse(openOutput) as { name: string; id: string };

try {
  const command = Bun.spawn(
    [
      "pi-sesh",
      "exec",
      session.name,
      "--session-id",
      session.id,
      "--",
      "node",
      "--version",
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  const status = await command.exited;
  if (status !== 0) throw new Error(`Workload failed: ${status}`);
} finally {
  const stop = Bun.spawn(
    ["pi-sesh", "stop", session.name, "--session-id", session.id],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const stopStatus = await stop.exited;
  if (stopStatus !== 0) throw new Error(`Could not stop ${session.name}`);

  const remove = Bun.spawn(
    ["pi-sesh", "remove", session.name, "--session-id", session.id],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const removeStatus = await remove.exited;
  if (removeStatus !== 0) throw new Error(`Could not remove ${session.name}`);
}
```

Use `Bun.spawn` with an argv array. Do not use a shell unless the workload needs shell syntax. If a shell is needed, pass its executable and script as separate argv items. Avoid inserting untrusted text into a shell script.

## Launch an agent with RPC streams

`pi-sesh <preset>` and `pi-sesh launch <preset>` use the same launcher. To use an agent's RPC mode, keep stdin and stdout as pipes. Do not print logs or status text to the protocol stream. Pi-sesh sends launcher diagnostics to stderr and passes workload streams through unchanged.

```ts
const process = Bun.spawn(
  ["pi-sesh", "pi", "--network", "none", "--", "--mode", "rpc"],
  { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
);

process.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
process.stdin.flush();
process.stdin.end();

const [stdout, status] = await Promise.all([
  process.stdout.text(),
  process.exited,
]);
if (status !== 0) throw new Error(`Agent exited with status ${status}`);

for (const line of stdout.split("\n")) {
  if (!line) continue;
  const message = JSON.parse(line);
  if (message.type === "response" && message.command === "get_state") {
    console.log(message.data);
  }
}
```

This example sends one RPC request, closes stdin, and reads the response stream. For an interactive RPC client, keep stdin open, write one JSON message per line, and read stdout concurrently. Handle every protocol message type. Extensions can emit protocol events in addition to command responses.

Use `--network pasta` only when the agent needs outbound access. Network access and credentials are separate choices. Review the preset and project image before you supply credentials or enable provider access.

## Read session state

`open` and `inspect` print JSON for one session. `list` prints tab-separated fields when stdout is piped. Each list row has five fields: session name, state, exit status (`exit=<code>` or `-`), session ID, and JSON-quoted absolute project folder. Parse the final field as JSON because folder paths can contain tabs or newlines. Terminal output uses aligned columns instead.

```sh
pi-sesh inspect ci-tools
pi-sesh list
```

Check each command's exit status. Commands report errors on stderr and return a nonzero status when they fail. `clean` and `stop-all` preview their actions by default. Add `--yes` only when the calling program intends to apply the action. Use `--all` only when it intends to include every project.

## Project and user setup

Create the project config from the project folder:

```sh
pi-sesh init --image localhost/project:dev
```

If the project has a compatible `Containerfile` or `Dockerfile`, `pi-sesh init` detects it. Build the configured image explicitly:

```sh
pi-sesh build .
```

Then run the shared agent preset:

```sh
pi-sesh pi
```

Agent presets are user-wide. Configure one trusted preset once and reuse it across projects. `pi-sesh init` does not create or modify a user preset. See [Run an agent with a user preset](../README.md#run-an-agent-with-a-user-preset) for the preset and credential boundary.
