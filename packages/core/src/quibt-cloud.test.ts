import { describe, expect, it } from "vitest";
import {
  formatQuibtCloudHours,
  isQuibtCloudPlaceholderUrl,
  QUIBT_CLOUD_API_URL_PLACEHOLDER,
  type QuibtCloudMe,
  quibtCloudCanResume,
  quibtCloudUpgradeMessage,
  quibtCloudUsage,
  resolveQuibtCloudApiUrl,
  screenUrlFromQuibtCloudConnection,
} from "./quibt-cloud.js";

function me(overrides: Partial<QuibtCloudMe> = {}): QuibtCloudMe {
  return {
    email: "ada@example.com",
    plan: { id: "starter", name: "Starter" },
    hoursUsed: 2,
    hoursQuota: 10,
    concurrentComputers: 0,
    concurrentLimit: 1,
    ...overrides,
  };
}

describe("resolveQuibtCloudApiUrl", () => {
  it("prefers the override, then the env, then the marked placeholder", () => {
    expect(resolveQuibtCloudApiUrl({ override: "https://cloud.example/api/" })).toBe(
      "https://cloud.example/api",
    );
    expect(resolveQuibtCloudApiUrl({ envUrl: " https://from.env " })).toBe("https://from.env");
    expect(resolveQuibtCloudApiUrl({})).toBe(QUIBT_CLOUD_API_URL_PLACEHOLDER);
    expect(isQuibtCloudPlaceholderUrl(QUIBT_CLOUD_API_URL_PLACEHOLDER)).toBe(true);
    expect(isQuibtCloudPlaceholderUrl("https://other.example")).toBe(false);
  });
});

describe("quibtCloudUsage", () => {
  it("reflects hours used against the plan cap", () => {
    const usage = quibtCloudUsage(me({ hoursUsed: 4, hoursQuota: 10 }));
    expect(usage.hoursRatio).toBe(0.4);
    expect(usage.hoursExhausted).toBe(false);
    expect(usage.blocked).toBe(false);
    expect(usage.limit).toBeNull();
    expect(formatQuibtCloudHours(me({ hoursUsed: 4, hoursQuota: 10 }))).toBe(
      "4 / 10 h neste ciclo",
    );
  });

  it("marks the hour cap as exhausted without locking other app state", () => {
    const usage = quibtCloudUsage(me({ hoursUsed: 10, hoursQuota: 10 }));
    expect(usage.hoursExhausted).toBe(true);
    expect(usage.blocked).toBe(true);
    expect(usage.limit?.kind).toBe("hours");
    expect(usage.limit?.upgradeMessage).toBe(quibtCloudUpgradeMessage("hours"));
    expect(usage.limit?.upgradeMessage).toMatch(/app segue funcionando/);
  });

  it("marks the concurrent computer cap", () => {
    const usage = quibtCloudUsage(me({ concurrentComputers: 2, concurrentLimit: 2 }));
    expect(usage.concurrentAtLimit).toBe(true);
    expect(usage.blocked).toBe(true);
    expect(usage.limit?.kind).toBe("concurrent");
  });

  it("prefers the hours cap when both limits are hit", () => {
    const usage = quibtCloudUsage(
      me({ hoursUsed: 20, hoursQuota: 10, concurrentComputers: 3, concurrentLimit: 1 }),
    );
    expect(usage.limit?.kind).toBe("hours");
  });
});

describe("quibtCloudCanResume", () => {
  it("allows a resume under the plan", () => {
    expect(quibtCloudCanResume(me()).ok).toBe(true);
  });

  it("blocks a new start when hours are exhausted", () => {
    const decision = quibtCloudCanResume(me({ hoursUsed: 12, hoursQuota: 10 }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.limit.kind).toBe("hours");
      expect(decision.limit.upgradeMessage).toMatch(/upgrade/);
    }
  });

  it("blocks a new start when the concurrent cap is full", () => {
    const decision = quibtCloudCanResume(me({ concurrentComputers: 1, concurrentLimit: 1 }), {
      status: "stopped",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.limit.kind).toBe("concurrent");
  });

  it("still allows reconnecting a box that is already running at the concurrent cap", () => {
    expect(
      quibtCloudCanResume(me({ concurrentComputers: 1, concurrentLimit: 1 }), {
        status: "running",
      }).ok,
    ).toBe(true);
  });

  it("does not reconnect when hours are gone, even if the box is running", () => {
    const decision = quibtCloudCanResume(me({ hoursUsed: 10, hoursQuota: 10 }), {
      status: "running",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.limit.kind).toBe("hours");
  });
});

describe("screenUrlFromQuibtCloudConnection", () => {
  it("prefers a ready screen URL from the Cloud API", () => {
    expect(
      screenUrlFromQuibtCloudConnection({
        host: "box.example",
        port: 6080,
        screenUrl: "https://box.example/novnc/embed.html?token=tmp",
      }),
    ).toBe("https://box.example/novnc/embed.html?token=tmp");
  });

  it("builds a noVNC URL from host, port and the temporary credential", () => {
    const url = screenUrlFromQuibtCloudConnection({
      host: "10.0.0.8",
      port: 6080,
      credential: "tmp-pass",
      protocol: "novnc",
    });
    expect(url).toContain("http://10.0.0.8:6080/vnc.html");
    expect(url).toContain("autoconnect=1");
    expect(url).toContain("password=tmp-pass");
  });

  it("does not invent a screen URL for an SSH-only connection", () => {
    expect(
      screenUrlFromQuibtCloudConnection({
        host: "vps.example",
        port: 22,
        protocol: "ssh",
        username: "quibt",
        credential: "tmp",
      }),
    ).toBeNull();
  });
});
