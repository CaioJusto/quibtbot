import { describe, expect, it } from "vitest";
import { packagingEnvironment } from "./packaging-env.mjs";

describe("packagingEnvironment", () => {
  it("removes empty signing secrets so Electron Builder does not resolve them as paths", () => {
    expect(
      packagingEnvironment({
        PATH: "/bin",
        CSC_LINK: "",
        CSC_KEY_PASSWORD: "   ",
        WIN_CSC_LINK: "",
        APPLE_ID: "",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("preserves configured signing credentials and unrelated variables", () => {
    expect(
      packagingEnvironment({
        PATH: "/bin",
        CSC_LINK: "certificate.p12",
        CSC_KEY_PASSWORD: "secret",
      }),
    ).toEqual({ PATH: "/bin", CSC_LINK: "certificate.p12", CSC_KEY_PASSWORD: "secret" });
  });
});
