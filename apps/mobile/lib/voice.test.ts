import { describe, expect, it } from "vitest";
import {
  dictatedDraft,
  initialVoiceState,
  permissionDeniedMessage,
  permissionEventFromResponse,
  recognitionErrorMessage,
  voiceReducer,
  voiceStatusMessage,
} from "./voice";

describe("ditado (voiceReducer)", () => {
  it("starts idle", () => {
    expect(initialVoiceState).toEqual({ phase: "idle" });
  });

  it("asks for the mic, then listens or explains the denial", () => {
    const asking = voiceReducer(initialVoiceState, { type: "mic-press" });
    expect(asking.phase).toBe("requesting-permission");
    expect(voiceReducer(asking, { type: "permission-result", granted: true }).phase).toBe(
      "listening",
    );
    const denied = voiceReducer(asking, { type: "permission-result", granted: false });
    expect(denied.phase).toBe("permission-denied");
    expect(voiceStatusMessage(denied)).toBe(permissionDeniedMessage());
  });

  it("goes back to idle when the person stops, and shows the error when it fails", () => {
    const listening = voiceReducer(initialVoiceState, {
      type: "permission-result",
      granted: true,
    });
    expect(voiceStatusMessage(listening)).toMatch(/Ouvindo/);
    expect(voiceReducer(listening, { type: "listening-stopped" })).toEqual({ phase: "idle" });
    const failed = voiceReducer(listening, { type: "error", message: "x" });
    expect(failed.phase).toBe("error");
    expect(voiceStatusMessage(failed)).toBe("x");
    expect(voiceReducer(failed, { type: "reset" })).toEqual(initialVoiceState);
    expect(voiceStatusMessage(initialVoiceState)).toBeNull();
  });

  it("builds the granted/denied event from a native PermissionResponse", () => {
    expect(permissionEventFromResponse({ granted: true })).toEqual({
      type: "permission-result",
      granted: true,
    });
  });
});

describe("dictatedDraft", () => {
  it("keeps what was typed and appends what was said, with one space between", () => {
    expect(dictatedDraft("", "abre o g1")).toBe("abre o g1");
    expect(dictatedDraft("Oi, ", "abre o g1")).toBe("Oi, abre o g1");
    expect(dictatedDraft("Oi", "  ")).toBe("Oi");
    expect(dictatedDraft("Oi", " manda print ")).toBe("Oi manda print");
  });
});

describe("recognitionErrorMessage", () => {
  it("turns the recognizer's codes into plain Portuguese", () => {
    expect(recognitionErrorMessage("not-allowed")).toBe(permissionDeniedMessage());
    expect(recognitionErrorMessage("language-not-supported")).toMatch(/português/);
    expect(recognitionErrorMessage("no-speech")).toMatch(/Não ouvi/);
    expect(recognitionErrorMessage(undefined)).toMatch(/Tente de novo/);
  });
});
