import { describe, expect, it } from "vitest";
import { boxScreenStartCommand, boxSessionPorts, parseHostedScreenUrl } from "./box-screens.js";

describe("box screens", () => {
  it("maps each bot display to its own VNC ports", () => {
    expect(boxSessionPorts(1)).toEqual({ display: 1, vnc: 5900, novnc: 6080 });
    expect(boxSessionPorts(2)).toEqual({ display: 2, vnc: 5901, novnc: 6081 });
  });

  it("parses the private host URL from Box stdout", () => {
    expect(parseHostedScreenUrl("https://box-6081.on.ascii.dev?_token=abc\n")).toBe(
      "https://box-6081.on.ascii.dev?_token=abc",
    );
    expect(
      parseHostedScreenUrl('{"url":"https://ws-6080.on.ascii.dev?_token=x","port":6080}'),
    ).toBe("https://ws-6080.on.ascii.dev?_token=x");
    expect(parseHostedScreenUrl("nothing")).toBeNull();
  });

  it("starts a dedicated X session per bot", () => {
    const script = boxScreenStartCommand("Scout", 2);
    expect(script).toContain("DISPLAY_NUM=2");
    expect(script).toContain("NOVNC_PORT=6081");
    expect(script).toContain("Xvfb");
    expect(script).toContain("host url");
  });
});
