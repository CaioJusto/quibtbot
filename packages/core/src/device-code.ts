import {
  encodeCrockfordBase32,
  hashBootstrapSecret,
  normalizeBootstrapCode,
} from "./bootstrap-invite.js";

/**
 * Entrar em outro aparelho sem e-mail e sem senha.
 *
 * Quem já está dentro (o computador, o celular pareado) manda o Quibt mostrar um
 * código curto; quem está chegando digita esse código e ganha uma sessão. A conta
 * mora na máquina da pessoa — provar que se está com ela é a única prova que faz
 * sentido aqui. É o mesmo desenho do código de instalação, com três regras que o
 * tornam seguro apesar de curto:
 *
 * - vida curta: cinco minutos, não uma sessão inteira;
 * - uso único: o primeiro claim consome, os seguintes falham;
 * - tentativas contadas: seis erros queimam o código, para que 8 caracteres não
 *   virem alvo de força bruta numa VPS exposta.
 *
 * O código nunca é guardado: fica só o SHA-256, como o do bootstrap.
 */
export const DEVICE_CODE_TTL_MS = 5 * 60_000;
export const DEVICE_CODE_MAX_ATTEMPTS = 6;
/** 5 bytes = 8 caracteres Crockford: ~1 trilhão de combinações, digitável. */
export const DEVICE_CODE_ENTROPY_BYTES = 5;

export interface DeviceCodeRecord {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  createdAt: Date;
  /**
   * O pedido nasce quando alguém acerta o código, e fica esperando quem está no
   * computador dizer sim. Enquanto `claimedAt` existe e `approvedAt` não, ninguém
   * entrou: o código sozinho não abre a conta.
   */
  claimedAt?: Date | null;
  approvedAt?: Date | null;
  deniedAt?: Date | null;
  deviceName?: string | null;
  requestSecretHash?: string | null;
}

export interface CreatedDeviceCode {
  code: string;
  record: DeviceCodeRecord;
}

export function createDeviceCode(
  userId: string,
  now: Date,
  randomCodeBytes: () => Uint8Array,
  newId: () => string,
): CreatedDeviceCode {
  const entropy = randomCodeBytes();
  if (entropy.length !== DEVICE_CODE_ENTROPY_BYTES) {
    throw new Error("device code entropy must be exactly five bytes");
  }
  const code = encodeCrockfordBase32(entropy);
  return {
    code,
    record: {
      id: newId(),
      userId,
      codeHash: hashBootstrapSecret(code),
      expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_MS),
      consumedAt: null,
      attempts: 0,
      createdAt: now,
    },
  };
}

/** Agrupa em blocos de quatro para ler em voz alta e digitar sem errar. */
export function formatDeviceCode(code: string): string {
  const clean = normalizeBootstrapCode(code).replace(/[^0-9A-Z]/g, "");
  return clean.replace(/(.{4})(?=.)/g, "$1 ");
}

export function deviceCodeHash(code: string): string {
  return hashBootstrapSecret(normalizeBootstrapCode(code).replace(/\s+/g, ""));
}

export type DeviceCodeRejection =
  | "not-found"
  | "expired"
  | "consumed"
  | "too-many-attempts"
  | "malformed";

export function deviceCodeRejectionMessage(reason: DeviceCodeRejection): string {
  switch (reason) {
    case "malformed":
      return "Esse código tem 8 caracteres. Confira e digite de novo.";
    case "expired":
      return "Esse código venceu. Peça um novo no aparelho que já está conectado.";
    case "consumed":
      return "Esse código já foi usado. Peça um novo.";
    case "too-many-attempts":
      return "Esse código foi bloqueado por tentativas erradas. Peça um novo.";
    default:
      return "Código não confere.";
  }
}

/** O formato é checado antes do banco: erro de digitação não gasta tentativa. */
export function isWellFormedDeviceCode(code: string): boolean {
  return /^[0-9A-Z]{8}$/.test(normalizeBootstrapCode(code).replace(/\s+/g, ""));
}

export function checkDeviceCode(
  record: DeviceCodeRecord | null,
  now = new Date(),
): { ok: true; record: DeviceCodeRecord } | { ok: false; reason: DeviceCodeRejection } {
  if (!record) return { ok: false, reason: "not-found" };
  if (record.consumedAt) return { ok: false, reason: "consumed" };
  if (record.attempts >= DEVICE_CODE_MAX_ATTEMPTS) {
    return { ok: false, reason: "too-many-attempts" };
  }
  if (record.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, record };
}

export type DeviceRequestState = "pending" | "approved" | "denied" | "expired" | "unknown";

/**
 * Em que pé está o pedido de um aparelho. A ordem importa: recusa e aprovação valem
 * mesmo depois do prazo, porque quem decidiu já decidiu — o relógio só derruba o que
 * ficou sem resposta.
 */
export function deviceRequestState(
  record: DeviceCodeRecord | null,
  now = new Date(),
): DeviceRequestState {
  if (!record?.claimedAt) return "unknown";
  if (record.deniedAt) return "denied";
  if (record.approvedAt) return "approved";
  if (record.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

/**
 * O nome que aparece para quem vai aprovar. Vem do aparelho, então é texto de fora:
 * cabe cortar o tamanho e as quebras de linha antes de mostrar numa lista.
 */
export function deviceLabel(raw: string | null | undefined): string {
  const clean = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
  return clean || "Um celular";
}
