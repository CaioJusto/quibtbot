import { describe, expect, it } from "vitest";
import {
  type InstallerSmokeResult,
  probeFakeDockerStrictness,
  runInstallerSmokeJourney,
  runInstallerSmokeSanitizedFailure,
} from "./installer-smoke.harness.js";

function collectSecrets(values: Record<string, string>): string[] {
  return [
    values.BETTER_AUTH_SECRET,
    values.ENCRYPTION_KEY,
    values.SANDBOX_SUPERVISOR_TOKEN,
    values.BOOTSTRAP_SECRET,
    values.DATABASE_PASSWORD,
  ].filter(Boolean);
}

function assertNoSecretsInEvents(result: InstallerSmokeResult, secrets: string[]): void {
  for (const event of result.events) {
    const serialized = JSON.stringify(event);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("BOOTSTRAP_SECRET=");
    expect(serialized).not.toContain("BETTER_AUTH_SECRET=");
    expect(serialized).not.toContain("DATABASE_PASSWORD=");
  }
}

describe("installer integration smoke", () => {
  it("rejects unknown fake docker commands", async () => {
    const probe = await probeFakeDockerStrictness();
    expect(probe.unknownComposeCode).not.toBe(0);
    expect(probe.unknownTopLevelCode).not.toBe(0);
  });

  it("interpolates release, generates env, runs docker in order, probes ready, and reruns idempotently", async () => {
    const result = await runInstallerSmokeJourney();

    expect(result.first.ok).toBe(true);
    expect(result.first.pairingPending).toBe(true);
    expect(result.envValues.QUIBT_STACK_VERSION).toBe(result.release);
    expect(result.resolvedImages.every((image) => image.includes(`:${result.release}`))).toBe(true);

    expect(result.commandOrder).toEqual([
      "image pull",
      "compose up postgres",
      "compose run migrate",
      "compose up apps",
    ]);
    expect(result.readyProbes).toEqual([result.readyUrl]);

    const secrets = collectSecrets(result.envValues);
    assertNoSecretsInEvents(result, secrets);

    // Segunda passada com o estado completo: religa (um `up --wait`), sem baixar nem migrar.
    expect(result.second.ok).toBe(true);
    expect(result.second.alreadyInstalled).toBe(true);
    expect(result.second.pairingPending).toBeUndefined();
    expect(result.envMtimeUnchanged).toBe(true);
    expect(
      result.dockerCommandsOnRerun.filter(
        (line) => line.startsWith("compose ") && line.includes(" up "),
      ),
    ).toHaveLength(1);
    expect(
      result.dockerCommandsOnRerun.some(
        (line) => line.startsWith("pull ") || line.includes("quibt-migrate"),
      ),
    ).toBe(false);
  });

  it("sanitizes failure logs when docker pull fails", async () => {
    const result = await runInstallerSmokeSanitizedFailure();
    const secrets = collectSecrets(result.envValues);

    expect(result.first.ok).toBe(false);
    expect(result.failedStep).toBe("images");
    expect(result.failureMessage).toMatch(/pull failed/i);
    expect(result.failureMessage).toContain("[REDACTED]");
    for (const secret of secrets) {
      expect(result.failureMessage).not.toContain(secret);
    }
    for (const event of result.events) {
      const serialized = JSON.stringify(event);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});
