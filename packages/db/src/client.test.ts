import { describe, expect, it } from "vitest";
import {
  createDb,
  DEFAULT_POOL_MAX,
  DEFAULT_TRANSACTION_TIMEOUT_MS,
  poolMaxFromEnv,
  transactionTimeoutFromEnv,
} from "./client.js";

const url = "postgres://quibt:quibt@127.0.0.1:5433/quibt";

describe("pool size", () => {
  it("uses the default when the env says nothing", () => {
    expect(poolMaxFromEnv({})).toBe(DEFAULT_POOL_MAX);
  });

  it("reads DATABASE_POOL_MAX", () => {
    expect(poolMaxFromEnv({ DATABASE_POOL_MAX: "40" })).toBe(40);
  });

  it("ignores a value that is not a whole positive number", () => {
    for (const raw of ["0", "-3", "abc", "2.5", ""]) {
      expect(poolMaxFromEnv({ DATABASE_POOL_MAX: raw })).toBe(DEFAULT_POOL_MAX);
    }
  });

  // `pg` never looks at `max` in the connection string, so before this the number was
  // stuck at the library default of 10 no matter what the operator wrote.
  it("hands the size to the pg pool", () => {
    const withEnv = createDb(url, { env: { DATABASE_POOL_MAX: "23" } });
    expect(withEnv.pool.options.max).toBe(23);
    const byDefault = createDb(url, { env: {} });
    expect(byDefault.pool.options.max).toBe(DEFAULT_POOL_MAX);
  });
});

describe("transaction deadline", () => {
  it("defaults to a deadline longer than the Prisma default of 5s", () => {
    expect(transactionTimeoutFromEnv({})).toBe(DEFAULT_TRANSACTION_TIMEOUT_MS);
    expect(DEFAULT_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it("reads DATABASE_TRANSACTION_TIMEOUT_MS", () => {
    expect(transactionTimeoutFromEnv({ DATABASE_TRANSACTION_TIMEOUT_MS: "45000" })).toBe(45_000);
  });

  it("ignores a value that is not a whole positive number", () => {
    for (const raw of ["0", "-1", "muito", "1e6ms"]) {
      expect(transactionTimeoutFromEnv({ DATABASE_TRANSACTION_TIMEOUT_MS: raw })).toBe(
        DEFAULT_TRANSACTION_TIMEOUT_MS,
      );
    }
  });
});
