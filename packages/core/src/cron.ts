const WEEKDAYS = "1-5";

export const CRON_FREQS = [
  "Every hour",
  "Every day",
  "Weekdays",
  "Every week",
  "Every month",
  "Interval",
  "Advanced",
] as const;

export type CronFreq = (typeof CRON_FREQS)[number];
export type CronUnit = "minutes" | "hours" | "days";

export type CronPreset = {
  freq: CronFreq;
  n: number;
  unit: CronUnit;
  time: string;
  cron: string;
};

export function defaultCronPreset(): CronPreset {
  return { freq: "Every day", n: 3, unit: "minutes", time: "9:00 AM", cron: "" };
}

export function cronFromPreset(input: {
  freq: string;
  n?: number;
  unit?: string;
  time?: string;
  cron?: string;
}): string {
  if (input.freq === "Advanced") return input.cron?.trim() || "*/3 * * * *";
  if (input.freq === "Every hour") return "0 * * * *";
  if (input.freq === "Interval") {
    const n = Number.isFinite(input.n) && (input.n ?? 0) > 0 ? (input.n as number) : 5;
    if (input.unit === "days") return `0 0 */${n} * *`;
    if (input.unit === "hours") return `0 */${n} * * *`;
    return `*/${n} * * * *`;
  }
  const { hour, minute } = parseClock(input.time ?? "9:00 AM");
  if (input.freq === "Weekdays") return `${minute} ${hour} * * ${WEEKDAYS}`;
  if (input.freq === "Every week") return `${minute} ${hour} * * 1`;
  if (input.freq === "Every month") return `${minute} ${hour} 1 * *`;
  return `${minute} ${hour} * * *`;
}

export function presetFromCron(cron: string): CronPreset {
  const base = defaultCronPreset();
  const trimmed = cron.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 5) {
    return { ...base, freq: "Advanced", cron: trimmed };
  }
  const minute = parts[0] ?? "*";
  const hour = parts[1] ?? "*";
  const day = parts[2] ?? "*";
  const month = parts[3] ?? "*";
  const dow = parts[4] ?? "*";
  if (month !== "*") {
    return { ...base, freq: "Advanced", cron: trimmed };
  }

  const minuteStep = stepValue(minute);
  const hourStep = stepValue(hour);
  const dayStep = stepValue(day);

  if (minute === "0" && hour === "*" && day === "*" && dow === "*") {
    return { ...base, freq: "Every hour" };
  }
  if (minuteStep && hour === "*" && day === "*" && dow === "*") {
    return { ...base, freq: "Interval", n: minuteStep, unit: "minutes" };
  }
  if (minute === "0" && hourStep && day === "*" && dow === "*") {
    return { ...base, freq: "Interval", n: hourStep, unit: "hours" };
  }
  if (minute === "0" && hour === "0" && dayStep && dow === "*") {
    return { ...base, freq: "Interval", n: dayStep, unit: "days" };
  }
  if (!isInt(minute) || !isInt(hour)) {
    return { ...base, freq: "Advanced", cron: trimmed };
  }

  const time = formatClock(Number(hour), Number(minute));
  if (day === "*" && dow === WEEKDAYS) {
    return { ...base, freq: "Weekdays", time };
  }
  if (day === "*" && dow === "1") {
    return { ...base, freq: "Every week", time };
  }
  if (day === "1" && dow === "*") {
    return { ...base, freq: "Every month", time };
  }
  if (day === "*" && dow === "*") {
    return { ...base, freq: "Every day", time };
  }
  return { ...base, freq: "Advanced", cron: trimmed };
}

export function describeCronPreset(preset: CronPreset): { lead: string; detail: string } {
  if (preset.freq === "Interval") {
    return { lead: "A cada", detail: `${preset.n} ${cronUnitLabel(preset.unit)}` };
  }
  if (preset.freq === "Every hour") {
    return { lead: "Toda hora", detail: "" };
  }
  if (preset.freq === "Advanced") {
    return { lead: "Cron", detail: preset.cron || "*/3 * * * *" };
  }
  if (preset.freq === "Weekdays") {
    return { lead: "Dias úteis", detail: `às ${preset.time}` };
  }
  if (preset.freq === "Every week") {
    return { lead: "Toda segunda", detail: `às ${preset.time}` };
  }
  if (preset.freq === "Every month") {
    return { lead: "Todo mês", detail: `no dia 1 às ${preset.time}` };
  }
  return { lead: "Todo dia", detail: `às ${preset.time}` };
}

