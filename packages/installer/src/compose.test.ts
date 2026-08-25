import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeServices, readComposeFile } from "../../testkit/src/compose-config.js";
import { allQuibtImages, composeInvocation, DESKTOP_SIGNING, INSTALL_RELEASE } from "./compose.js";

const desktopComposeFile = path.resolve("infra/compose/docker-compose.desktop.yml");
const manifest = readComposeFile(desktopComposeFile);
const desktopServices = composeServices(manifest);
const release = INSTALL_RELEASE;

const APP_SERVICES = ["supervisor", "api", "worker", "web"] as const;

describe("desktop compose manifest", () => {
  it("pins postgres and uses image-only Quibt services", () => {
    expect(desktopServices.postgres?.image).toBe(
      "postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5",
    );
    expect(desktopServices.api?.build).toBeUndefined();
    expect(desktopServices.worker?.build).toBeUndefined();
    expect(desktopServices.web?.build).toBeUndefined();
    expect(desktopServices.supervisor?.build).toBeUndefined();
    expect(desktopServices.computer?.build).toBeUndefined();
    expect(allQuibtImages(manifest)).toEqual([
      `ghcr.io/quibt/quibt-stack:${release}`,
      `ghcr.io/quibt/quibt-supervisor:${release}`,
      `ghcr.io/quibt/quibt-computer:${release}`,
    ]);
  });

  it("loads env from the host path interpolated by the installer", () => {
    for (const name of APP_SERVICES) {
      expect(desktopServices[name]?.env_file).toEqual([`\${INSTALL_ENV_FILE:?}`]);
    }
  });

  it("gives web the auth env it needs without container-only paths", () => {
    expect(desktopServices.web?.env_file).toEqual([`\${INSTALL_ENV_FILE:?}`]);
    expect(String(desktopServices.web?.environment?.BETTER_AUTH_SECRET)).toBe(
      `\${BETTER_AUTH_SECRET:?}`,
    );
    expect(String(desktopServices.web?.environment?.WEB_ORIGIN)).toBe(`\${WEB_ORIGIN:?}`);
  });
});

describe("composeInvocation", () => {
  const composeFile = "/tmp/compose.yml";
  const envFile = "/tmp/quibt.env";
  const base = ["compose", "-f", composeFile, "--env-file", envFile];

  it("builds from source checkout", () => {
    expect(composeInvocation("source", composeFile, envFile, "pull")).toEqual([...base, "build"]);
    expect(composeInvocation("source", composeFile, envFile)).toEqual([
      ...base,
      "up",
      "-d",
      "--build",
    ]);
  });

  it("pulls images before waiting in packaged mode", () => {
    expect(composeInvocation("packaged", composeFile, envFile, "pull")).toEqual([...base, "pull"]);
    const up = composeInvocation("packaged", composeFile, envFile, "up");
    expect(up).toEqual([...base, "up", "-d", "--wait"]);
    expect(up).not.toContain("--build");
  });
});

describe("DESKTOP_SIGNING", () => {
  it("never claims a notarized Mac build that is not signed", () => {
    // Notarização pressupõe assinatura Developer ID: o par (signed:false, notarized:true) não
    // existe num signing-status-mac.json real.
    if (DESKTOP_SIGNING.mac.notarized) expect(DESKTOP_SIGNING.mac.signed).toBe(true);
    for (const platform of ["mac", "win", "linux"] as const) {
      expect(typeof DESKTOP_SIGNING[platform].signed).toBe("boolean");
    }
  });
});
