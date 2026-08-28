import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;

/**
 * Quantas conexões um processo abre. `pg` não lê `max` da URL, então sem isto o número
 * ficava preso em 10 e ninguém conseguia mudar. Uma das conexões fica presa no LISTEN do
 * despertador e uma tela de conversa dispara até 7 consultas juntas, então 10 apertava
 * com dois pollers. 16 por processo ainda cabe folgado no `max_connections` padrão (100).
 */
export const DEFAULT_POOL_MAX = 16;
/**
 * O prazo padrão do Prisma para uma transação interativa é 5 s. Apagar um bot ou uma
 * conta com histórico longo passa disso, e a transação era desfeita DEPOIS de o
 * computador já ter sido destruído no provedor — o bot ficava sem computador e sem
 * conserto. O prazo maior vale para a transação inteira; o limite de espera por uma
 * conexão livre continua curto para não esconder um pool saturado.
 */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_TRANSACTION_MAX_WAIT_MS = 10_000;

/** Um inteiro positivo dentro do limite, ou o padrão quando o valor não serve. */
function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return fallback;
  return parsed;
}

/** Conexões por processo: `DATABASE_POOL_MAX`. */
export function poolMaxFromEnv(env: Record<string, string | undefined> = process.env): number {
  return positiveInt(env.DATABASE_POOL_MAX, DEFAULT_POOL_MAX, 1_000);
}

/** Prazo da transação interativa, em ms: `DATABASE_TRANSACTION_TIMEOUT_MS`. */
export function transactionTimeoutFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveInt(env.DATABASE_TRANSACTION_TIMEOUT_MS, DEFAULT_TRANSACTION_TIMEOUT_MS, 600_000);
}

export type CreateDbOptions = {
  poolMax?: number;
  transactionTimeoutMs?: number;
  env?: Record<string, string | undefined>;
};

export function createDb(
  connectionString: string,
  options: CreateDbOptions = {},
): { prisma: PrismaClient; pool: Pool } {
  const env = options.env ?? process.env;
  // Fail queries after 10s of waiting for a connection instead of hanging forever when the
  // pool is saturated; idle sockets recycle so a stale one is not handed out after a restart.
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 10_000,
    max: options.poolMax ?? poolMaxFromEnv(env),
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({
    adapter,
    transactionOptions: {
      timeout: options.transactionTimeoutMs ?? transactionTimeoutFromEnv(env),
      maxWait: DEFAULT_TRANSACTION_MAX_WAIT_MS,
    },
  });
  return { prisma, pool };
}

export type { Pool } from "pg";
export * from "./generated/prisma/client.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
