import { describe, expect, it } from "vitest";
import {
  type CronPreset,
  cronFromNaturalLanguage,
  cronFromPreset,
  describeCronPreset,
  formatCron,
  nextCronDate,
  presetFromCron,
} from "./cron.js";

function preset(partial: Partial<CronPreset> & Pick<CronPreset, "freq">): CronPreset {
  return {
    n: 3,
    unit: "minutes",
    time: "9:00 AM",
    cron: "",
    ...partial,
  };
}

describe("cronFromPreset", () => {
  it("maps everyday language onto cron", () => {
    expect(cronFromPreset(preset({ freq: "Every day", time: "9:00 AM" }))).toBe("0 9 * * *");
    expect(cronFromPreset(preset({ freq: "Weekdays", time: "8:00 AM" }))).toBe("0 8 * * 1-5");
    expect(cronFromPreset(preset({ freq: "Every week", time: "9:00 AM" }))).toBe("0 9 * * 1");
    expect(cronFromPreset(preset({ freq: "Every month", time: "12:00 PM" }))).toBe("0 12 1 * *");
    expect(cronFromPreset(preset({ freq: "Every hour" }))).toBe("0 * * * *");
    expect(cronFromPreset(preset({ freq: "Every day", time: "12:00 AM" }))).toBe("0 0 * * *");
    expect(cronFromPreset(preset({ freq: "Every day", time: "3:00 PM" }))).toBe("0 15 * * *");
  });

  it("maps intervals including days", () => {
    expect(cronFromPreset(preset({ freq: "Interval", n: 15, unit: "minutes" }))).toBe(
      "*/15 * * * *",
    );
    expect(cronFromPreset(preset({ freq: "Interval", n: 2, unit: "hours" }))).toBe("0 */2 * * *");
    expect(cronFromPreset(preset({ freq: "Interval", n: 3, unit: "days" }))).toBe("0 0 */3 * *");
  });

  it("keeps advanced expressions", () => {
    expect(cronFromPreset(preset({ freq: "Advanced", cron: "0 10 15 * *" }))).toBe("0 10 15 * *");
    expect(cronFromPreset(preset({ freq: "Advanced", cron: "" }))).toBe("*/3 * * * *");
  });
});

describe("presetFromCron", () => {
  it("reads the previous Monday-morning default as weekly", () => {
    expect(presetFromCron("0 9 * * 1")).toMatchObject({
      freq: "Every week",
      time: "9:00 AM",
    });
  });

  it("round-trips the named presets", () => {
    const cases: CronPreset[] = [
      preset({ freq: "Every hour" }),
      preset({ freq: "Every day", time: "6:00 PM" }),
      preset({ freq: "Weekdays", time: "7:00 AM" }),
      preset({ freq: "Every week", time: "9:00 AM" }),
      preset({ freq: "Every month", time: "12:00 PM" }),
      preset({ freq: "Interval", n: 10, unit: "minutes" }),
      preset({ freq: "Interval", n: 5, unit: "hours" }),
      preset({ freq: "Interval", n: 2, unit: "days" }),
      preset({ freq: "Advanced", cron: "0 10 15 * *" }),
    ];
    for (const input of cases) {
      const cron = cronFromPreset(input);
      const parsed = presetFromCron(cron);
      expect(parsed.freq).toBe(input.freq);
      if (input.freq === "Interval") {
        expect(parsed.n).toBe(input.n);
        expect(parsed.unit).toBe(input.unit);
      }
      if (["Every day", "Weekdays", "Every week", "Every month"].includes(input.freq)) {
        expect(parsed.time).toBe(input.time);
      }
      if (input.freq === "Advanced") {
        expect(parsed.cron).toBe(input.cron);
      }
    }
  });

  it("falls back to advanced for expressions the picker cannot represent", () => {
    expect(presetFromCron("0 9 * * 0")).toMatchObject({ freq: "Advanced", cron: "0 9 * * 0" });
    expect(presetFromCron("30 14 15 * *")).toMatchObject({
      freq: "Advanced",
      cron: "30 14 15 * *",
    });
  });
});

describe("formatCron", () => {
  it("shows a human schedule instead of the expression", () => {
    expect(formatCron("0 9 * * 1")).toBe("Toda segunda às 9:00 AM");
    expect(formatCron("0 8 * * 1-5")).toBe("Dias úteis às 8:00 AM");
    expect(formatCron("*/15 * * * *")).toBe("A cada 15 minutos");
    expect(describeCronPreset(preset({ freq: "Every hour" }))).toEqual({
      lead: "Toda hora",
      detail: "",
    });
  });
});

