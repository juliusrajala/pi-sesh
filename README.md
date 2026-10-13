# pi-sesh

Run a command or an agent in a local rootless Podman container. Use a copy of a Git project, or mount the original folder.

Pi-sesh manages the workspace, container, and session cleanup. It does not install agents or project tools. It does not pull images during launch.

## Platform support

**Current support: Linux x86-64 only.** macOS support is planned. It is not available yet. The current build produces a Linux executable. A Podman machine on macOS does not meet the current local-engine requirements.

On Linux, you need:

- Local rootless Podman 6.1.1 or later. Do not run pi-sesh with `sudo`.
- cgroup v2 with memory and PID controllers available to Podman.
- Host Git, if you use a clone workspace.
- The pasta network backend, if you build an image or enable container networking.
- A local Linux x86-64 image with the tools needed by your command.

Use `podman info` to check the engine. Pi-sesh also checks these requirements before a build or session start.

## Get the executable

If `pi-sesh` is already installed, skip this section.

To build from this source checkout, use Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run build
./dist/pi-sesh --help
```

If another Bun version is active, run each Bun command through `mise exec bun@1.3.14 --`.

The build writes `dist/pi-sesh`. The compiled executable does not need Bun. To install it for your user:

```sh
install -Dm755 dist/pi-sesh "$HOME/.local/bin/pi-sesh"
export PATH="$HOME/.local/bin:$PATH"
pi-sesh --version
```

The `export` command changes only the current shell. Use your normal shell configuration to keep that PATH setting for later shells.

## Quick start: run your agent

Set up your shared user agent preset once. Reuse it across projects. Pi-sesh does not install an agent in each project.

In a project with an existing `Containerfile` or `Dockerfile`, run these two setup commands:

```sh
pi-sesh init
pi-sesh build .
```

Then start your shared preset. For a preset named `pi`:

```sh
pi-sesh pi
```

`init` creates `pi-sesh.json` automatically. It preserves an existing config and recipe. It does not change Node.js to Bun or install an agent. The image tag is generated from the project folder. **The default workspace is a writable mount of that folder.** Use `init --workspace clone` if you want a clone. Record setup files through your normal Git workflow before you use clone mode.

If the project has no recipe, select an existing local development image with `pi-sesh init --image localhost/project:dev`. No build is needed in that case. Pi-sesh does not guess the project's tools or write a replacement recipe.

The build uses cached base images by default. Use `pi-sesh build . --pull` only if you approve downloads. Build steps can use the network.

`pi-sesh <preset>` works for any trusted user preset. It is the short form of `pi-sesh launch <preset>`. Pass agent options after `--`:

```sh
pi-sesh pi -- --mode rpc
pi-sesh pi --network none -- --version
```

Each launch creates its session files and private resources automatically. It does not create another agent preset.

## Quick start: run a command

You do not need an agent preset to run a command. You do not need a Git repository when you use a mounted workspace.

The following example uses the small Bun image recipe in [`examples/project/`](examples/project/). Run it from this source checkout. Review the recipe first.

```sh
pi-sesh build examples/project
```

This requires the base image to be cached locally. If you approve a download of the missing public base image, use this command instead:

```sh
pi-sesh build examples/project --pull
```

Run a command in that image:

```sh
pi-sesh start examples/project --name first-run \
  --workspace mount --network none -- bun --version
pi-sesh inspect first-run
pi-sesh logs first-run
pi-sesh remove first-run
```

**Mount mode gives the command write access to the original folder.** This example only asks Bun to report its version. Removal deletes the session, not the original folder or image.

To use an existing local image in another folder:

```sh
pi-sesh start /path/to/project --name check --image localhost/project:dev \
  --workspace mount --network none -- your-command argument
