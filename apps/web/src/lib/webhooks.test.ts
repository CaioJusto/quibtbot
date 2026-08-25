import { describe, expect, it } from "vitest";
import {
  buildWebhookCredential,
  formatWebhookEventsInput,
  normalizeWebhookPublicUrl,
  parseWebhookEventsInput,
  shellQuote,
  WebhookUrlError,
  webhookActiveLabel,
  webhookCurl,
  webhookOutcomeLabel,
  webhookPublicEndpoint,
} from "./webhooks";

describe("webhookPublicEndpoint", () => {
  it("joins a configured public URL with the endpoint id and never embeds a secret", () => {
    expect(webhookPublicEndpoint("https://tunnel.example.com/", "wh_1")).toBe(
      "https://tunnel.example.com/hooks/wh_1",
    );
    expect(webhookPublicEndpoint(null, "wh_1")).toBe("/hooks/wh_1");
  });
});

describe("buildWebhookCredential", () => {
  it("strips a trailing slash and builds both URLs", () => {
    expect(buildWebhookCredential("https://bot.example.com/", "wh_1", "whsec_1")).toEqual({
      endpointUrl: "https://bot.example.com/hooks/wh_1",
      secret: "whsec_1",
      url: "https://bot.example.com/hooks/wh_1/whsec_1",
    });
  });

  it("works the same without a trailing slash", () => {
    expect(buildWebhookCredential("https://bot.example.com", "wh_1", "whsec_1")).toEqual({
      endpointUrl: "https://bot.example.com/hooks/wh_1",
      secret: "whsec_1",
      url: "https://bot.example.com/hooks/wh_1/whsec_1",
    });
  });
});

describe("normalizeWebhookPublicUrl", () => {
  it("throws for a non-http(s) protocol", () => {
    expect(() => normalizeWebhookPublicUrl("javascript:alert(1)")).toThrow(WebhookUrlError);
  });

  it("throws for something that is not a URL at all", () => {
    expect(() => normalizeWebhookPublicUrl("not a url")).toThrow(WebhookUrlError);
  });

  it("accepts https and strips a trailing slash", () => {
    expect(normalizeWebhookPublicUrl("https://bot.example.com/")).toBe("https://bot.example.com");
  });

  it("accepts plain http", () => {
    expect(normalizeWebhookPublicUrl("http://192.168.1.20:8787")).toBe("http://192.168.1.20:8787");
  });

  it("rejects embedded credentials", () => {
    expect(() => normalizeWebhookPublicUrl("https://user:pass@bot.example.com")).toThrow(
      WebhookUrlError,
    );
  });

  it("rejects a query string", () => {
    expect(() => normalizeWebhookPublicUrl("https://bot.example.com/?x=1")).toThrow(
      WebhookUrlError,
    );
  });

  it("rejects a fragment", () => {
    expect(() => normalizeWebhookPublicUrl("https://bot.example.com/#x")).toThrow(WebhookUrlError);
  });
});

describe("shellQuote", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("whsec_1")).toBe("'whsec_1'");
  });

  it("safely escapes an embedded single quote", () => {
    // A shell would concatenate 'whsec_' + '\'' + '_evil' back into whsec_'_evil —
    // i.e. this must never let the value break out of its own quoting.
    expect(shellQuote("whsec_'_evil")).toBe("'whsec_'\\''_evil'");
  });
});

describe("webhookCurl", () => {
  it("builds a copy-pasteable curl using the Bearer scheme", () => {
    const command = webhookCurl({
      endpointUrl: "https://bot.example.com/hooks/wh_1",
      secret: "whsec_1",
      url: "https://bot.example.com/hooks/wh_1/whsec_1",
    });
    expect(command).toBe(
      "curl -X POST 'https://bot.example.com/hooks/wh_1' -H 'Authorization: Bearer whsec_1' -H 'Content-Type: application/json' -d '{}'",
    );
  });

  it("keeps a secret containing a single quote from breaking out of its quoting", () => {
    const command = webhookCurl({
      endpointUrl: "https://bot.example.com/hooks/wh_1",
      secret: "wh'sec",
      url: "https://bot.example.com/hooks/wh_1/wh'sec",
    });
    expect(command).toContain("'Authorization: Bearer wh'\\''sec'");
  });
});

describe("parseWebhookEventsInput", () => {
  it("trims, drops blanks, and dedupes", () => {
    expect(parseWebhookEventsInput(" push, , push, pull_request ,")).toEqual([
      "push",
      "pull_request",
    ]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseWebhookEventsInput("   ")).toEqual([]);
  });

  it("caps at 20 events", () => {
    const many = Array.from({ length: 25 }, (_, i) => `event-${i}`).join(",");
    expect(parseWebhookEventsInput(many)).toHaveLength(20);
  });

  it("clamps an oversized single entry to 200 chars", () => {
    const huge = "x".repeat(500);
    expect(parseWebhookEventsInput(huge)[0]).toHaveLength(200);
  });
});

describe("formatWebhookEventsInput", () => {
  it("joins events with a comma and space", () => {
    expect(formatWebhookEventsInput(["push", "pull_request"])).toBe("push, pull_request");
  });

  it("round-trips through parseWebhookEventsInput", () => {
    const events = ["push", "pull_request"];
    expect(parseWebhookEventsInput(formatWebhookEventsInput(events))).toEqual(events);
  });
});

describe("webhookOutcomeLabel", () => {
  it("labels every outcome in Portuguese", () => {
    expect(webhookOutcomeLabel("accepted")).toBe("Aceito");
    expect(webhookOutcomeLabel("duplicate")).toBe("Duplicado");
    expect(webhookOutcomeLabel("ignored")).toBe("Ignorado");
    expect(webhookOutcomeLabel("rejected")).toBe("Rejeitado");
  });
});

describe("webhookActiveLabel", () => {
  it("labels active and paused", () => {
    expect(webhookActiveLabel(true)).toBe("Ativo");
    expect(webhookActiveLabel(false)).toBe("Pausado");
  });
});