describe("cronFromNaturalLanguage", () => {
  it("reads everyday Portuguese and English cadences", () => {
    expect(cronFromNaturalLanguage("todo dia às 9")).toMatchObject({
      freq: "Every day",
      time: "9:00 AM",
    });
    expect(cronFromNaturalLanguage("every weekday at 8am")).toMatchObject({
      freq: "Weekdays",
      time: "8:00 AM",
    });
    expect(cronFromNaturalLanguage("toda segunda às 9h")).toMatchObject({
      freq: "Every week",
      time: "9:00 AM",
    });
    expect(cronFromNaturalLanguage("todo mês às 12:00")).toMatchObject({
      freq: "Every month",
      time: "12:00 PM",
    });
    expect(cronFromNaturalLanguage("toda hora")).toMatchObject({ freq: "Every hour" });
    expect(cronFromNaturalLanguage("a cada 15 minutos")).toMatchObject({
      freq: "Interval",
      n: 15,
      unit: "minutes",
    });
    expect(cronFromNaturalLanguage("every 2 hours")).toMatchObject({
      freq: "Interval",
      n: 2,
      unit: "hours",
    });
  });

  it("returns null when there is no schedule", () => {
    expect(cronFromNaturalLanguage("revisar a caixa de entrada")).toBeNull();
    expect(cronFromNaturalLanguage("")).toBeNull();
  });
});

describe("nextCronDate", () => {
  it("matches minute/hour in UTC like before", () => {
    // Wed 2026-08-12 10:30Z -> 11:00Z
    expect(nextCronDate("0 * * * *", new Date("2026-08-12T10:30:00Z"))).toEqual(
      new Date("2026-08-12T11:00:00Z"),
    );
    expect(nextCronDate("0 9 * * *", new Date("2026-08-12T10:30:00Z"), "UTC")).toEqual(
      new Date("2026-08-13T09:00:00Z"),
    );
  });

  it("returns strictly after `from`, even when `from` matches", () => {
    expect(nextCronDate("*/15 * * * *", new Date("2026-08-12T10:15:00Z"))).toEqual(
      new Date("2026-08-12T10:30:00Z"),
    );
    expect(nextCronDate("*/15 * * * *", new Date("2026-08-12T10:52:10Z"))).toEqual(
      new Date("2026-08-12T11:00:00Z"),
    );
  });

  it("skips the weekend for the weekdays preset", () => {
    // Fri 2026-08-14 10:00Z -> Mon 2026-08-17 09:00Z
    expect(nextCronDate("0 9 * * 1-5", new Date("2026-08-14T10:00:00Z"))).toEqual(
      new Date("2026-08-17T09:00:00Z"),
    );
    // Weekly on Monday
    expect(nextCronDate("0 9 * * 1", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2026-08-17T09:00:00Z"),
    );
  });

  it("runs monthly on day 1", () => {
    expect(nextCronDate("0 12 1 * *", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2026-09-01T12:00:00Z"),
    );
    // Interval days: every 3rd day of month (1, 4, 7, ...)
    expect(nextCronDate("0 0 */3 * *", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2026-08-13T00:00:00Z"),
    );
  });

  it("evaluates in the routine timezone", () => {
    // 09:00 America/Sao_Paulo (UTC-3, no DST) is 12:00Z
    expect(
      nextCronDate("0 9 * * *", new Date("2026-08-12T10:00:00Z"), "America/Sao_Paulo"),
    ).toEqual(new Date("2026-08-12T12:00:00Z"));
    // Weekday check uses local date: Fri 2026-08-14 23:30 Sao Paulo = Sat 02:30Z
    expect(
      nextCronDate("0 9 * * 1-5", new Date("2026-08-15T02:30:00Z"), "America/Sao_Paulo"),
    ).toEqual(new Date("2026-08-17T12:00:00Z"));
    // Europe/Berlin summer time is UTC+2
    expect(nextCronDate("30 8 * * *", new Date("2026-08-12T10:00:00Z"), "Europe/Berlin")).toEqual(
      new Date("2026-08-13T06:30:00Z"),
    );
  });

  it("supports lists, ranges, steps and dom/dow OR semantics", () => {
    expect(nextCronDate("0 9,17 * * *", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2026-08-12T17:00:00Z"),
    );
    expect(nextCronDate("0 9 * 1-3 *", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2027-01-01T09:00:00Z"),
    );
    // Wed 2026-08-12: dom 15 (Sat) OR Sunday -> whichever comes first
    expect(nextCronDate("0 9 15 * 0", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2026-08-15T09:00:00Z"),
    );
    expect(nextCronDate("0 9 20 * 0", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2026-08-16T09:00:00Z"),
    );
    // 7 is Sunday too
    expect(nextCronDate("0 9 * * 7", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2026-08-16T09:00:00Z"),
    );
    expect(nextCronDate("0 9 * * SUN", new Date("2026-08-12T10:00:00Z"))).toEqual(
      new Date("2026-08-16T09:00:00Z"),
    );
  });

  it("falls back to one minute later for invalid expressions", () => {
    const from = new Date("2026-08-12T10:00:30Z");
    expect(nextCronDate("nope", from)).toEqual(new Date(from.getTime() + 60_000));
    expect(nextCronDate("* * *", from)).toEqual(new Date(from.getTime() + 60_000));
    expect(nextCronDate("99 * * * *", from)).toEqual(new Date(from.getTime() + 60_000));
    // Feb 30 never happens
    expect(nextCronDate("0 0 30 2 *", from)).toEqual(new Date(from.getTime() + 60_000));
  });
});
