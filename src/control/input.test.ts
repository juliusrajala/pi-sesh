import { expect, test } from "bun:test";
import { createPiSesh } from "./index";
import { validateArtifactInputs, validateSecretInputs } from "./input";

test("artifact destinations and IDs are canonical and unique", () => {
  for (const destination of [
    "/home/session/",
    "/home/session/../outside",
    "/home/session//output",
    "/home/session/output/",
    "/home/session/out\0put",
    "/home/session/out\nput",
    "/home/session/out,put",
    "/home/session/out:put",
    "/home/session/out\\put",
  ]) {
    expect(() =>
      validateArtifactInputs([{ id: "output", destination }]),
    ).toThrow("Artifact");
    expect(() =>
      validateSecretInputs([{ id: "input", destination, content: "data" }], []),
    ).toThrow("Secret file");
  }
  expect(() =>
    validateArtifactInputs([
      { id: "same", destination: "/home/session/one" },
      { id: "same", destination: "/home/session/two" },
    ]),
  ).toThrow("Artifact");
  expect(() =>
    validateArtifactInputs([
      { id: "one", destination: "/home/session/output" },
      { id: "two", destination: "/home/session/output/child" },
    ]),
  ).toThrow("Artifact");
});

test("secrets cannot overlap artifacts or other secrets", () => {
  const artifacts = [{ id: "output", destination: "/home/session/output" }];
  for (const destination of [
    "/home/session/output",
    "/home/session/output/child",
    "/home/session",
  ]) {
    expect(() =>
      validateSecretInputs(
        [{ id: "input", destination, content: "data" }],
        artifacts,
      ),
    ).toThrow("Secret file");
  }
  expect(() =>
    validateSecretInputs(
      [
        { id: "one", destination: "/home/session/secrets", content: "data" },
        {
          id: "two",
          destination: "/home/session/secrets/child",
          content: "data",
        },
      ],
      [],
    ),
  ).toThrow("Secret file");
  expect(
    validateSecretInputs(
      [
        {
          id: "input",
          destination: "/home/session/output-sibling",
          content: "data",
        },
      ],
      artifacts,
    ),
  ).toHaveLength(1);
});

test("the control API rejects duplicate artifacts before Podman access", async () => {
  const control = createPiSesh({ stateRoot: "/tmp/pi-sesh-input-test" });
  await expect(
    control.sessions.start({
      name: "worker",
      image: "localhost/test:local",
      workspace: { path: "/does-not-exist", mode: "clone" },
      command: ["agent"],
      artifacts: [
        { id: "same", destination: "/home/session/one" },
        { id: "same", destination: "/home/session/two" },
      ],
    }),
  ).rejects.toThrow("Artifact");
});
