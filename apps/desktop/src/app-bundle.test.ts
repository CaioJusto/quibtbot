import { describe, expect, it } from "vitest";
import { appBundlePath } from "./app-bundle.js";

describe("appBundlePath", () => {
  it("sobe do binário até o .app no macOS", () => {
    expect(appBundlePath("/Applications/Quibt Bot.app/Contents/MacOS/Quibt Bot", "darwin")).toBe(
      "/Applications/Quibt Bot.app",
    );
  });
  it("não inventa pacote fora do macOS nem fora de um .app", () => {
    expect(appBundlePath("C:\\Program Files\\Quibt Bot\\Quibt Bot.exe", "win32")).toBeNull();
    expect(appBundlePath("/usr/bin/electron", "darwin")).toBeNull();
  });
});
