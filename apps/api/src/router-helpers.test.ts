import { ORPCError } from "@orpc/server";
import { COMPOSIO_REQUEST_TIMEOUT_MS } from "@quibt/adapters";
import type { Actor } from "@quibt/contracts";
import type { PrismaClient, WebhookReceiveResult } from "@quibt/db";
import { describe, expect, it, vi } from "vitest";
import {
  capabilitiesForProvider,
  capabilityDigest,
  claimUserRun,
  completeStoredConnection,
  deleteAccountData,
  findUserMessageForRun,
  type RouterDeps,
  requireBillingOwner,
  usageSummaryStart,
  webhookCredentialFor,
  webhookTestRunError,
} from "./router.js";

describe("requireBillingOwner", () => {
  it("allows owners and rejects ordinary workspace members", () => {
    expect(() => requireBillingOwner(actor)).not.toThrow();
    expect(() => requireBillingOwner({ ...actor, workspaceRole: "member" })).toThrow();
  });
});

describe("capabilitiesForProvider", () => {
  const installs = [
    { kind: "connection", name: "GitHub", source: "github" },
    { kind: "skill", name: "changelog", source: "github" },
    { kind: "skill", name: "inbox-triage", source: "gmail" },
    { kind: "plugin", name: "changelog", source: "github" },
  ];

  it("reports what is actually installed against that provider", () => {
    expect(capabilitiesForProvider(installs, "github")).toEqual(["GitHub", "changelog"]);
    expect(capabilitiesForProvider(installs, "gmail")).toEqual(["inbox-triage"]);
  });

  it("stays empty rather than inventing a tool catalog", () => {
    expect(capabilitiesForProvider(installs, "slack")).toEqual([]);
    expect(capabilitiesForProvider([], "github")).toEqual([]);
  });
});

describe("capabilityDigest", () => {
  it("digests the source and config instead of a placeholder", () => {
    const digest = capabilityDigest("github", { repo: "quibt-bot" });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest).not.toBe("sha256:local");
  });

  it("is stable across key order and changes with content", () => {
    expect(capabilityDigest("github", { a: 1, b: 2 })).toBe(
      capabilityDigest("github", { b: 2, a: 1 }),
    );
    expect(capabilityDigest("github", { a: 1 })).not.toBe(capabilityDigest("gitlab", { a: 1 }));
    expect(capabilityDigest("github", { a: 1 })).not.toBe(capabilityDigest("github", { a: 2 }));
  });
});

describe("usageSummaryStart", () => {
  it("starts a rolling seven-day window", () => {
    expect(usageSummaryStart(new Date("2026-08-14T12:00:00Z"))).toEqual(
      new Date("2026-08-07T12:00:00Z"),
    );
  });
});

const actor: Actor = {
  userId: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "owner",
  email: "owner@example.com",
  isDeploymentOwner: true,
};

function completionHarness(
  options: { composio?: boolean; completeFails?: boolean; ready?: boolean } = {},
) {
  const calls: string[] = [];
  const updates: unknown[] = [];
  const deps = {
    prisma: {
      connection: {
        updateMany: async (args: unknown) => {
          calls.push("update");
          updates.push(args);
          return { count: 1 };
        },
      },
    },
    composio:
      options.composio === false
        ? undefined
        : {
            complete: async ({ state }: { state: string; code?: string }) => {
              calls.push(`complete:${state}`);
              if (options.completeFails) throw new Error("still pending");
              return { connectionRef: "ca-live" };
            },
            connectionReady: async () => {
              calls.push("ready");
              return options.ready ?? false;
            },
          },
  } as unknown as Pick<RouterDeps, "prisma" | "composio">;
  return { deps, calls, updates };
}

