import { parseTeamPack, type TeamPackResult } from "@quibt/core";
import { useMemo, useRef, useState } from "react";
import { importTeamPack, type TeamImportClient, type TeamImportReport } from "../lib/team-import";

/**
 * Importar uma equipe de um arquivo Markdown: cola ou escolhe o arquivo, revisa o que
 * vai nascer (bots, rotinas pausadas, grupo) e confirma. O formato está em
 * `docs/team-packs.md`; o parser explica cada problema em português antes de criar
 * qualquer coisa.
 */
export function TeamImportPanel({
  client,
  onDone,
  onCancel,
}: {
  client: TeamImportClient;
  /** Chamado após importar, com o grupo (ou primeiro bot) para abrir. */
  onDone: (report: TeamImportReport) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<TeamImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const parsed: TeamPackResult | null = useMemo(() => {
    if (!text.trim()) return null;
    return parseTeamPack(text);
  }, [text]);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setText(await file.text());
  }

  async function runImport() {
    if (!parsed?.ok || busy) return;
    setBusy(true);
    try {
      const result = await importTeamPack(parsed.pack, client);
      setReport(result);
      if (!result.failures.length) onDone(result);
    } finally {
      setBusy(false);
    }
  }

  const routineCount = parsed?.ok
    ? parsed.pack.bots.reduce((sum, bot) => sum + bot.routines.length, 0)
    : 0;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13px] text-[var(--qb-muted)]">Importar equipe</span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Fechar"
          className="grid h-7 w-7 place-items-center rounded-full bg-[var(--qb-surface)] text-[13px] text-[var(--qb-muted)]"
        >
          ✕
        </button>
      </div>

      <p className="text-[13px] leading-[1.45] text-[var(--qb-muted)]">
        Um arquivo Markdown vira um time inteiro: bots com instruções, um grupo com ordens
        permanentes e rotinas sugeridas — todas pausadas até você ligar. Pacotes nunca carregam
        chaves nem conectores.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => void pickFile(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-2 text-[14px] text-[var(--qb-ink)]"
        >
          Escolher arquivo .md
        </button>
        <span className="text-[13px] text-[var(--qb-muted)]">ou cole abaixo</span>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setReport(null);
        }}
        rows={10}
        placeholder={"# Equipe: Growth\n\n## Ana — Analista\n\nInstruções da Ana…"}
        className="mt-3 w-full rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3 font-mono text-[13px] leading-[1.5] text-[var(--qb-ink)] outline-none placeholder:text-[var(--qb-muted)]"
      />

      {parsed && !parsed.ok ? (
        <ul className="mt-3 space-y-1.5">
          {parsed.errors.map((error) => (
            <li key={error} className="text-[13px] leading-[1.45] text-[var(--qb-danger)]">
              {error}
            </li>
          ))}
        </ul>
      ) : null}

      {parsed?.ok ? (
        <div className="mt-3 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3 text-[14px] leading-[1.5] text-[var(--qb-ink)]">
          <p>
            {parsed.pack.name
              ? `Grupo "${parsed.pack.name}" com ${parsed.pack.bots.length} ${parsed.pack.bots.length === 1 ? "bot" : "bots"}`
              : `${parsed.pack.bots.length} ${parsed.pack.bots.length === 1 ? "bot avulso" : "bots avulsos"}, sem grupo`}
            {routineCount
              ? ` e ${routineCount} ${routineCount === 1 ? "rotina pausada" : "rotinas pausadas"}`
              : ""}
            .
          </p>
          <p className="mt-1 text-[13px] text-[var(--qb-muted)]">
            {parsed.pack.bots.map((bot) => bot.name).join(", ")}
          </p>
          {parsed.warnings.map((warning) => (
            <p key={warning} className="mt-1 text-[13px] text-[var(--qb-muted)]">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      {report?.failures.length ? (
        <div className="mt-3 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3.5 py-3">
          <p className="text-[14px] text-[var(--qb-ink)]">
            Importado com pendências — {report.createdBots.length}{" "}
            {report.createdBots.length === 1 ? "bot criado" : "bots criados"}:
          </p>
          <ul className="mt-1.5 space-y-1">
            {report.failures.map((failure) => (
              <li key={failure} className="text-[13px] leading-[1.45] text-[var(--qb-danger)]">
                {failure}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <button
        type="button"
        disabled={!parsed?.ok || busy}
        onClick={() => void runImport()}
        className="mt-5 rounded-[var(--qb-r-md)] bg-[var(--qb-ink-strong)] px-5 py-2.5 font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
      >
        {busy ? "Importando…" : "Importar equipe"}
      </button>
    </div>
  );
}