export const CRON_FREQ_LABELS: Record<CronFreq, string> = {
  "Every hour": "Toda hora",
  "Every day": "Todo dia",
  Weekdays: "Dias úteis",
  "Every week": "Toda semana",
  "Every month": "Todo mês",
  Interval: "Intervalo",
  Advanced: "Avançado",
};

export const CRON_UNIT_LABELS: Record<CronUnit, string> = {
  minutes: "minutos",
  hours: "horas",
  days: "dias",
};

function cronUnitLabel(unit: CronUnit): string {
  return CRON_UNIT_LABELS[unit] ?? unit;
}

export function formatSchedule(preset: CronPreset): string {
  const { lead, detail } = describeCronPreset(preset);
  return [lead, detail].filter(Boolean).join(" ");
}

export function formatCron(cron: string): string {
  return formatSchedule(presetFromCron(cron));
}

export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Turns everyday PT/EN schedule phrases into a cron preset.
 * Returns null when the text has no recognizable cadence.
 */
export function cronFromNaturalLanguage(text: string): CronPreset | null {
  const raw = foldScheduleText(text);
  if (!raw) return null;

  const interval = raw.match(
    /(?:a cada|every)\s+(\d+)\s+(minutos?|minutes?|horas?|hours?|dias?|days?)/,
  );
  if (interval) {
    const n = Number(interval[1]);
    const unitWord = interval[2] ?? "minutos";
    const unit: CronUnit = /hora|hour/.test(unitWord)
      ? "hours"
      : /dia|day/.test(unitWord)
        ? "days"
        : "minutes";
    return { ...defaultCronPreset(), freq: "Interval", n: n > 0 ? n : 5, unit };
  }

  if (/\b(toda hora|de hora em hora|every hour|hourly)\b/.test(raw)) {
    return { ...defaultCronPreset(), freq: "Every hour" };
  }

  const time = parseNaturalClock(raw) ?? "9:00 AM";
  if (/\b(dias uteis|weekdays?|segunda a sexta|monday to friday)\b/.test(raw)) {
    return { ...defaultCronPreset(), freq: "Weekdays", time };
  }
  if (/\b(toda segunda|every monday|toda semana|every week|weekly)\b/.test(raw)) {
    return { ...defaultCronPreset(), freq: "Every week", time };
  }
  if (/\b(todo mes|every month|mensal|monthly)\b/.test(raw)) {
    return { ...defaultCronPreset(), freq: "Every month", time };
  }
  if (
    /\b(todo dia|diariamente|every day|daily)\b/.test(raw) ||
    /(?:^|\s)(as|at)\s+\d/.test(raw) ||
    /\b\d{1,2}h(?:\d{2})?\b/.test(raw)
  ) {
    return { ...defaultCronPreset(), freq: "Every day", time };
  }
  return null;
}

function foldScheduleText(text: string): string {
  return text.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ");
}

function parseNaturalClock(raw: string): string | null {
  const ampm = raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampm) {
    const hour12 = Number(ampm[1]);
    const minute = Number(ampm[2] ?? 0);
    let hour = hour12;
    if (ampm[3] === "pm" && hour < 12) hour += 12;
    if (ampm[3] === "am" && hour === 12) hour = 0;
    return formatClock(hour, minute);
  }
  const labeled = raw.match(/(?:as|at)\s+(\d{1,2})(?::(\d{2}))?(?:\s*h)?/);
  if (labeled) {
    return formatClock(Number(labeled[1]), Number(labeled[2] ?? 0));
  }
  const compact = raw.match(/\b(\d{1,2})h(\d{2})?\b/);
  if (compact) {
    return formatClock(Number(compact[1]), Number(compact[2] ?? 0));
  }
  return null;
}

/**
 * Next instant strictly after `from` matching the 5-field cron expression,
 * evaluated in `timezone` (IANA). Supports `*`, lists, ranges, steps and
 * month/day-of-week names; day-of-month and day-of-week are OR'ed when both
 * are restricted (vixie semantics). Invalid input falls back to `from` + 1min.
 */
