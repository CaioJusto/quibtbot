import { describe, expect, it } from "vitest";
import { hashBootstrapSecret } from "./bootstrap-invite.js";
import {
  checkDeviceCode,
  createDeviceCode,
  DEVICE_CODE_MAX_ATTEMPTS,
  DEVICE_CODE_TTL_MS,
  type DeviceCodeRecord,
  deviceCodeHash,
  deviceCodeRejectionMessage,
  deviceLabel,
  deviceRequestState,
  formatDeviceCode,
  isWellFormedDeviceCode,
} from "./device-code.js";

const now = new Date("2026-08-19T10:00:00.000Z");
const bytes = () => new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a]);

describe("createDeviceCode", () => {
  it("gera oito caracteres digitáveis e guarda só o hash", () => {
    const created = createDeviceCode("user-1", now, bytes, () => "code-1");
    expect(created.code).toHaveLength(8);
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(created.record.codeHash).toBe(hashBootstrapSecret(created.code));
    expect(created.record.codeHash).not.toContain(created.code);
    expect(created.record.expiresAt.getTime()).toBe(now.getTime() + DEVICE_CODE_TTL_MS);
    expect(created.record.attempts).toBe(0);
  });

  it("recusa entropia fora do tamanho — um código curto demais seria adivinhável", () => {
    expect(() =>
      createDeviceCode(
        "user-1",
        now,
        () => new Uint8Array([1, 2]),
        () => "x",
      ),
    ).toThrow();
  });
});

describe("digitação do código", () => {
  it("aceita minúsculas, espaços e as trocas clássicas de O/0 e I/1", () => {
    const created = createDeviceCode("user-1", now, bytes, () => "code-1");
    const typed = formatDeviceCode(created.code).toLowerCase();
    expect(deviceCodeHash(typed)).toBe(created.record.codeHash);
    expect(deviceCodeHash("oiOI0110")).toBe(deviceCodeHash("01010110"));
  });

  it("separa em blocos de quatro para ler em voz alta", () => {
    expect(formatDeviceCode("ABCD1234")).toBe("ABCD 1234");
  });

  it("rejeita formato errado antes de gastar tentativa no banco", () => {
    expect(isWellFormedDeviceCode("ABCD1234")).toBe(true);
    expect(isWellFormedDeviceCode("abcd 1234")).toBe(true);
    expect(isWellFormedDeviceCode("ABC")).toBe(false);
    expect(isWellFormedDeviceCode("ABCD12345")).toBe(false);
    expect(isWellFormedDeviceCode("ABCD-234")).toBe(false);
  });
});

describe("checkDeviceCode", () => {
  const record: DeviceCodeRecord = {
    id: "code-1",
    userId: "user-1",
    codeHash: "hash",
    expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_MS),
    consumedAt: null,
    attempts: 0,
    createdAt: now,
  };

  it("aceita um código novo dentro do prazo", () => {
    expect(checkDeviceCode(record, now)).toEqual({ ok: true, record });
  });

  it("recusa vencido, já usado, sem registro e queimado por tentativas", () => {
    const later = new Date(now.getTime() + DEVICE_CODE_TTL_MS + 1);
    expect(checkDeviceCode(record, later)).toEqual({ ok: false, reason: "expired" });
    expect(checkDeviceCode({ ...record, consumedAt: now }, now)).toEqual({
      ok: false,
      reason: "consumed",
    });
    expect(checkDeviceCode(null, now)).toEqual({ ok: false, reason: "not-found" });
    expect(checkDeviceCode({ ...record, attempts: DEVICE_CODE_MAX_ATTEMPTS }, now)).toEqual({
      ok: false,
      reason: "too-many-attempts",
    });
  });

  it("cada recusa diz o que fazer, sem revelar se o código existe", () => {
    expect(deviceCodeRejectionMessage("not-found")).toBe("Código não confere.");
    expect(deviceCodeRejectionMessage("expired")).toContain("venceu");
    expect(deviceCodeRejectionMessage("too-many-attempts")).toContain("bloqueado");
  });
});

describe("deviceRequestState", () => {
  const base = {
    id: "d1",
    userId: "u1",
    codeHash: "h",
    attempts: 0,
    createdAt: new Date(0),
    consumedAt: null,
  };
  const future = new Date(10_000);
  const now = new Date(5_000);

  it("is unknown until somebody types the code", () => {
    expect(deviceRequestState({ ...base, expiresAt: future }, now)).toBe("unknown");
    expect(deviceRequestState(null, now)).toBe("unknown");
  });

  it("waits after the code is typed: the code alone does not open the account", () => {
    expect(
      deviceRequestState({ ...base, expiresAt: future, claimedAt: new Date(1_000) }, now),
    ).toBe("pending");
  });

  it("honours a decision even after the deadline", () => {
    // Quem recusou já recusou; o relógio não transforma isso noutra coisa.
    const past = new Date(1_000);
    expect(
      deviceRequestState(
        { ...base, expiresAt: past, claimedAt: past, deniedAt: new Date(2_000) },
        now,
      ),
    ).toBe("denied");
    expect(
      deviceRequestState(
        { ...base, expiresAt: past, claimedAt: past, approvedAt: new Date(2_000) },
        now,
      ),
    ).toBe("approved");
  });

  it("drops a request nobody answered in time", () => {
    expect(
      deviceRequestState({ ...base, expiresAt: new Date(1_000), claimedAt: new Date(500) }, now),
    ).toBe("expired");
  });

  it("a denial outranks an approval, so a mistaken yes can be taken back", () => {
    expect(
      deviceRequestState(
        {
          ...base,
          expiresAt: future,
          claimedAt: new Date(1_000),
          approvedAt: new Date(2_000),
          deniedAt: new Date(3_000),
        },
        now,
      ),
    ).toBe("denied");
  });
});

describe("deviceLabel", () => {
  it("falls back when the device sent nothing", () => {
    expect(deviceLabel(null)).toBe("Um celular");
    expect(deviceLabel("   ")).toBe("Um celular");
  });

  it("tames text that came from outside", () => {
    expect(deviceLabel("iPhone\n de  Caio")).toBe("iPhone de Caio");
    expect(deviceLabel("x".repeat(80))).toHaveLength(48);
  });
});
