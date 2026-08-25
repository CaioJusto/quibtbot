import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { patchPodfile, MARKER } = require("../plugins/with-modern-libssh2.js") as {
  patchPodfile: (contents: string) => string;
  MARKER: string;
};

const PODFILE = [
  "require 'json'",
  "",
  "target 'QuibtBot' do",
  "  use_expo_modules!",
  "",
  "  post_install do |installer|",
  "    react_native_post_install(installer)",
  "  end",
  "end",
  "",
].join("\n");

describe("patchPodfile", () => {
  it("puts our library ahead of the pod's, per platform", () => {
    const patched = patchPodfile(PODFILE);
    expect(patched).toContain(MARKER);
    // `$(PLATFORM_NAME)` é o que faz o mesmo pod install servir para aparelho e
    // simulador; sem ele o link do simulador pegaria a biblioteca do iPhone.
    expect(patched).toContain("$(PLATFORM_NAME)");
    expect(patched).toMatch(/LIBRARY_SEARCH_PATHS'\] = \['"' \+ quibt_ssh_lib/);
    // Na frente do herdado, senão o diretório do pod (libssh2 1.8) ganharia.
    expect(patched).toMatch(/quibt_ssh_lib \+ '"', '\$\(inherited\)'/);
    expect(patched.indexOf("react_native_post_install")).toBeGreaterThan(patched.indexOf(MARKER));
  });

  it("refuses to build silently against the old library", () => {
    expect(patchPodfile(PODFILE)).toMatch(/raise .*build-ios-libssh2\.sh/);
  });

  it("does not stack up when prebuild runs again", () => {
    const once = patchPodfile(PODFILE);
    expect(patchPodfile(once)).toBe(once);
  });

  it("creates the hook when the Podfile has none", () => {
    const patched = patchPodfile("platform :ios, '15.1'\n");
    expect(patched).toContain("post_install do |installer|");
    expect(patched).toContain(MARKER);
  });
});