describe("completeStoredConnection", () => {
  const pending = {
    id: "conn-1",
    provider: "github",
    status: "pending",
    providerRef: "ca-pending",
    metadata: {},
  };

  it("stays fail-closed without Composio or without stored provider state", async () => {
    const disabled = completionHarness({ composio: false });
    await completeStoredConnection(disabled.deps, actor, pending, "secret-code");
    expect(disabled.calls).toEqual([]);

    const stateless = completionHarness();
    await completeStoredConnection(
      stateless.deps,
      actor,
      { ...pending, providerRef: null, metadata: {} },
      "secret-code",
    );
    expect(stateless.calls).toEqual([]);
  });

  it("is idempotent when connected and never reconnects a revoked row", async () => {
    for (const status of ["connected", "revoked"]) {
      const harness = completionHarness();
      await completeStoredConnection(harness.deps, actor, { ...pending, status }, "secret-code");
      expect(harness.calls).toEqual([]);
    }
  });

  it("marks a stored pending request connected only after Composio confirms it", async () => {
    const harness = completionHarness();
    await completeStoredConnection(harness.deps, actor, pending, "secret-code");
    expect(harness.calls).toEqual(["complete:ca-pending", "update"]);
    expect(harness.updates).toEqual([
      {
        where: {
          id: "conn-1",
          workspaceId: "ws-1",
          userId: "user-1",
          status: { in: ["pending", "error"] },
        },
        data: { status: "connected", providerRef: "ca-live" },
      },
    ]);
  });

  it("dá um prazo de verdade ao Composio, em vez de um signal que nunca aborta", async () => {
    // `new AbortController().signal` nunca aborta: um socket pendurado no Composio prendia
    // o slot do worker para sempre, com o lease sendo renovado.
    vi.useFakeTimers();
    try {
      const seen: AbortSignal[] = [];
      const deps = {
        prisma: { connection: { updateMany: async () => ({ count: 1 }) } },
        composio: {
          complete: async (_request: unknown, context: { signal: AbortSignal }) => {
            seen.push(context.signal);
            throw new Error("still pending");
          },
          connectionReady: async (_userId: string, _slug: string, signal?: AbortSignal) => {
            if (signal) seen.push(signal);
            return false;
          },
        },
      } as unknown as Pick<RouterDeps, "prisma" | "composio">;
      await completeStoredConnection(deps, actor, pending, "secret-code");
      expect(seen).toHaveLength(2);
      for (const signal of seen) expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(COMPOSIO_REQUEST_TIMEOUT_MS);
      for (const signal of seen) expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling fail-closed until Composio reports the toolkit ready", async () => {
    const pendingHarness = completionHarness({ completeFails: true, ready: false });
    await completeStoredConnection(pendingHarness.deps, actor, pending, "secret-code");
    expect(pendingHarness.calls).toEqual(["complete:ca-pending", "ready"]);

    const readyHarness = completionHarness({ completeFails: true, ready: true });
    await completeStoredConnection(readyHarness.deps, actor, pending, "secret-code");
    expect(readyHarness.calls).toEqual(["complete:ca-pending", "ready", "update"]);
  });
});

describe("deleteAccountData", () => {
  function harness(billingEnabled: boolean) {
    const calls: string[] = [];
    const tx = {
      deploymentSettings: {
        updateMany: async () => {
          calls.push("tx:settings");
        },
      },
      organization: {
        deleteMany: async () => {
          calls.push("tx:organizations");
        },
      },
      user: {
        delete: async () => {
          calls.push("tx:user");
        },
      },
    };
    const deps = {
      prisma: {
        member: {
          findMany: async () => [{ organizationId: "ws-1" }, { organizationId: "ws-2" }],
        },
        billingAccount: {
          findMany: async () => [
            { stripeSubscriptionId: "sub-1" },
            { stripeSubscriptionId: "sub-2" },
          ],
        },
        connection: {
          findMany: async () => [
            { provider: "github" },
            { provider: "github" },
            { provider: "gmail" },
          ],
        },
        $transaction: async (fn: (client: typeof tx) => Promise<void>) => {
          calls.push("tx:start");
          await fn(tx);
        },
      },
      billing: billingEnabled
        ? {
            cancelSubscription: async (id: string) => {
              calls.push(`stripe:${id}`);
              if (id === "sub-2") throw new Error("Stripe unavailable");
            },
          }
        : undefined,
      composio: {
        revoke: async (provider: string) => {
          calls.push(`composio:${provider}`);
          if (provider === "gmail") throw new Error("Composio unavailable");
        },
      },
    } as unknown as RouterDeps;
    return { deps, calls };
  }

  it("attempts remote cleanup before one local transaction and tolerates provider failures", async () => {
    const { deps, calls } = harness(true);
    await expect(deleteAccountData(deps, actor)).resolves.toBeUndefined();
    expect(calls.slice(0, 4)).toEqual([
      "stripe:sub-1",
      "stripe:sub-2",
      "composio:github",
      "composio:gmail",
    ]);
    expect(calls.slice(4)).toEqual(["tx:start", "tx:settings", "tx:organizations", "tx:user"]);
  });

  it("skips Stripe in self-hosted mode", async () => {
    const { deps, calls } = harness(false);
    await deleteAccountData(deps, actor);
    expect(calls.some((call) => call.startsWith("stripe:"))).toBe(false);
    expect(calls).toContain("tx:user");
  });
});

describe("claimUserRun", () => {
  interface RunRow {
    id: string;
    taskId: string;
    workspaceId: string;
    clientNonce: string | null;
  }

  /** Prisma stand-in enforcing the runs unique on (workspaceId, clientNonce). */
  function fakePrisma(seed: RunRow[] = []) {
    const state = { runs: [...seed], tasks: [] as string[], next: seed.length + 1 };
    const prisma = {
      run: {
        findFirst: async ({ where }: { where: { workspaceId: string; clientNonce: string } }) =>
          state.runs.find(
            (run) => run.workspaceId === where.workspaceId && run.clientNonce === where.clientNonce,
          ) ?? null,
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tasks = [...state.tasks];
        const runs = [...state.runs];
        const tx = {
          task: {
            create: async () => {
              const id = `task-${state.next}`;
              state.tasks.push(id);
              return { id };
            },
          },
          run: {
            create: async ({ data }: { data: { taskId: string; clientNonce?: string } }) => {
              const clash = state.runs.some(
                (run) => data.clientNonce && run.clientNonce === data.clientNonce,
              );
              if (clash) {
                throw Object.assign(new Error("Unique constraint failed"), {
                  code: "P2002",
                  meta: { modelName: "Run", target: ["workspaceId", "clientNonce"] },
                });
              }
              const row: RunRow = {
                id: `run-${state.next}`,
                taskId: data.taskId,
                workspaceId: "ws-1",
                clientNonce: data.clientNonce ?? null,
              };
              state.runs.push(row);
              return row;
            },
          },
        };
        try {
          const result = await fn(tx);
          state.next += 1;
          return result;
        } catch (error) {
          // Postgres rolls the whole transaction back, task included.
          state.tasks = tasks;
          state.runs = runs;
          throw error;
        }
      },
    };
    return { prisma: prisma as unknown as PrismaClient, state };
  }

  const input = {
    workspaceId: "ws-1",
    botId: "bot-1",
    threadId: "thread-1",
    userId: "user-1",
    prompt: "oi",
    trigger: "user",
    clientNonce: "nonce-1",
  };

  it("creates the task and run together", async () => {
    const fake = fakePrisma();
    const claimed = await claimUserRun(fake.prisma, input);
    expect(claimed).toEqual({ taskId: "task-1", runId: "run-1", duplicate: false });
    expect(fake.state.tasks).toEqual(["task-1"]);
  });

  it("treats a retry inside the race window as the same run, without a duplicate task", async () => {
    const fake = fakePrisma();
    const first = await claimUserRun(fake.prisma, input);
    const retry = await claimUserRun(fake.prisma, input);
    expect(retry).toEqual({ taskId: first.taskId, runId: first.runId, duplicate: true });
    expect(fake.state.runs).toHaveLength(1);
    expect(fake.state.tasks).toEqual(["task-1"]);
  });

  it("finds the user message that belongs to a claimed run", async () => {
    const prisma = {
      message: {
        findFirst: async ({
          where,
        }: {
          where: { threadId: string; runId: string; role: string };
        }) => (where.runId === "run-1" ? { seq: 4 } : null),
      },
    } as unknown as PrismaClient;
    await expect(
      findUserMessageForRun(prisma, { threadId: "thread-1", runId: "run-1" }),
    ).resolves.toEqual({ seq: 4 });
    await expect(
      findUserMessageForRun(prisma, { threadId: "thread-1", runId: "run-missing" }),
    ).resolves.toBeNull();
  });

  it("still fails loudly on errors that are not the nonce unique", async () => {
    const fake = fakePrisma();
    const boom = {
      ...fake.prisma,
      $transaction: async () => {
        throw new Error("connection lost");
      },
    } as unknown as PrismaClient;
    await expect(claimUserRun(boom, input)).rejects.toThrow(/connection lost/);
  });
});

describe("webhookCredentialFor", () => {
  function harness(webhookPublicUrl: string | null) {
    const deps = {
      prisma: {
        deploymentSettings: {
          findUnique: async () => ({ webhookPublicUrl }),
        },
      },
      env: { apiUrl: "http://127.0.0.1:3100" },
    } as unknown as RouterDeps;
    return deps;
  }

  it("builds credentials from the saved webhookPublicUrl, normalized, ignoring env.apiUrl", async () => {
    const credential = await webhookCredentialFor(
      harness("https://tunnel.example.com/"),
      "wh_1",
      "whsec_1",
    );
    expect(credential).toEqual({
      endpointUrl: "https://tunnel.example.com/hooks/wh_1",
      secret: "whsec_1",
      url: "https://tunnel.example.com/hooks/wh_1/whsec_1",
    });
  });

  it("falls back to env.apiUrl when nothing is saved", async () => {
    const credential = await webhookCredentialFor(harness(null), "wh_2", "whsec_2");
    expect(credential).toEqual({
      endpointUrl: "http://127.0.0.1:3100/hooks/wh_2",
      secret: "whsec_2",
      url: "http://127.0.0.1:3100/hooks/wh_2/whsec_2",
    });
  });

  it("never reads a request Host: the credential only changes with the saved setting, never with unrelated request-shaped data on deps", async () => {
    const deps = harness("https://tunnel.example.com/") as unknown as RouterDeps & {
      req: { headers: { get(name: string): string } };
    };
    // A naive implementation might reach for something request-shaped sitting on `deps`;
    // planting one here (with a completely different host) proves the function never
    // looks past `deps.prisma`/`deps.env` to compute the credential.
    deps.req = { headers: { get: () => "evil-spoofed-host.example.com" } };
    const credential = await webhookCredentialFor(deps, "wh_3", "whsec_3");
    expect(credential.endpointUrl).toBe("https://tunnel.example.com/hooks/wh_3");
    expect(credential.endpointUrl).not.toContain("evil-spoofed-host");
  });
});

describe("webhookTestRunError", () => {
  function rejected(reason: string): WebhookReceiveResult {
    return {
      outcome: "rejected",
      duplicate: false,
      statusCode: 409,
      runId: null,
      taskId: null,
      reason,
    };
  }

  it("maps each known rejection reason to a distinct, coherent ORPCError", () => {
    expect(webhookTestRunError(rejected("paused"))).toMatchObject({ code: "CONFLICT" });
    expect(webhookTestRunError(rejected("rate_limited"))).toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(webhookTestRunError(rejected("too_many_runs"))).toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(webhookTestRunError(rejected("bot_missing_thread"))).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(webhookTestRunError(rejected("event_type_filtered"))).toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("falls back to a BAD_REQUEST ORPCError with a generic Portuguese message for an unrecognized or missing reason, never the raw snake_case reason", () => {
    const unknown = webhookTestRunError(rejected("something_new"));
    expect(unknown).toBeInstanceOf(ORPCError);
    expect(unknown.code).toBe("BAD_REQUEST");
    expect(unknown.message).toBe("Não foi possível executar este teste de webhook.");
    expect(unknown.message).not.toBe("something_new");
    expect(unknown.message).not.toMatch(/_/);

    const noReason = webhookTestRunError({
      outcome: "ignored",
      duplicate: false,
      statusCode: 202,
      runId: null,
      taskId: null,
    });
    expect(noReason).toBeInstanceOf(ORPCError);
    expect(noReason.code).toBe("BAD_REQUEST");
    expect(noReason.message).toBe("Não foi possível executar este teste de webhook.");
  });
});
