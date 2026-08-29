import { describe, expect, it } from "vitest";
import { bootstrapCommand, INSTALL_SCRIPT_COMMAND, serverHostOptions } from "./server-setup.js";

describe("serverHostOptions", () => {
  it("offers local, VPS and Box but never E2B as a server host", () => {
    expect(serverHostOptions().map((item) => item.kind)).toEqual(["local", "vps", "box"]);
  });
});

describe("bootstrapCommand", () => {
  it("uses the canonical CLI command", () => {
    expect(bootstrapCommand("linux")).toContain("/scripts/install.sh");
    expect(bootstrapCommand("linux")).toContain("QUIBT_SHOW_SENSITIVE=1");
  });
  it("names the release assets exactly as the release workflow publishes them", () => {
    expect(bootstrapCommand("linux")).toContain("QUIBT_RELEASE=0.2.17");
    expect(bootstrapCommand("darwin")).toContain("QUIBT_RELEASE=0.2.17");
    expect(bootstrapCommand("win32")).toContain("quibtbot-win32-x64.exe");
    expect(bootstrapCommand("win32")).toContain("checksums-0.2.17.txt");
    expect(bootstrapCommand("win32")).toContain("api.github.com");
  });
  it("sends the person's own computer to the arch-detecting script the site shows", () => {
    expect(INSTALL_SCRIPT_COMMAND).toContain("/scripts/install.sh");
    expect(INSTALL_SCRIPT_COMMAND).toContain("QUIBT_RELEASE=");
  });
});
