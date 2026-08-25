import { describe, expect, it } from "vitest";
import { appendDictatedText, speechRecognitionCtor } from "./dictation";

describe("appendDictatedText", () => {
  it("uses the first chunk as the whole draft", () => {
    expect(appendDictatedText("", "ship Friday")).toBe("ship Friday");
    expect(appendDictatedText("   ", "  ship Friday  ")).toBe("ship Friday");
  });

  it("inserts a space between existing text and a new chunk", () => {
    expect(appendDictatedText("remember that", "shipping is Friday")).toBe(
      "remember that shipping is Friday",
    );
  });

  it("does not double the space when the draft already ends with one", () => {
    expect(appendDictatedText("remember that ", "shipping is Friday")).toBe(
      "remember that shipping is Friday",
    );
  });

  it("ignores empty recognition results", () => {
    expect(appendDictatedText("keep me", "   ")).toBe("keep me");
  });
});

describe("speechRecognitionCtor", () => {
  it("is absent in the node test environment", () => {
    expect(speechRecognitionCtor()).toBeNull();
  });
});
