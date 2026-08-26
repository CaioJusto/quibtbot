import { describe, expect, it } from "vitest";
import { contextMenuPosition } from "./context-menu-position.js";

describe("contextMenuPosition", () => {
  it("anchors a long-message menu at the finger instead of the message top", () => {
    expect(
      contextMenuPosition({
        anchor: {
          x: 16,
          y: 80,
          width: 358,
          height: 1_100,
          touchX: 310,
          touchY: 460,
        },
        menuWidth: 300,
        menuHeight: 128,
        screenWidth: 390,
        screenHeight: 844,
      }),
    ).toEqual({ top: 470, left: 78 });
  });

  it("opens above a touch near the bottom and stays inside the side margin", () => {
    expect(
      contextMenuPosition({
        anchor: { x: 16, y: 700, width: 358, height: 300, touchX: 60, touchY: 760 },
        menuWidth: 300,
        menuHeight: 128,
        screenWidth: 390,
        screenHeight: 844,
      }),
    ).toEqual({ top: 622, left: 12 });
  });
});
