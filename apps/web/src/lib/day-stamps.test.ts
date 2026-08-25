import { describe, expect, it } from "vitest";
import { dayStampLabel, dayStamps, inboxTimeLabel } from "./day-stamps";

// Local-time fixtures so the suite is deterministic in any timezone.
const now = new Date(2026, 7, 13, 18, 0); // Thu Aug 13 2026, 18:00 local
const iso = (...args: [number, number, number, number, number]) => new Date(...args).toISOString();

describe("dayStampLabel", () => {
  it("labels a same-day message as Today with 24h time", () => {
    expect(dayStampLabel(iso(2026, 7, 13, 14, 45), now)).toBe("Hoje 14:45");
  });

  it("labels the previous day as Yesterday", () => {
    expect(dayStampLabel(iso(2026, 7, 12, 10, 35), now)).toBe("Ontem 10:35");
  });

  it("labels older days with weekday and date", () => {
    // Aug 10 2026 is a Monday.
    expect(dayStampLabel(iso(2026, 7, 10, 9, 15), now)).toBe("Seg 10 09:15");
  });

  it("returns null for an invalid date", () => {
    expect(dayStampLabel("not-a-date", now)).toBeNull();
  });
});

describe("inboxTimeLabel", () => {
  it("shows 24h time for today", () => {
    expect(inboxTimeLabel(iso(2026, 7, 13, 14, 45), now)).toBe("14:45");
  });

  it("shows Yesterday for the previous day", () => {
    expect(inboxTimeLabel(iso(2026, 7, 12, 10, 35), now)).toBe("Ontem");
  });

  it("shows a short date for older days", () => {
    expect(inboxTimeLabel(iso(2026, 7, 10, 9, 15), now)).toBe("ago 10");
  });
});

describe("dayStamps", () => {
  it("stamps before the first message and on every day change", () => {
    const stamps = dayStamps(
      [
        { id: "m1", createdAt: iso(2026, 7, 10, 9, 15) },
        { id: "m2", createdAt: iso(2026, 7, 12, 10, 35) },
        { id: "m3", createdAt: iso(2026, 7, 13, 14, 45) },
      ],
      now,
    );
    expect(stamps).toEqual({
      m1: "Seg 10 09:15",
      m2: "Ontem 10:35",
      m3: "Hoje 14:45",
    });
  });

  it("does not stamp between messages on the same day", () => {
    const stamps = dayStamps(
      [
        { id: "m1", createdAt: iso(2026, 7, 13, 9, 0) },
        { id: "m2", createdAt: iso(2026, 7, 13, 9, 5) },
        { id: "m3", createdAt: iso(2026, 7, 13, 17, 30) },
      ],
      now,
    );
    expect(stamps).toEqual({ m1: "Hoje 09:00" });
  });

  it("skips messages without a valid createdAt", () => {
    const stamps = dayStamps(
      [
        { id: "m1" },
        { id: "m2", createdAt: "garbage" },
        { id: "m3", createdAt: iso(2026, 7, 13, 8, 0) },
      ],
      now,
    );
    expect(stamps).toEqual({ m3: "Hoje 08:00" });
  });
});
