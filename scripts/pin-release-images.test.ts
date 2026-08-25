import { describe, expect, it } from "vitest";
import { pinReleaseImages } from "./pin-release-images.mjs";

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const versionPlaceholder = "${" + "QUIBT_STACK_VERSION:?}";

describe("pinReleaseImages", () => {
  it("replaces every packaged image tag, including the supervisor child image", () => {
    const source = [
      `image: ghcr.io/quibt/quibt-stack:${versionPlaceholder}`,
      `image: ghcr.io/quibt/quibt-supervisor:${versionPlaceholder}`,
      `image: ghcr.io/quibt/quibt-computer:${versionPlaceholder}`,
      `QUIBT_COMPUTER_IMAGE: ghcr.io/quibt/quibt-computer:${versionPlaceholder}`,
    ].join("\n");
    const pinned = pinReleaseImages(source, {
      stack: digest("1"),
      supervisor: digest("2"),
      computer: digest("3"),
    });
    expect(pinned).not.toContain("QUIBT_STACK_VERSION");
    expect(pinned.match(/quibt-computer@sha256:/g)).toHaveLength(2);
    expect(pinned).toContain(`quibt-stack@${digest("1")}`);
  });

  it("fails closed without a real digest", () => {
    expect(() =>
      pinReleaseImages(`ghcr.io/quibt/quibt-stack:${versionPlaceholder}`, {
        stack: "latest",
        supervisor: digest("2"),
        computer: digest("3"),
      }),
    ).toThrow("stack digest");
  });
});
