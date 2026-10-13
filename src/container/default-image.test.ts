import { expect, test } from "bun:test";
import { DEFAULT_CONTAINERFILE } from "./default-image";

test("the shared default image recipe installs Git in the Bun image", () => {
  expect(DEFAULT_CONTAINERFILE).toContain("FROM docker.io/oven/bun:1.3.14");
  expect(DEFAULT_CONTAINERFILE).toContain(
    "apt-get install -y --no-install-recommends git",
  );
});
