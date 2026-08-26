import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.dirname(new URL(import.meta.url).pathname);

function source(relative: string) {
  return readFileSync(path.join(dir, relative), "utf8");
}

describe("mobile remote server update", () => {
  it("exposes update from a saved SSH credential instead of only forgetting it", () => {
    const account = source("../app/account.tsx");
    expect(account).toContain("Atualizar servidor");
    expect(account).toContain('action: "update"');
    expect(account).toContain("parseSshCredentialHostId");
  });

  it("requires fingerprint confirmation and biometric credential loading", () => {
    const setup = source("../app/setup-ssh.tsx");
    expect(setup).toContain("runVerifiedRemoteUpdate");
    expect(setup).toContain("loadInfrastructureCredential");
    expect(setup).toContain("Verificar e atualizar");
    expect(setup).toContain("Face ID");
    expect(setup).toContain("backup");
  });
});