export function nextCronDate(cron: string, from: Date, timezone = "UTC"): Date {
  const fallback = new Date(from.getTime() + 60_000);
  const schedule = parseCron(cron);
  const formatter = zonedFormatter(timezone) ?? zonedFormatter("UTC");
  if (!schedule || !formatter) return fallback;

  const candidate = new Date(from.getTime() + 60_000);
  candidate.setUTCSeconds(0, 0);
  const domRestricted = schedule.dom.size < 31;
  const dowRestricted = schedule.dow.size < 7;
  // Iterate instants: on a day mismatch jump to the next local midnight, else
  // step by the minute; bounded so a never-matching schedule cannot spin.
  for (let days = 0; days < 400; ) {
    const local = zonedParts(formatter, candidate);
    const domMatch = schedule.dom.has(local.day);
    const dowMatch = schedule.dow.has(local.weekday);
    const dayMatch = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!schedule.month.has(local.month) || !dayMatch) {
      const minutesLeft = 24 * 60 - (local.hour * 60 + local.minute);
      candidate.setTime(candidate.getTime() + minutesLeft * 60_000);
      days += 1;
      continue;
    }
    for (let i = 0; i < 24 * 60; i += 1) {
      const now = zonedParts(formatter, candidate);
      if (now.day !== local.day) break;
      if (schedule.hour.has(now.hour) && schedule.minute.has(now.minute)) {
        return new Date(candidate.getTime());
      }
      candidate.setTime(candidate.getTime() + 60_000);
    }
    days += 1;
  }
  return fallback;
}

type CronSchedule = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
};

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseCron(cron: string): CronSchedule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0] ?? "", 0, 59);
  const hour = parseField(parts[1] ?? "", 0, 23);
  const dom = parseField(parts[2] ?? "", 1, 31);
  const month = parseField(parts[3] ?? "", 1, 12, MONTH_NAMES);
  const dow = parseField(parts[4] ?? "", 0, 7, DOW_NAMES);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return { minute, hour, dom, month, dow };
}

function parseField(
  expr: string,
  min: number,
  max: number,
  names: string[] = [],
): Set<number> | null {
  const values = new Set<number>();
  const toNumber = (raw: string): number | null => {
    const named = names.indexOf(raw.toLowerCase());
    if (named >= 0) return named + (names === MONTH_NAMES ? 1 : 0);
    if (!/^\d+$/.test(raw)) return null;
    return Number(raw);
  };
  for (const item of expr.split(",")) {
    if (!item) return null;
    const [rangeExpr, stepExpr, ...rest] = item.split("/");
    if (rest.length > 0 || rangeExpr === undefined) return null;
    const step = stepExpr === undefined ? 1 : /^\d+$/.test(stepExpr) ? Number(stepExpr) : 0;
    if (step < 1) return null;
    let start: number | null;
    let end: number | null;
    if (rangeExpr === "*") {
      start = min;
      end = max;
    } else if (rangeExpr.includes("-")) {
      const [a, b, ...more] = rangeExpr.split("-");
      if (more.length > 0 || a === undefined || b === undefined) return null;
      start = toNumber(a);
      end = toNumber(b);
    } else {
      start = toNumber(rangeExpr);
      end = stepExpr === undefined ? start : max;
    }
    if (start === null || end === null || start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

function zonedFormatter(timezone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    return null;
  }
}

function zonedParts(formatter: Intl.DateTimeFormat, date: Date) {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: DOW_NAMES.indexOf((parts.weekday ?? "").toLowerCase()),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function parseClock(time: string): { hour: number; minute: number } {
  const [rawH, rest] = time.split(":");
  const minute = Number((rest ?? "00").slice(0, 2));
  let hour = Number(rawH);
  if (/pm/i.test(time) && hour < 12) hour += 12;
  if (/am/i.test(time) && hour === 12) hour = 0;
  return { hour, minute };
}

function formatClock(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

function stepValue(expr: string): number | null {
  const match = /^\*\/(\d+)$/.exec(expr);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isInt(expr: string): boolean {
  return /^\d+$/.test(expr);
}
