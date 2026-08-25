import { type MachineGuide as Guide, machineGuideFor } from "@quibt/core";

export function MachineGuide({ kind }: { kind: string | undefined }) {
  const guide = machineGuideFor(kind);
  return (
    <section
      className="rounded-2xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-4 py-4"
      aria-label={`Como usar ${guide.title}`}
    >
      <p className="text-[14px] font-semibold text-[var(--qb-ink)]">{guide.headline}</p>
      <p className="mt-1.5 text-[12px] leading-[1.45] text-[var(--qb-muted)]">{guide.what}</p>
      <p className="mt-1.5 text-[12px] leading-[1.45] text-[var(--qb-muted)]">{guide.who}</p>
      <GuideList title="O que você precisa" items={guide.youNeed} />
      <GuideList title="O que fazer agora" items={guide.steps} ordered />
      <p className="mt-3 text-[12px] leading-[1.45] text-[var(--qb-muted)]">
        <span className="font-semibold text-[var(--qb-ink)]">Vários bots. </span>
        {guide.botsShare}
      </p>
      <p className="mt-1.5 text-[12px] leading-[1.45] text-[var(--qb-muted)]">
        <span className="font-semibold text-[var(--qb-muted)]">Custo. </span>
        {guide.cost}
      </p>
      <GuideLinks guide={guide} />
    </section>
  );
}

function GuideList({
  title,
  items,
  ordered,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
}) {
  const List = ordered ? "ol" : "ul";
  return (
    <div className="mt-3">
      <p className="text-[11px] font-semibold tracking-[0.1em] text-[var(--qb-muted)] uppercase">
        {title}
      </p>
      <List
        className={`mt-1 space-y-1 pl-4 text-[12px] leading-[1.4] text-[var(--qb-muted)] ${
          ordered ? "list-decimal" : "list-disc"
        }`}
      >
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </List>
    </div>
  );
}

function GuideLinks({ guide }: { guide: Guide }) {
  if (!guide.signupUrl && !guide.keyUrl) return null;
  return (
    <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
      {guide.signupUrl ? (
        <a
          href={guide.signupUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--qb-accent)] hover:underline"
        >
          {guide.signupLabel ?? "Abrir o site"}
        </a>
      ) : null}
      {guide.keyUrl ? (
        <a
          href={guide.keyUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--qb-accent)] hover:underline"
        >
          {guide.keyLabel ?? "Abrir as chaves"}
        </a>
      ) : null}
    </p>
  );
}