```

Replace the image and command with your values. The command must exist in the image. Pass command arguments after `--`. Pi-sesh passes them as an argument array (argv), not as shell text. Shell operators work only if you explicitly run a shell.

Use `--workspace clone` instead of `mount` for a clean, supported Git repository. A clone protects the original project from session writes. See [Workspaces and results](#workspaces-and-results).

Use a new session name for each run, or remove the old session before you reuse its name.

Run `pi-sesh` or `pi-sesh --help` to list commands. Both show the same help. Use `pi-sesh start --help` to see the options for `start`. Help descriptions align in columns in each section.

In a terminal, help labels are cyan and section headings are bold. `pi-sesh list` shows aligned columns and colors session states. Output sent to a pipe or file stays plain. Set `NO_COLOR=1` to disable colors. `TERM=dumb` also disables them.

## Set up a project

A project can supply `pi-sesh.json` in its root directory:

```json
{
  "version": 1,
  "image": "localhost/project:dev",
  "build": { "context": ".", "file": "Containerfile" },
  "workspace": "clone",
  "environment": { "NODE_ENV": "development" }
}
```

Select a development image that contains the project's tools. Keep the build recipe inside its build context. Both paths must stay inside the selected project.

Build that image explicitly:

```sh
pi-sesh build /path/to/project
```

Without build settings in the config, supply them on the command line:

```sh
pi-sesh build /path/to/project --image localhost/project:dev \
  --context . --file Containerfile
