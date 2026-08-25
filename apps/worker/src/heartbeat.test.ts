import { describe, expect, it } from "vitest";
import { workerIdentity } from "./heartbeat.js";

describe("workerIdentity", () => {
  it("é host:pid, com a versão do stack publicado", () => {
    expect(workerIdentity({ QUIBT_STACK_VERSION: "0.2.11" }, { host: "vps", pid: 42 })).toEqual({
      workerId: "vps:42",
      version: "0.2.11",
    });
  });

  it("do código-fonte, cai na versão do pacote e por fim em dev", () => {
    expect(workerIdentity({ npm_package_version: "0.1.0" }, { host: "mac", pid: 7 })).toEqual({
      workerId: "mac:7",
      version: "0.1.0",
    });
    expect(workerIdentity({ QUIBT_STACK_VERSION: "  " }, { host: "mac", pid: 7 }).version).toBe(
      "dev",
    );
  });

  it("sem opções, usa o processo de verdade", () => {
    const identity = workerIdentity({});
    expect(identity.workerId).toMatch(new RegExp(`:${process.pid}$`));
  });
});
