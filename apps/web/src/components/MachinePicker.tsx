import type { ComputerCatalogItem } from "@quibt/contracts";
import { isSshHostAlias } from "@quibt/contracts";
import type { ReactNode } from "react";
import { rpc } from "../lib/rpc";

/** Ordem de leitura: o que já está aqui, depois o que é seu, depois a nuvem. */
const CATEGORY_ORDER: Array<ComputerCatalogItem["category"]> = ["local", "remote", "cloud", "vps"];

/** Ícones de traço num grid de 20, uma família por desenho. Nunca emoji. */
const FAMILY_ICONS: Record<string, ReactNode> = {
  docker: (
    <>
      <rect x="2.4" y="3.6" width="15.2" height="10.2" rx="1.8" />
      <path d="M7.4 17h5.2" />
      <path d="M10 13.8V17" />
    </>
  ),
  "remote-supervisor": (
    <>
      <rect x="3.4" y="2.8" width="13.2" height="6" rx="1.6" />
      <rect x="3.4" y="11.2" width="13.2" height="6" rx="1.6" />
      <path d="M6.4 5.8h.01" />
      <path d="M6.4 14.2h.01" />
    </>
  ),
  e2b: <path d="M6 15.4h8.1a3.4 3.4 0 0 0 .5-6.8 4.6 4.6 0 0 0-8.8-1A3.4 3.4 0 0 0 6 15.4Z" />,
  box: (
    <>
      <path d="M10 2.8 17 6.6v6.8L10 17.2 3 13.4V6.6Z" />
      <path d="m3 6.6 7 3.8 7-3.8" />
      <path d="M10 10.4v6.8" />
    </>
  ),
};

const FALLBACK_ICON = (
  <>
    <rect x="2.8" y="3.2" width="14.4" height="13.6" rx="2" />
    <path d="M6 7.2h8" />
    <path d="M6 10.4h5.4" />
  </>
);

/** A etiqueta diz o que a escolha vai exigir — tirada do próprio catálogo. */
function requirement(item: ComputerCatalogItem): string {
  if (item.family === "remote-supervisor") return "Alias SSH ou URL";
  if (item.needsKey && item.needsEndpoint) return "URL e token";
  if (item.needsKey) return "Chave da sua conta";
  if (item.needsEndpoint) return "URL do supervisor";
  if (item.needsDocker) return "Docker Desktop";
  return "Pronta";
}

