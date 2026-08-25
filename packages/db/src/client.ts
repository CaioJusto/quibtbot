import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;

export function createDb(connectionString: string): { prisma: PrismaClient; pool: Pool } {
  // Fail queries after 10s of waiting for a connection instead of hanging forever when the
  // pool is saturated; idle sockets recycle so a stale one is not handed out after a restart.
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  return { prisma, pool };
}

export type { Pool } from "pg";
export * from "./generated/prisma/client.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
