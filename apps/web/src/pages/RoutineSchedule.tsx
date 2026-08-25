import {
  CRON_FREQ_LABELS,
  CRON_FREQS,
  CRON_UNIT_LABELS,
  type CronFreq,
  type CronPreset,
  type CronUnit,
  cronFromNaturalLanguage,
  cronFromPreset,
  describeCronPreset,
} from "@quibt/core";
import { useState } from "react";

const UNITS: CronUnit[] = ["minutes", "hours", "days"];
const NUMBERS = [1, 2, 3, 5, 10, 15, 30, 45];
const TIMES = [
  "6:00 AM",
  "7:00 AM",
  "8:00 AM",
  "9:00 AM",
  "12:00 PM",
  "3:00 PM",
  "6:00 PM",
  "9:00 PM",
];

const TIMED: CronFreq[] = ["Every day", "Weekdays", "Every week", "Every month"];

export function RoutineSchedule({
  value,
  onChange,
}: {
  value: CronPreset;
  onChange: (next: CronPreset) => void;
}) {
  const { lead, detail } = describeCronPreset(value);
  const times = TIMES.includes(value.time) ? TIMES : [...TIMES, value.time];
  const numbers = NUMBERS.includes(value.n) ? NUMBERS : [...NUMBERS, value.n].sort((a, b) => a - b);
  const [phrase, setPhrase] = useState("");

  function patch(partial: Partial<CronPreset>) {
    onChange({ ...value, ...partial });
  }

  return (
    <div className="mt-2 rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] p-3">
      <input
        value={phrase}
        onChange={(event) => {
          const next = event.target.value;
          setPhrase(next);
          const parsed = cronFromNaturalLanguage(next);
          if (parsed) onChange(parsed);
        }}
        placeholder="todo dia às 9, dias úteis às 8…"
        aria-label="Horário em linguagem natural"
        className="mb-2.5 w-full rounded-[var(--qb-r-md)] border-0 bg-[var(--qb-surface-2)] px-3 py-2 text-[14px] text-[var(--qb-ink)] outline-none placeholder:text-[var(--qb-muted)]"
      />
      <div className="flex items-center gap-2.5 px-0.5">
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--qb-muted)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span className="text-[14.5px] text-[var(--qb-ink)]">{lead}</span>
        {detail ? (
          <span className="flex-1 text-[14.5px] text-[var(--qb-muted)]">{detail}</span>
        ) : null}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[var(--qb-r-md)] bg-[var(--qb-surface-2)] px-2.5 py-2.5 text-[14px] text-[var(--qb-muted)]">
        <select
          className="rk-schedule-select"
          value={value.freq}
          aria-label="Com que frequência"
          onChange={(event) => {
            const freq = event.target.value as CronFreq;
            if (freq === "Advanced") {
              patch({ freq, cron: cronFromPreset(value) });
              return;
            }
            patch({ freq });
          }}
        >
          {CRON_FREQS.map((freq) => (
            <option key={freq} value={freq}>
              {CRON_FREQ_LABELS[freq]}
            </option>
          ))}
        </select>
        {value.freq === "Interval" ? (
          <>
            <span>a cada</span>
            <select
              className="rk-schedule-select"
              value={String(value.n)}
              aria-label="Quantidade do intervalo"
              onChange={(event) => patch({ n: Number(event.target.value) })}
            >
              {numbers.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              className="rk-schedule-select"
              value={value.unit}
              aria-label="Unidade do intervalo"
              onChange={(event) => patch({ unit: event.target.value as CronUnit })}
            >
              {UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {CRON_UNIT_LABELS[unit]}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {TIMED.includes(value.freq) ? (
          <>
            <span>às</span>
            <select
              className="rk-schedule-select"
              value={value.time}
              aria-label="Horário"
              onChange={(event) => patch({ time: event.target.value })}
            >
              {times.map((time) => (
                <option key={time} value={time}>
                  {time}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {value.freq === "Advanced" ? (
          <input
            value={value.cron}
            placeholder="*/3 * * * *"
            aria-label="Expressão cron"
            onChange={(event) => patch({ cron: event.target.value })}
            className="min-w-[120px] flex-1 rounded-lg border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-2.5 py-1.5 font-mono text-[13.5px] text-[var(--qb-ink)] outline-none"
          />
        ) : null}
      </div>
    </div>
  );
}
