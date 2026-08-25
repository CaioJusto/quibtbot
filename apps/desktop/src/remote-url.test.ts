import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRemoteUrl,
  isLoopbackHost,
  isPrivateLanHost,
  loadRemoteUrl,
  normalizeAppUrl,
  remoteUrlFile,
  saveRemoteUrl,
} from "./remote-url.js";

describe("remote url policy", () => {
  it("allows public https and loopback http", () => {
    expect(normalizeAppUrl("https://app.example.com")).toEqual({
      ok: true,
      url: "https://app.example.com",
    });
    expect(normalizeAppUrl("http://127.0.0.1:5173")).toEqual({
      ok: true,
      url: "http://127.0.0.1:5173",
    });
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isPrivateLanHost("192.168.1.50")).toBe(true);
  });

  it("rejects http on public hosts, credentials, and unsafe protocols", () => {
    expect(normalizeAppUrl("http://app.example.com").ok).toBe(false);
    expect(normalizeAppUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeAppUrl("file:///etc/passwd").ok).toBe(false);
    expect(normalizeAppUrl("https://user:pass@example.com").ok).toBe(false);
  });

  it("persists and reloads remote url from userData", () => {
    const userData = mkdtempSync(path.join(tmpdir(), "quibt-remote-"));
    const savedAt = "2026-08-17T00:00:00.000Z";
    saveRemoteUrl(userData, "https://remote.example.com", savedAt);
    expect(remoteUrlFile(userData)).toContain("remote-url.json");
    expect(loadRemoteUrl(userData)).toBe("https://remote.example.com");
  });

  it("removes persisted remote url on clear", () => {
    const userData = mkdtempSync(path.join(tmpdir(), "quibt-remote-clear-"));
    saveRemoteUrl(userData, "https://remote.example.com", "2026-08-17T00:00:00.000Z");
    expect(existsSync(remoteUrlFile(userData))).toBe(true);
    clearRemoteUrl(userData);
    expect(existsSync(remoteUrlFile(userData))).toBe(false);
    expect(loadRemoteUrl(userData)).toBeNull();
  });
});
