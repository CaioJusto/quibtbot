import { describe, expect, it } from "vitest";
import { firstDeepLinkFromArgv, webUrlFromDeepLink } from "./deep-link.js";

describe("webUrlFromDeepLink", () => {
  it("maps quibt://billing back onto the web origin", () => {
    expect(webUrlFromDeepLink("quibt://billing?billing=success", "https://app.example.com")).toBe(
      "https://app.example.com/billing?billing=success",
    );
  });

  it("maps reset-password with the token query", () => {
    expect(webUrlFromDeepLink("quibt://reset-password?token=abc", "https://app.example.com")).toBe(
      "https://app.example.com/reset-password?token=abc",
    );
  });

  it("keeps the whole route when the deep link carries a path", () => {
    expect(webUrlFromDeepLink("quibt://thread/thr_123?focus=1", "https://app.example.com")).toBe(
      "https://app.example.com/thread/thr_123?focus=1",
    );
    expect(webUrlFromDeepLink("quibt://bots/bot_1#tab", "https://app.example.com/")).toBe(
      "https://app.example.com/bots/bot_1#tab",
    );
  });

  it("opens the app root for a bare link and never walks out of the web origin", () => {
    expect(webUrlFromDeepLink("quibt://", "https://app.example.com")).toBe(
      "https://app.example.com",
    );
    expect(webUrlFromDeepLink("quibt://../../etc/passwd", "https://app.example.com")).toBe(
      "https://app.example.com/etc/passwd",
    );
  });

  it("rejects other schemes", () => {
    expect(
      webUrlFromDeepLink("https://evil.example/billing", "https://app.example.com"),
    ).toBeNull();
  });
});

describe("firstDeepLinkFromArgv", () => {
  it("picks the first quibt:// argument on a cold Windows/Linux launch", () => {
    expect(
      firstDeepLinkFromArgv(["electron.exe", "quibt://billing?billing=success", "--foo"]),
    ).toBe("quibt://billing?billing=success");
    expect(firstDeepLinkFromArgv(["electron.exe", "--foo"])).toBeNull();
  });
});