```

`--pull` allows downloads of missing public base images. It uses an empty temporary registry-auth file. **Build steps have pasta network access, even without `--pull`.** A recipe can download packages or run project code. Review the recipe and context before a build. The session's `--network none` setting does not make a build offline.

No project config is required if you supply the image and command explicitly. `--config` selects another regular config file. Config build paths are relative to that file. CLI build paths are relative to the selected project.

The config also accepts `command` as an argv array and `network` as `none` or `pasta`. `start` uses these fields unless the CLI overrides them. `launch` ignores the project command, build settings, and network setting.

### Optional setup prompt

From any project folder, run:

```sh
pi-sesh setup-prompt
```

This command prints instructions for a setup agent. It does not change files, read credentials, install software, or start a container. You can save the instructions:

```sh
pi-sesh setup-prompt > /tmp/pi-sesh-setup.md
```

If you already use Pi, you can send the prompt to it:

```sh
pi-sesh setup-prompt | pi --print
```

That command runs Pi **on the host**. It can make provider requests and change host files. Use it only if you approve that access. The prompt asks the agent to get approval before changes or downloads. The prompt is not a security control.

The instructions separate two tasks:

- User setup: select an agent and create one trusted preset. Reuse it across compatible projects.
- Project setup: select or build the development image and write project config.

Do not copy credentials or personal agent settings into the project. New setup files can make a Git repository dirty. Record those changes through your normal workflow before you use clone mode. The setup agent must not commit them automatically.

## Run an agent with a user preset

A preset is a named command with trusted user settings. Pi-sesh has no built-in `pi` preset and no bundled agent. You must supply the agent, its runtime dependencies, and any required settings or credentials.

Keep presets outside project folders. Store them in `${XDG_CONFIG_HOME:-$HOME/.config}/pi-sesh/launchers.json`. Pi-sesh uses `XDG_CONFIG_HOME` only when it is an absolute path.

Make the `pi-sesh` config directory user-owned with mode `0700`. Make `launchers.json` user-owned with mode `0600`. Neither may be a symlink. Preserve existing presets when you edit the file.

This example defines a preset named `agent`. Replace the program paths with real paths before use:

```json
{
  "version": 1,
  "presets": {
    "agent": {
      "command": ["/home/session/runtime/agent/bin/agent"],
      "workspace": "clone",
      "network": "none",
      "runtime": [
        {
          "source": "/absolute/path/to/agent-distribution",
          "destination": "/home/session/runtime/agent"
        }
      ]
    }
  }
}
```

The `source` is a host path. The `destination` and command path are container paths. A preset can also run a program already in the image without a runtime mount. `image`, `environment`, `runtime`, and `prepare` are optional. `command`, `workspace`, and `network` are required.

From a configured project, launch the preset:

```sh
pi-sesh agent
pi-sesh agent -- --version
```

`pi-sesh launch agent` remains available and uses the same launch path.

Use `--version` only if your agent supports it. Arguments after `--` are appended to the preset command. Pi-sesh generates a session name and reports it on stderr. Use `--name my-session` if you need a known name.

Network access is disabled in this preset. For an agent that needs a remote provider, explicitly select pasta and supply the required credentials through [session resources](#session-resources):

```sh
pi-sesh launch agent --network pasta
```

Network access alone does not configure a provider or supply credentials. It permits outbound connections; it does not restrict them to one provider.

For a Pi preset that you have created and named `pi`, an RPC launch can use:

```sh
pi-sesh launch pi --no-tty -- --mode rpc
```

Connect stdin and stdout as pipes. Pi-sesh does not parse the agent protocol. Workload streams and exit status pass through. Launcher messages use stderr. `launch` selects a TTY only when stdin and stdout are terminals and the launch is not detached. Use `--tty` or `--no-tty` to override that choice.

### Preset settings and trust

For `launch`, settings take this order:

| Setting | Highest priority to lowest priority |
| --- | --- |
| Image and workspace | CLI, project config, preset |
| Environment values | CLI `--env NAME=VALUE`, project config, preset |
| Network | CLI, preset; project network is ignored |

A preset without `image` allows the project to select the image. **That image can read all credentials supplied to the session.** Review it before launch. A preset image is a default. The CLI or project can override it. If a preset has both `prepare` and `image`, a different project image requires an explicit `--image` option.

Project config cannot select a preset, host preparation command, runtime mount, or handoff resource.

Environment values are literal, bounded, single-line strings. Pi-sesh rejects reserved variables and credential-like names. For example, you cannot set `HOME`, `PATH`, `HTTP_PROXY`, `OPENAI_API_KEY`, or `SSH_AUTH_SOCK`. Use handoff resources for credentials, not `--env`. Pi-sesh does not copy the host environment into the container. Environment values defined in the image can still apply.

### Program files and host preparation

Runtime mounts expose selected program files read-only. Their destinations must be normalized, non-overlapping paths below `/home/session/runtime/`. Sources must not expose broad host directories, credential stores, sockets, or special files. Internal symlinks are allowed. Symlinks that escape the selected program directory are rejected.

Supply all required runtime dependencies. Host program files must be compatible with the image's CPU architecture, loader, and libraries. Mounting a host executable alone is often not enough. Pi-sesh does not fall back to host execution when startup fails.

Runtime files are live mounts, not copies. Do not replace an installation while a session uses it. Pi-sesh does not relabel these files. SELinux hosts need compatible labels. Limits are 32 mounts and 100,000 source entries.

For setup that must run before each launch, add `prepare` as an argv array. Its first argument must be an absolute path to a trusted host executable. This code runs on the host with your user permissions. Keep it and its inputs outside project folders.

The preparation command runs in the host home directory. It receives only these environment variables:

- `HOME`: the host home directory.
- `PATH`: `/usr/bin:/bin`.
- `PI_SESH_PREPARE_DIR`: a private temporary directory.
- `PI_SESH_SESSION_NAME`: the selected session name.

It must write a private `handoff.json` in `PI_SESH_PREPARE_DIR`. Use `{"version":1,"resources":[]}` if no resources are needed. It can also write a private `runtime.json` to select the current program installation:

```json
{
  "version": 1,
  "mounts": [
    {
      "source": "/absolute/path/to/current-program-files",
      "destination": "/home/session/runtime/agent"
    }
  ]
}
```

Runtime sources must stay outside the temporary preparation directory. Pi-sesh deletes that directory after launch preparation is used. Pi-sesh does not interpret agent credentials, package managers, or settings.

## Workspaces and results

The container works in `/workspace`.

| Mode | Source requirements | Effect of writes |
| --- | --- | --- |
| `clone` | Clean, supported Git repository with a commit at HEAD | Changes stay in an independent session clone |
| `mount` | Existing folder | Changes affect the original folder |

Clone mode starts at local HEAD. It does not copy uncommitted or ignored files. The clone has no Git remote. Dirty repositories, submodules, linked worktrees, shared Git metadata, filters, and unsafe Git configuration are rejected. Use an approved mount if your project cannot meet these requirements.

`start` defaults to `mount` when no workspace setting is supplied. `launch` uses the precedence above. `open` defaults to `clone`.

After the workload exits, the container, clone, and retained resources remain. Use `inspect` to find `workspacePath` and resource `hostPath` values. Copy or review results before removal. Pi-sesh does not merge clone changes into the original repository.

Files written only to the default `/home/session` or `/tmp` are temporary. Use the workspace or an owned resource directory for results that must remain available.

## Session resources

Use `start --handoff /path/to/manifest.json` or `open --handoff /path/to/manifest.json` for explicit resources. A preset can supply them through its trusted preparation command. See [`examples/handoff/`](examples/handoff/) for an example.

A handoff manifest describes copied input files and session-owned output directories:

```json
{
  "version": 1,
  "resources": [
    {
      "id": "settings",
      "kind": "snapshot",
      "source": "selected/settings.json",
      "destination": "/home/session/.config/agent/settings.json",
      "access": "ro",
      "lifetime": "retained"
    },
    {
      "id": "output",
      "kind": "owned-directory",
      "destination": "/home/session/output",
      "lifetime": "retained"
    }
  ]
}
```

Snapshot sources must stay inside the manifest directory. Pi-sesh copies them into private session state. It does not mount or change the originals. Snapshot access is `ro` or `rw`. Owned directories start empty and are writable.

Destinations must be normalized paths below `/home/session/`. They must not overlap. Snapshots reject symlinks, special files, files owned by another user, and path escapes. Limits are 1 MiB per manifest, 32 resources, 10,000 files, and 64 MiB of copied data.

For credentials, use a snapshot with `"lifetime": "secret"` and `"access": "rw"`. Secret sources need private permissions. Deletion applies to the staged copy, not the original credential file. The workload can read, change, or copy a supplied secret.

Pi-sesh deletes staged secrets when it observes exit or verifies a stop. Removal also deletes them. If the launcher is no longer running, a later lifecycle command performs cleanup. Do not assume immediate cleanup after a detached workload exits.

Retained resources remain until `remove`. Use `inspect` to find their host paths. Copy results before removal.

## Manage sessions

`pi-sesh list` shows each session's project folder. This distinguishes separate copies of the same project. In terminal output, it adds a `PROJECT FOLDER` column. In piped output, each tab-separated row contains the name, state, exit status (or `-`), session ID, and JSON-quoted absolute project path. See [Programmatic use](docs/programmatic-usage.md) for Bun script examples, JSON output, RPC streams, and lifecycle handling.

```sh
pi-sesh list
pi-sesh inspect <name>
pi-sesh logs <name>
pi-sesh attach <name>
pi-sesh stop <name>
pi-sesh remove <name>
```

Use `--detach --tty` to start a terminal session for later attachment. Press `Ctrl-P`, then `Ctrl-Q` to detach without stopping the workload. `attach` connects to the same running process. It does not restart an exited session.

`start` defaults to a TTY for foreground runs. Use `--no-tty` for pipe-based commands. `launch` uses terminal detection as described above.

SIGINT or SIGTERM sent to an attached `launch` stops and verifies the container. A caught attached launch transport failure also stops it. Results remain after a verified stop. A launcher crash or `SIGKILL` can leave the workload running. Inspect it and use `stop` if needed. A terminal `Ctrl-C` can instead be handled by the workload as input.

`stop` allows 10 seconds for shutdown before Podman can force it. A paused container must be resumed before stop. Stop a running session before removal. Automation can pass `--session-id <id>` to `stop` and `remove` to reject a session that reuses the name.

`remove` verifies that the owned container is absent before it deletes a clone, resource, or session record. Engine errors and ownership mismatches block cleanup. Do not bypass these checks by deleting state directories manually.

### Cleanup shortcuts

Preview cleanup for the current project:

```sh
pi-sesh clean
```

Remove its stopped, never-started, or missing sessions:

```sh
pi-sesh clean --yes
```

**Removal deletes retained output and session-owned clones.** Copy results before removal. Running and paused sessions remain. Project files, development images, and shared agent settings remain.

To stop running sessions first:

```sh
pi-sesh stop-all
pi-sesh stop-all --yes
pi-sesh clean --yes
```

Stopping retains session results. Paused sessions are skipped; resume them before stopping.

Both commands default to the folder you run them from. Supply a project folder to select another project. Add `--all` to include all your projects. `--all` does not confirm an action; use `--yes` separately. It cannot be combined with a project folder.

```sh
pi-sesh clean /path/to/project
pi-sesh clean --all
pi-sesh clean --all --yes
```

Cleanup checks each session again before it changes resources. It checks the immutable session ID to protect a new session that reuses a name. Engine errors and ownership mismatches block removal. A failed action is reported; other selected sessions are still processed. The command returns a nonzero exit status if any action fails.

### Open an environment and execute commands

These commands do not require an agent preset:

```sh
pi-sesh open /path/to/project --name tools --image localhost/project:dev
pi-sesh inspect tools
pi-sesh exec tools --session-id <id> -- your-command argument
pi-sesh stop tools
pi-sesh remove tools
```

Use the immutable `id` from `open` or `inspect`, not the container ID. `open` starts a detached environment with clone mode and no network by default. Its image needs `/bin/sh` and `sleep`. `exec` runs argv in that environment and forwards command streams. Use `--cwd` to change its container working directory.

An `exec` cancellation, timeout, or transport failure stops the whole container, including other commands in it. Use `--timeout <seconds>` for an execution deadline. Private execution records store identity, time, and outcome, not argv or output.

## Container limits and security

Sessions use a local image resolved to an immutable image ID. They use your mapped UID/GID, a read-only image root, no Linux capabilities, and `no-new-privileges`.

Fixed limits are 4 GiB memory with no additional swap, 4 CPUs, and 512 PIDs. Writable paths are:

- `/workspace`.
- Selected writable resource mounts.
- A 1 GiB temporary `/home/session`.
- A 512 MiB temporary `/tmp`.

The default home and `/tmp` mounts use `noexec`. Tools that install or execute files there can fail. Read-only runtime mounts provide a separate place for program files. On SELinux hosts, pi-sesh can relabel the workspace and staged resources for container access. This includes the original folder in mount mode.

Pi-sesh does not automatically mount host home, original credential stores, or host sockets. Explicit snapshots and runtime mounts expose only the selected paths. A mounted project still exposes everything in that folder, including credentials stored there. Review its contents before use.

Networking is disabled unless the applicable config, trusted preset, or CLI option selects pasta. Pi-sesh supplies no published ports, host networking, workspace disk quota, or automatic workload deadline.

Session state lives under `${XDG_DATA_HOME:-$HOME/.local/share}/pi-sesh`. The boundary assumes a trusted local Podman engine and trusted user preparation code. It does not protect against a malicious host process with the same UID. The temporary home is not a multi-user security boundary. An agent can read supplied credentials and use enabled network access.

Older Pi-specific commands and host tool-routing extensions are not part of this CLI. Use `launch <preset>` for an agent. Existing host launchers are not migrated automatically.

## Development and validation

Run these commands from the source checkout with Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run format:check
bun run build
```

The executable entry point is `src/main.ts`, not `index.ts`.

Podman integration tests are opt-in:

```sh
PI_SESH_PODMAN_TESTS=1 bun test src/container/podman.integration.test.ts
PI_SESH_PODMAN_TESTS=1 bun test src/launch/launch.integration.test.ts
```

These tests use disposable workspaces and cached local images. They do not make provider requests. Run tests that need a live provider or change host credentials only with user approval.
