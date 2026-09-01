import type { Bot, BotGroup } from "@quibt/contracts";
import { botIsOnline, inboxPresence } from "@quibt/core";
import { BotAvatar } from "@quibt/ui-web";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContextMenu, Icon, MenuDivider, MenuItem } from "../components/desktop-ui";
import { inboxTimeLabel } from "../lib/day-stamps";
import {
  hiddenBotCount,
  hiddenToggleLabel,
  matchesInboxQuery,
  revealsHidden,
  visibleInboxBots,
} from "../lib/inbox-list";
import { previewSnippet } from "../lib/preview";
import { GroupAvatar } from "./GroupAvatar";
import { WindowChrome } from "./WindowChrome";

type InboxRow =
  | { kind: "bot"; id: string; at: string; bot: Bot }
  | { kind: "group"; id: string; at: string; group: BotGroup };

type MenuState =
  | { kind: "bot"; bot: Bot; x: number; y: number }
  | { kind: "group"; group: BotGroup; x: number; y: number };

export function Inbox({
  bots,
  groups,
  query,
  selectedBotId,
  selectedGroupId,
  userName,
  userImage,
  onQuery,
  onAccount,
  onPlugins,
  onCreateBot,
  onCreateGroup,
  onImportTeam,
  onPin,
  onMarkUnread,
  onEditBot,
  onDuplicate,
  onHide,
  onClear,
  onDeleteBot,
  onDeleteGroup,
}: {
  bots: Bot[];
  groups: BotGroup[];
  query: string;
  selectedBotId?: string;
  selectedGroupId?: string;
  userName: string;
  userImage?: string | null;
  onQuery: (value: string) => void;
  onAccount: () => void;
  onPlugins?: () => void;
  onCreateBot: () => void;
  onCreateGroup: () => void;
  /** Importa uma equipe inteira de um arquivo Markdown (docs/team-packs.md). */
  onImportTeam?: () => void;
  onPin?: (bot: Bot) => void;
  onMarkUnread?: (bot: Bot) => void;
  onEditBot?: (bot: Bot) => void;
  onDuplicate?: (bot: Bot) => void;
  onHide?: (bot: Bot) => void;
  onClear?: (bot: Bot) => void;
  onDeleteBot?: (bot: Bot) => void;
  onDeleteGroup?: (group: BotGroup) => void;
}) {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [createQuery, setCreateQuery] = useState("");
  const [createIndex, setCreateIndex] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const initials =
    userName
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "U";
  const hiddenCount = useMemo(() => hiddenBotCount(bots, query), [bots, query]);
  const revealing = revealsHidden(showHidden, hiddenCount);
  const visibleBots = useMemo(() => visibleInboxBots(bots, revealing), [bots, revealing]);
  const createBots = useMemo(() => {
    const needle = createQuery.trim().toLocaleLowerCase("pt-BR");
    if (!needle) return bots.filter((bot) => !bot.hidden);
    return bots.filter((bot) =>
      `${bot.name} ${bot.title}`.toLocaleLowerCase("pt-BR").includes(needle),
    );
  }, [bots, createQuery]);

  useEffect(() => {
    if (!createOpen) {
      setCreateQuery("");
      return;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setCreateOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [createOpen]);

  // Uma busca nova encurta a lista: o destaque volta ao começo para o ↵ não abrir
  // outra coisa que não está mais na tela.
  useEffect(() => {
    setCreateIndex(0);
  }, [createQuery, createOpen]);

  // As opções do diálogo, na ordem desenhada: criar bot, cada bot filtrado, criar grupo
  // e, quando disponível, importar uma equipe. Todas entram no mesmo percurso ↑↓ / Enter.
  const createGroupIndex = createBots.length + 1;
  const importTeamIndex = onImportTeam ? createGroupIndex + 1 : null;
  const createOptionCount = createGroupIndex + 1 + (onImportTeam ? 1 : 0);
  function pickCreateOption(index: number) {
    setCreateOpen(false);
    if (index === 0) {
      onCreateBot();
      return;
    }
    const bot = createBots[index - 1];
    if (bot) {
      navigate(`/app/${bot.id}`);
      return;
    }
    if (index === createGroupIndex) {
      onCreateGroup();
      return;
    }
    if (index === importTeamIndex) onImportTeam?.();
  }
  function onCreateKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setCreateIndex((current) => Math.min(Math.max(current + delta, 0), createOptionCount - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pickCreateOption(createIndex);
    }
  }

  const rows = useMemo(() => {
    const match = (value: string) => matchesInboxQuery(value, query);
    const items: InboxRow[] = [
      ...visibleBots
        .filter((bot) => match(`${bot.name} ${bot.title} ${bot.preview}`))
        .map((bot) => ({ kind: "bot" as const, id: bot.id, at: bot.updatedAt, bot })),
      ...groups
        .filter((group) =>
          match(`${group.name} ${group.members.map((member) => member.name).join(" ")}`),
        )
        .map((group) => ({ kind: "group" as const, id: group.id, at: group.updatedAt, group })),
    ];
    return items.sort((a, b) => {
      const chief =
        Number(b.kind === "bot" && b.bot.chiefOfStaff) -
        Number(a.kind === "bot" && a.bot.chiefOfStaff);
      if (chief) return chief;
      const pin =
        Number(b.kind === "bot" && b.bot.pinned) - Number(a.kind === "bot" && a.bot.pinned);
      if (pin) return pin;
      return new Date(b.at).getTime() - new Date(a.at).getTime();
    });
  }, [visibleBots, groups, query]);

  return (
    <div className="qb-dash__sidebar">
      <div className="qb-dash__chrome app-drag">
        <div className="flex min-h-[11px] min-w-[72px] items-center">
          <WindowChrome />
        </div>
        <div className="app-no-drag relative">
          <button
            type="button"
            className="qb-dash__new"
            aria-label="Nova conversa"
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((open) => !open)}
          >
            <Icon name="plus" size={20} />
          </button>
          {createOpen ? (
            <>
              <button
                type="button"
                className="qb-dash__new-backdrop"
                aria-label="Fechar nova conversa"
                onClick={() => setCreateOpen(false)}
              />
              <div className="qb-dash__new-dialog" role="dialog" aria-label="Nova conversa">
                <label className="qb-dash__new-recipient">
                  <span>Para:</span>
                  <input
                    // biome-ignore lint/a11y/noAutofocus: o diálogo abre por um clique no "+"; a busca é o único campo.
                    autoFocus
                    value={createQuery}
                    onChange={(event) => setCreateQuery(event.target.value)}
                    onKeyDown={onCreateKeyDown}
                    placeholder="Buscar ou escolher um bot"
                  />
                </label>
                <div className="qb-dash__new-list" role="listbox" aria-label="Bots">
                  <button
                    type="button"
                    role="option"
                    aria-selected={createIndex === 0}
                    className={`qb-dash__new-option${createIndex === 0 ? " is-selected" : ""}`}
                    onMouseMove={() => setCreateIndex(0)}
                    onClick={() => pickCreateOption(0)}
                  >
                    <span className="qb-dash__new-option-icon">
                      <Icon name="plus" size={15} />
                    </span>
                    <span className="flex-1">Criar novo bot</span>
                  </button>
                  {createBots.map((bot, index) => (
                    <button
                      key={bot.id}
                      type="button"
                      role="option"
                      aria-selected={createIndex === index + 1}
                      className={`qb-dash__new-option${
                        createIndex === index + 1 ? " is-selected" : ""
                      }`}
                      onMouseMove={() => setCreateIndex(index + 1)}
                      onClick={() => pickCreateOption(index + 1)}
                    >
                      <BotAvatar
                        color={bot.color}
                        shape={bot.shape}
                        size={24}
                        state={botIsOnline(bot.status) ? "working" : "idle"}
                      />
                      <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                      {bot.title ? (
                        <span className="qb-dash__new-option-role">{bot.title}</span>
                      ) : null}
                    </button>
                  ))}
                  {!createBots.length ? (
                    <p className="px-3 py-5 text-center text-[13px] text-[var(--qb-muted)]">
                      Nenhum bot encontrado.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={createIndex === createGroupIndex}
                    className={`qb-dash__new-option qb-dash__new-group${
                      createIndex === createGroupIndex ? " is-selected" : ""
                    }`}
                    onMouseMove={() => setCreateIndex(createGroupIndex)}
                    onClick={() => pickCreateOption(createGroupIndex)}
                  >
                    <span className="qb-dash__new-option-icon">
                      <Icon name="users" size={15} />
                    </span>
                    <span className="flex-1">Criar novo grupo</span>
                  </button>
                  {onImportTeam && importTeamIndex !== null ? (
                    <button
                      type="button"
                      role="option"
                      aria-selected={createIndex === importTeamIndex}
                      className={`qb-dash__new-option qb-dash__new-group${
                        createIndex === importTeamIndex ? " is-selected" : ""
                      }`}
                      onMouseMove={() => setCreateIndex(importTeamIndex)}
                      onClick={() => pickCreateOption(importTeamIndex)}
                    >
                      <span className="qb-dash__new-option-icon">
                        <Icon name="download" size={15} />
                      </span>
                      <span className="flex-1">Importar equipe (.md)</span>
                    </button>
                  ) : null}
                </div>
                <div className="qb-dash__new-hint">
                  <span>
                    <kbd>↑↓</kbd> escolher
                  </span>
                  <span>
                    <kbd>↵</kbd> abrir
                  </span>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <label className="qb-dash__search">
        <Icon name="search" size={15} />
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onQuery("");
          }}
          placeholder="Buscar"
        />
      </label>
      <div className="qb-dash__bot-list">
        {rows.length === 0 && query.trim() ? (
          <div className="px-3 py-8 text-center text-[13px] text-[var(--qb-muted)]">
            Nada combina com “{query}”
          </div>
        ) : null}
        {rows.map((row) => {
          if (row.kind === "bot") {
            const selected = selectedBotId === row.bot.id;
            return (
              <button
                key={row.bot.id}
                type="button"
                onClick={() => navigate(`/app/${row.bot.id}`)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ kind: "bot", bot: row.bot, x: event.clientX, y: event.clientY });
                }}
                className={`qb-dash__bot-row${selected ? " is-active" : ""}${
                  row.bot.chiefOfStaff ? " is-chief" : ""
                }`}
              >
                <span className="qb-dash__mascot" style={{ width: 36, height: 36 }}>
                  <BotAvatar
                    color={row.bot.color}
                    shape={row.bot.shape}
                    size={36}
                    presence={inboxPresence({ status: row.bot.status, unread: row.bot.unread })}
                    state={botIsOnline(row.bot.status) ? "working" : "idle"}
                  />
                </span>
                <span className="qb-dash__bot-copy">
                  <span className="qb-dash__bot-meta">
                    <span className="qb-dash__bot-name">
                      {row.bot.pinned ? (
                        <span className="mr-1 inline-flex text-[var(--qb-muted)]" title="Fixado">
                          <Icon name="pin" size={11} />
                        </span>
                      ) : null}
                      {row.bot.name}
                      {row.bot.title ? (
                        <span className="qb-dash__bot-role">{row.bot.title}</span>
                      ) : null}
                    </span>
                    <span className="qb-dash__bot-time">
                      {row.bot.unread ? (
                        <span
                          className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[var(--qb-accent)]"
                          title="Não lida"
                        />
                      ) : null}
                      {inboxTimeLabel(row.bot.updatedAt) ?? ""}
                    </span>
                  </span>
                  <span className="qb-dash__bot-preview">
                    {row.bot.chiefOfStaff ? (
                      <span className="mr-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--qb-accent)]">
                        <Icon name="crown" size={11} />
                        Chefe
                      </span>
                    ) : null}
                    {previewSnippet(row.bot.preview) || " "}
                  </span>
                </span>
              </button>
            );
          }
          const selected = selectedGroupId === row.group.id;
          return (
            <button
              key={row.group.id}
              type="button"
              onClick={() => navigate(`/app/g/${row.group.id}`)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ kind: "group", group: row.group, x: event.clientX, y: event.clientY });
              }}
              className={`qb-dash__bot-row${selected ? " is-active" : ""}`}
            >
              <GroupAvatar members={row.group.members} size={40} />
              <span className="qb-dash__bot-copy">
                <span className="qb-dash__bot-meta">
                  <span className="qb-dash__bot-name">{row.group.name}</span>
                  <span className="qb-dash__bot-time">
                    {inboxTimeLabel(row.group.updatedAt) ?? ""}
                  </span>
                </span>
                <span className="qb-dash__bot-preview">
                  {/* Com conversa, a lista mostra o último recado, como nos bots;
                      o elenco só aparece enquanto o grupo ainda está mudo. */}
                  {row.group.preview ||
                    row.group.members.map((member) => member.name).join(", ") ||
                    "Grupo"}
                </span>
              </span>
            </button>
          );
        })}
        {hiddenCount ? (
          <button
            type="button"
            onClick={() => setShowHidden((open) => !open)}
            className="qb-dash__quiet"
          >
            {hiddenToggleLabel(revealing, hiddenCount)}
          </button>
        ) : null}
      </div>
      <div className="qb-dash__footer">
        {onPlugins ? (
          <button type="button" className="qb-dash__footer-btn" onClick={onPlugins}>
            <Icon name="puzzle" size={18} className="text-[var(--qb-muted)]" />
            Plugins
          </button>
        ) : null}
        <button type="button" className="qb-dash__user" aria-label="Conta" onClick={onAccount}>
          {userImage ? (
            <img className="qb-dash__user-badge qb-dash__user-photo" src={userImage} alt="" />
          ) : (
            <span className="qb-dash__user-badge">{initials}</span>
          )}
          <span className="min-w-0 flex-1 truncate">{userName}</span>
          <Icon name="settings" size={16} className="text-[var(--qb-muted)]" />
        </button>
      </div>
      {menu?.kind === "bot" ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            icon={menu.bot.pinned ? "pinOff" : "pin"}
            label={menu.bot.pinned ? "Desafixar" : "Fixar"}
            onClick={() => {
              onPin?.(menu.bot);
              setMenu(null);
            }}
          />
          <MenuItem
            icon="unread"
            label="Marcar como não lida"
            onClick={() => {
              onMarkUnread?.(menu.bot);
              setMenu(null);
            }}
          />
          <MenuDivider />
          <MenuItem
            icon="edit"
            label="Editar perfil"
            onClick={() => {
              onEditBot?.(menu.bot);
              setMenu(null);
            }}
          />
          <MenuItem
            icon="duplicate"
            label="Duplicar"
            onClick={() => {
              onDuplicate?.(menu.bot);
              setMenu(null);
            }}
          />
          <MenuItem
            icon="copy"
            label="Copiar ID da conversa"
            onClick={() => {
              void navigator.clipboard?.writeText(menu.bot.threadId);
              setMenu(null);
            }}
          />
          <MenuDivider />
          <MenuItem
            icon="clear"
            label="Limpar conversa"
            onClick={() => {
              onClear?.(menu.bot);
              setMenu(null);
            }}
          />
          <MenuItem
            icon="hide"
            label={menu.bot.hidden ? "Mostrar na lista" : "Ocultar da lista"}
            onClick={() => {
              onHide?.(menu.bot);
              setMenu(null);
            }}
          />
          <MenuItem
            icon="trash"
            label="Excluir"
            danger
            onClick={() => {
              onDeleteBot?.(menu.bot);
              setMenu(null);
            }}
          />
        </ContextMenu>
      ) : null}
      {menu?.kind === "group" ? (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            icon="copy"
            label="Copiar ID da conversa"
            onClick={() => {
              void navigator.clipboard?.writeText(menu.group.threadId);
              setMenu(null);
            }}
          />
          <MenuItem
            icon="trash"
            label="Excluir grupo"
            danger
            onClick={() => {
              onDeleteGroup?.(menu.group);
              setMenu(null);
            }}
          />
        </ContextMenu>
      ) : null}
    </div>
  );
}
