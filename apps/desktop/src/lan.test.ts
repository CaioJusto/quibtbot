import { describe, expect, it } from "vitest";
import { firstLanIPv4 } from "./lan.js";

describe("firstLanIPv4", () => {
  it("skips ordinary LAN addresses that would carry sessions over cleartext", () => {
    expect(
      firstLanIPv4({
        lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
        en0: [
          { family: "IPv4", address: "169.254.1.1", internal: false },
          { family: "IPv4", address: "192.168.1.20", internal: false },
        ],
      }),
    ).toBeNull();
  });

  it("returns null when there is no LAN", () => {
    expect(
      firstLanIPv4({
        lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      }),
    ).toBeNull();
  });
});

describe("firstLanIPv4 address preference", () => {
  it("prefers the tailnet address, the one that survives leaving home", () => {
    expect(
      firstLanIPv4({
        en0: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
        utun3: [{ family: "IPv4", address: "100.101.102.103", internal: false }],
      }),
    ).toBe("100.101.102.103");
  });

  it("returns null when there is no encrypted tailnet", () => {
    expect(
      firstLanIPv4({
        en0: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
      }),
    ).toBeNull();
  });

  it("never hands out the docker bridge, which no phone can reach", () => {
    expect(
      firstLanIPv4({
        docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
        en0: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
      }),
    ).toBeNull();
  });
});
