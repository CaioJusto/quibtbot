import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/desktop-ui";
import {
  filterPalette,
  moveHighlight,
  normalizeQuery,
  type PaletteItem,
} from "../lib/command-palette";

/**
 * Busca de teclado sobre a lista já montada pelo Shell. O componente não conhece
 * bots nem rotas: recebe itens e devolve o escolhido, para o Shell decidir o que
 * fazer com cada tipo de ação.
 */
export function CommandPalette({
  items,
  onPick,
  onClose,
  searchMessages,
}: {
  items: PaletteItem[];
  onPick: (item: PaletteItem) => void;
  onClose: () => void;
  searchMessages?: (query: string) => Promise<PaletteItem[]>;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [remoteItems, setRemoteItems] = useState<PaletteItem[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const localRows = useMemo(() => filterPalette(items, query), [items, query]);
  const rows = useMemo(() => [...localRows, ...remoteItems], [localRows, remoteItems]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const normalized = normalizeQuery(query);
    if (!searchMessages || normalized.length < 2) {
      setRemoteItems([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setRemoteItems([]);
    const timer = window.setTimeout(() => {
      searchMessages(query)
        .then((results) => {
          if (!cancelled) setRemoteItems(results);
        })
        .catch(() => {
          if (!cancelled) setRemoteItems([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, searchMessages]);

  // Uma busca nova pode encurtar a lista: manter o índice antigo destacaria uma
  // linha que não existe mais, e o Enter abriria outra coisa.
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // A linha destacada tem de estar visível quando se anda só com o teclado.
  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) =>
        moveHighlight(current, rows.length, event.key === "ArrowDown" ? 1 : -1),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = rows[highlight];
      if (picked) onPick(picked);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]"
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Buscar no Quibt"
    >
      <button
        type="button"
        aria-label="Fechar a busca"
        onClick={onClose}
        className="fixed inset-0 cursor-default bg-[rgba(20,20,24,0.28)]"
      />
      <div className="qb-menu relative w-full max-w-[560px] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--qb-hairline)] px-3 py-2.5">
          <Icon name="search" size={15} className="text-[var(--qb-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar bot, grupo, ação ou mensagem"
            aria-label="Buscar bot, grupo, ação ou mensagem"
            autoComplete="off"
            className="w-full bg-transparent text-[14px] text-[var(--qb-ink)] outline-none placeholder:text-[var(--qb-muted)]"
          />
          <kbd className="rounded-[6px] border border-[var(--qb-hairline)] px-1.5 py-0.5 text-[11px] text-[var(--qb-muted)]">
            esc
          </kbd>
        </div>
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[13px] text-[var(--qb-muted)]">
            {searching ? "Buscando mensagens…" : "Nada com esse nome."}
          </p>
        ) : (
          <ul ref={listRef} className="max-h-[320px] overflow-y-auto py-1.5">
            {rows.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => onPick(item)}
                  aria-current={index === highlight}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
                    index === highlight ? "bg-[var(--qb-surface-2)]" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-[var(--qb-ink)]">
                      {item.label}
                    </span>
                    {item.detail ? (
                      <span className="block truncate text-[12px] text-[var(--qb-muted)]">
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
