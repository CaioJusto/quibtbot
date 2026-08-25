import { describe, expect, it, vi } from "vitest";
import { createPointerMoveCoalescer, trackpadKeyInput, trackpadReleaseAction } from "./trackpad.js";

describe("createPointerMoveCoalescer", () => {
  it("sends one summed delta per frame", () => {
    const frames: Array<() => void> = [];
    const send = vi.fn();
    const coalescer = createPointerMoveCoalescer(
      send,
      (cb) => frames.push(cb),
      () => undefined,
    );
    coalescer.add({ x: 2, y: 1 });
    coalescer.add({ x: 3, y: -4 });
    expect(send).not.toHaveBeenCalled();
    frames[0]?.();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ x: 5, y: -3 });
  });

  it("flush sends what is pending and cancel drops it", () => {
    const send = vi.fn();
    const cancel = vi.fn();
    const coalescer = createPointerMoveCoalescer(send, () => 7, cancel);
    coalescer.add({ x: 1, y: 1 });
    coalescer.flush();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(send).toHaveBeenCalledWith({ x: 1, y: 1 });
    coalescer.add({ x: 9, y: 9 });
    coalescer.cancel();
    coalescer.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("trackpadReleaseAction", () => {
  it("is a click only when the pointer barely moved", () => {
    expect(trackpadReleaseAction(0)).toBe("click");
    expect(trackpadReleaseAction(8)).toBe("click");
    expect(trackpadReleaseAction(9)).toBeNull();
  });
});

describe("trackpadKeyInput", () => {
  const press = (key: string, mods: Partial<Parameters<typeof trackpadKeyInput>[0]> = {}) =>
    trackpadKeyInput({
      key,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...mods,
    });

  it("types printable characters as text, accents included", () => {
    expect(press("a")).toEqual({ kind: "clipboard", text: "a" });
    expect(press("ç")).toEqual({ kind: "clipboard", text: "ç" });
    expect(press("!", { shiftKey: true })).toEqual({ kind: "clipboard", text: "!" });
    expect(press(" ")).toEqual({ kind: "clipboard", text: " " });
  });

  it("sends shortcuts as the base key plus modifiers", () => {
    expect(press("c", { ctrlKey: true })).toEqual({
      kind: "key",
      key: "c",
      modifiers: ["ctrl"],
    });
    expect(press("T", { ctrlKey: true, shiftKey: true })).toEqual({
      kind: "key",
      key: "t",
      modifiers: ["ctrl", "shift"],
    });
    expect(press(" ", { altKey: true })).toEqual({ kind: "key", key: "space", modifiers: ["alt"] });
  });

  it("maps named keys to what xdotool calls them", () => {
    expect(press("Enter")).toEqual({ kind: "key", key: "Return", modifiers: [] });
    expect(press("Backspace")).toEqual({ kind: "key", key: "BackSpace", modifiers: [] });
    expect(press("ArrowLeft", { shiftKey: true })).toEqual({
      kind: "key",
      key: "Left",
      modifiers: ["shift"],
    });
    expect(press("PageDown")).toEqual({ kind: "key", key: "Page_Down", modifiers: [] });
    expect(press("F5")).toEqual({ kind: "key", key: "F5", modifiers: [] });
  });

  it("ignores lone modifiers and keys it cannot name", () => {
    expect(press("Shift")).toBeNull();
    expect(press("Meta")).toBeNull();
    expect(press("Dead")).toBeNull();
    expect(press("CapsLock")).toBeNull();
  });
});