export function MachinePicker({
  items,
  selected,
  onSelect,
  disabled,
}: {
  items: ComputerCatalogItem[];
  selected: string;
  onSelect: (kind: string) => void;
  disabled?: boolean;
}) {
  // Sem busca e sem cabeçalho de seção: as famílias são quatro, e cada título de
  // seção só repetia o nome do cartão logo abaixo. Uma grade de duas colunas mostra
  // as quatro escolhas de uma vez, que é o que a etapa pergunta.
  const cards = items
    .filter((item) => !item.recipe)
    .slice()
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cards.map((item) => {
        const chosen = selected === item.kind;
        return (
          <button
            key={item.kind}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(item.kind)}
            aria-pressed={chosen}
            className={`grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-[var(--qb-r-lg)] border p-4 text-left transition-colors disabled:opacity-60 ${
              chosen
                ? "border-[var(--qb-accent)] bg-[var(--qb-surface-2)]"
                : "border-[var(--qb-hairline)] hover:bg-[var(--qb-inset)]"
            }`}
          >
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--qb-r-sm)]"
              style={{ background: chosen ? "rgba(60, 130, 246, 0.12)" : "var(--qb-tile)" }}
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 20 20"
                fill="none"
                stroke={chosen ? "var(--qb-accent)" : "var(--qb-muted)"}
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {FAMILY_ICONS[item.family] ?? FALLBACK_ICON}
              </svg>
            </span>
            <span className="block min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--qb-ink)]">
                  {item.title}
                </span>
                <span
                  className="rounded-[var(--qb-r-xs)] px-1.5 py-0.5 text-[11.5px] font-semibold"
                  style={
                    chosen
                      ? { background: "rgba(60, 130, 246, 0.12)", color: "var(--qb-accent)" }
                      : { background: "var(--qb-inset)", color: "var(--qb-muted)" }
                  }
                >
                  {requirement(item)}
                </span>
              </span>
              <span className="mt-1.5 block text-[13px] leading-[1.45] text-[var(--qb-muted)]">
                {item.body}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function MachineCredentials({
  item,
  recipes,
  endpoint,
  apiKey,
  onEndpoint,
  onApiKey,
  onSelectRecipe,
  disabled,
}: {
  item: ComputerCatalogItem | undefined;
  recipes?: ComputerCatalogItem[];
  endpoint: string;
  apiKey: string;
  onEndpoint: (value: string) => void;
  onApiKey: (value: string) => void;
  onSelectRecipe?: (kind: string) => void;
  disabled?: boolean;
}) {
  if (!item) return null;
  const vpsHelp =
    item.family === "remote-supervisor" ? (recipes ?? []).filter((entry) => entry.recipe) : [];
  const sshPath = isSshHostAlias(endpoint);
  return (
    <div className="mt-4 grid gap-2.5 border-t border-[var(--qb-hairline)] pt-4">
      {item.needsEndpoint ? (
        <label className="block text-[12px] text-[var(--qb-muted)]">
          {item.endpointLabel ?? "URL do supervisor"}
          <input
            value={endpoint}
            disabled={disabled}
            onChange={(event) => onEndpoint(event.target.value)}
            placeholder="meu-vps ou https://sua-vps.exemplo"
            className="mt-1 w-full rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3.5 py-2 text-[13px] text-[var(--qb-ink)] outline-none placeholder:text-[var(--qb-muted-2)] focus:border-[var(--qb-accent)]"
          />
          {item.family === "remote-supervisor" ? (
            <span className="mt-1.5 block text-[11px] leading-[1.45] text-[var(--qb-muted-2)]">
              Alias SSH do ~/.ssh/config: a API no notebook fala com o Docker da VPS (`docker -H
              ssh://alias`) e abre um túnel temporário do noVNC até 127.0.0.1 — a tela ao vivo
              aparece aqui, sem publicar 80, 443 ou 7091. Nunca cole chave privada nem senha. Ou
              cole a URL https do profile supervisor-tls (docker compose --profile supervisor-tls up
              -d supervisor supervisor-tls) e o token. O caminho que deixa o celular ligado 24 h é
              instalar o Quibt inteiro na VPS.
            </span>
          ) : null}
        </label>
      ) : null}
      {item.needsKey && !sshPath ? (
        <label className="block text-[12px] text-[var(--qb-muted)]">
          {item.keyLabel ?? "Chave da sua conta"}
          <input
            type="password"
            value={apiKey}
            disabled={disabled}
            onChange={(event) => onApiKey(event.target.value)}
            placeholder="Cole a chave da sua conta"
            className="mt-1 w-full rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-3.5 py-2 text-[13px] text-[var(--qb-ink)] outline-none placeholder:text-[var(--qb-muted-2)] focus:border-[var(--qb-accent)]"
          />
        </label>
      ) : null}
      {vpsHelp.length ? (
        <div className="rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] p-3">
          <p className="text-[12px] text-[var(--qb-muted)]">
            Ainda não tem supervisor? Escolha uma receita, rode no seu provedor, depois cole o alias
            SSH ou a URL e o token.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {vpsHelp.map((recipe) => (
              <button
                key={recipe.kind}
                type="button"
                disabled={disabled}
                onClick={() => onSelectRecipe?.(recipe.kind)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  item.kind === recipe.kind
                    ? "bg-[var(--qb-ink-strong)] text-[var(--qb-canvas)]"
                    : "border border-[var(--qb-hairline)] text-[var(--qb-ink)] hover:bg-[var(--qb-inset)]"
                }`}
              >
                {recipe.title}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {item.recipe ? (
        <div className="rounded-xl border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] p-3">
          <p className="text-[12px] text-[var(--qb-muted)]">{item.recipe.hint}</p>
          {item.recipe.docsUrl ? (
            <a
              href={item.recipe.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-block text-[12px] text-[var(--qb-accent)] hover:underline"
            >
              Documentação do provedor
            </a>
          ) : null}
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-[1.4] text-[var(--qb-muted)]">
            {item.recipe.installScript}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

export async function activateMachine(input: { kind: string; endpoint: string; apiKey: string }) {
  return rpc.computers.activate({
    kind: input.kind,
    endpoint: input.endpoint.trim() || undefined,
    apiKey: input.apiKey.trim() || undefined,
  });
}

export async function probeMachine(input: { kind: string; endpoint: string; apiKey: string }) {
  return rpc.computers.probe({
    kind: input.kind,
    endpoint: input.endpoint.trim() || undefined,
    apiKey: input.apiKey.trim() || undefined,
  });
}
