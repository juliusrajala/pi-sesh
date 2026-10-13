import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProjectImage, PodmanClient } from "../container/podman";

const integration = test.skipIf(process.env.PI_SESH_PODMAN_TESTS !== "1");
const entry = resolve(import.meta.dir, "../main.ts");
integration(
  "one launch path contains changing external agents and new tools without rebuilding the project image",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sesh-launch-"));
    const project = join(root, "project"),
      runtime = join(root, "program"),
      config = join(root, "config");
    await mkdir(project);
    await mkdir(runtime);
    await mkdir(join(config, "pi-sesh"), { recursive: true, mode: 0o700 });
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: config,
      HOST_SECRET_TEST: "must-not-forward",
    };
    async function run(argv: string[], stdin?: string) {
      const child = Bun.spawn({
        cmd: argv,
        cwd: project,
        env,
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, status };
    }
    const cli = (args: string[], stdin?: string) =>
      run([process.execPath, entry, ...args], stdin);
    const client = await PodmanClient.create({ projectDir: project });
    const image = `localhost/pi-sesh-launch-test:${crypto.randomUUID()}`;
    const names: string[] = [];
    try {
      expect((await run(["git", "init", "--initial-branch=main"])).status).toBe(
        0,
      );
      await writeFile(join(project, "source.txt"), "source\n");
      await writeFile(
        join(project, "Containerfile"),
        "FROM docker.io/library/node:22-bookworm-slim\nWORKDIR /workspace\n",
      );
      await writeFile(
        join(project, "pi-sesh.json"),
        JSON.stringify({ version: 1, image }),
      );
      expect((await run(["git", "add", "."])).status).toBe(0);
      expect(
        (
          await run([
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "Fixture",
          ])
        ).status,
      ).toBe(0);
      const built = await buildProjectImage(
        {
          projectDir: project,
          image,
          build: { context: project, file: join(project, "Containerfile") },
          workspace: "clone",
          network: "none",
        },
        { client },
      );
      await writeFile(
        join(runtime, "agent"),
        `#!/bin/sh\nset -eu\ntest "$PWD" = /workspace\ntest -n "$PI_SESH_SESSION_ID"\ntest -z "\${HOST_SECRET_TEST:-}"\ntest ! -e '${join(root, "host-only")}'\n! touch /home/session/runtime/agent/host-write 2>/dev/null\nprintf result > result.txt\nread -r request\nprintf '%s|%s\\n' "$(cat /home/session/runtime/agent/version)" "$request"\nfor tool in /home/session/runtime/agent/tool-*; do [ ! -e "$tool" ] || "$tool"; done\n`,
        { mode: 0o700 },
      );
      await writeFile(join(runtime, "version"), "one");
      await writeFile(join(root, "host-only"), "host data");
      await writeFile(
        join(config, "pi-sesh", "launchers.json"),
        JSON.stringify({
          version: 1,
          presets: {
            agent: {
              command: ["/home/session/runtime/agent/agent"],
              workspace: "clone",
              network: "none",
              runtime: [
                { source: runtime, destination: "/home/session/runtime/agent" },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      for (const version of ["one", "two"]) {
        if (version === "two") {
          await writeFile(join(runtime, "version"), "two");
          await writeFile(
            join(runtime, "tool-new"),
            "#!/bin/sh\nprintf new-tool > new-tool.txt\nprintf 'new-tool\\n'\n",
            { mode: 0o700 },
          );
        }
        const name = `launch-${version}-${crypto.randomUUID().slice(0, 8)}`;
        names.push(name);
        const result = await cli(
          ["launch", "agent", "--name", name, "--", "--mode", "rpc"],
          "literal request\n",
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(
          `${version}|literal request\n${version === "two" ? "new-tool\n" : ""}`,
        );
        expect(result.stderr).toContain(`Preset agent session ${name}`);
        const inspected = await cli(["inspect", name]);
        const record = JSON.parse(inspected.stdout);
        expect(record.state).toBe("exited");
        expect(record.exitCode).toBe(0);
        expect(record.workspace).toBe("clone");
        expect(record.network).toBe("none");
        expect(record.imageId).toBe(built.imageId);
        expect(
          await Bun.file(join(record.workspacePath, "result.txt")).text(),
        ).toBe("result");
        if (version === "two")
          expect(
            await Bun.file(join(record.workspacePath, "new-tool.txt")).text(),
          ).toBe("new-tool");
        expect(await Bun.file(join(project, "result.txt")).exists()).toBe(
          false,
        );
        expect(await Bun.file(join(project, "new-tool.txt")).exists()).toBe(
          false,
        );
        expect(await Bun.file(join(runtime, "host-write")).exists()).toBe(
          false,
        );
        expect((await cli(["remove", name])).status).toBe(0);
        names.pop();
      }
      const missing = await cli([
        "launch",
        "agent",
        "--image",
        "localhost/absent-launch-test:missing",
      ]);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain("is not present locally");
      expect(await client.imageId(image)).toBe(built.imageId);
      expect((await run(["git", "status", "--porcelain"])).stdout).toBe("");
    } finally {
      for (const name of names) {
        await cli(["stop", name]);
        await cli(["remove", name]);
      }
      await client.invoke(["image", "rm", "--force", image]);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
