# pi-sesh development guide

## Project

`pi-sesh` is a Linux x86-64 CLI for rootless Podman command sessions. It runs a literal argv in a local image, with a mounted or isolated Git-clone workspace. It also supports explicit handoff resources and trusted user launch presets.

The executable entry point is `src/main.ts`. The package build script compiles it to `dist/pi-sesh`.

## Development commands

Use Bun 1.3.14, as pinned in `mise.toml`. Use Bun instead of Node.js or another package manager.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run format:check
bun run build
```

Use `mise exec bun@1.3.14 -- <command>` when the pinned Bun version is not the active version. Podman integration tests are opt-in:

```sh
PI_SESH_PODMAN_TESTS=1 bun test src/container/podman.integration.test.ts
```

Do not run tests that require a live provider or change host credentials without user approval.

## Source layout

- `src/cli/`: CLI commands, session actions, output formatting, and CLI tests.
- `src/control/`: Bun TypeScript API for worker images and session control.
- `src/config/`: project config validation and effective settings.
- `src/container/`: Podman calls, container policy, and session lifecycle.
- `src/workspace/`: mounted and isolated clone workspaces.
- `src/handoff/`: explicit resource manifests, staging, and cleanup.
- `src/launch/`: private user presets, read-only program mounts, and preparation commands.
- `src/errors.ts`: shared errors.
- `scripts/`: opt-in project test-drive utility.
- `examples/`: example image and handoff inputs.

Tests sit beside the code they cover.

## Safety and behavior requirements

- Pass workload arguments as argv. Do not reconstruct a shell command from user input.
- Keep project configuration untrusted. Only explicitly selected user presets may choose host preparation commands or handoff resources.
- Keep environment forwarding explicit. Do not copy the host environment into a container.
- Keep Podman local and rootless. Do not add host-home, credential, socket, proxy, or host-network mounts.
- Keep session cleanup fail-closed. Verify the owned container is absent before deleting session-owned resources or records.
- Preserve ownership checks for staged handoff data and clone workspaces. Do not remove paths that fail those checks.
- Do not silently pull images or install workload tools at runtime.
- Keep integration and provider-dependent behavior opt-in.

Update `README.md` when user-facing commands, configuration, security boundaries, or lifecycle behavior change. Keep examples consistent with the CLI and validated config schema.
