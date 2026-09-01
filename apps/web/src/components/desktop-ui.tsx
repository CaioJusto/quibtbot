import type { CSSProperties, ReactNode } from "react";

export function GlassSurface({
  children,
  className = "",
  style,
}: {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`qb-glass ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

export function Icon({
  name,
  size = 16,
  className = "",
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

export type IconName = keyof typeof ICON_PATHS;

const ICON_PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  download: (
    <>
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  pin: <path d="M12 17v5M8 3h8l-1 7h3l-6 6-6-6h3L8 3z" />,
  pinOff: (
    <>
      <path d="M12 17v5M8 3h8l-1 7h3l-6 6-6-6h3L8 3z" />
      <path d="M4 4l16 16" />
    </>
  ),
  crown: <path d="M3 18h18M5 18l2-10 5 5 5-5 2 10" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    </>
  ),
  hide: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a16 16 0 0 1-3.2 3.8" />
      <path d="M6.1 6.1C3.7 7.8 2 12 2 12s4 7 10 7c1.5 0 2.9-.3 4.1-.9" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V5h6v2M8 7l1 12h6l1-12" />
    </>
  ),
  clear: (
    <>
      <path d="M4 7h16M4 12h10M4 17h7" />
      <path d="m18 14 2 2-2 2m2-2h-5" />
    </>
  ),
  unread: (
    <>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  plugins: (
    <>
      <path d="M10 4v4H6v4h4v8h4v-8h4V8h-4V4z" />
    </>
  ),
  puzzle: (
    <>
      <path d="M8 4h4a2 2 0 0 1 2 2v1a2 2 0 1 0 2 2h2a2 2 0 0 1 2 2v3h-2a2 2 0 1 0 0 4h2v1a2 2 0 0 1-2 2h-3v-2a2 2 0 1 0-4 0v2H8a2 2 0 0 1-2-2v-3H4a2 2 0 1 1 0-4h2V9a2 2 0 0 1 2-2h2V6a2 2 0 0 1 2-2z" />
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  expand: (
    <>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
      <path d="M3 8l6-6M21 8l-6-6M3 16l6 6M21 16l-6 6" />
    </>
  ),
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  paperclip: (
    <path d="M21 12.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3" />
  ),
  square: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V21M9 21h6" />
    </>
  ),
  volume: (
    <>
      <path d="M11 5 6.5 8.5H3v7h3.5L11 19V5z" />
      <path d="M15 9a4.2 4.2 0 0 1 0 6M17.7 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  clock: <path d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12l5 5 9-10" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  bot: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 8V5M9 13h.01M15 13h.01" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="3" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  machine: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  logout: (
    <>
      <path d="M10 7V5a2 2 0 0 1 2-2h7v18h-7a2 2 0 0 1-2-2v-2" />
      <path d="M15 12H3M6 9l-3 3 3 3" />
    </>
  ),
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5z" />,
  reply: <path d="M9 7L4 12l5 5M4 12h9a7 7 0 0 1 7 7v1" />,
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    </>
  ),
} as const;

export function ContextMenu({
  x,
  y,
  width = 228,
  children,
  onClose,
}: {
  x: number;
  y: number;
  width?: number;
  children: ReactNode;
  onClose: () => void;
}) {
  const left = Math.min(x, typeof window === "undefined" ? x : window.innerWidth - width - 8);
  const top = Math.max(
    8,
    Math.min(y, typeof window === "undefined" ? y : window.innerHeight - 380),
  );
  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 cursor-default"
        aria-label="Fechar menu"
        onClick={onClose}
      />
      <div className="qb-menu fixed z-50 overflow-hidden py-1.5" style={{ left, top, width }}>
        {children}
      </div>
    </>
  );
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
  hint,
  trailing,
}: {
  icon?: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  /** Valor à direita, como a cota da semana. Mantém a linha com uma altura só. */
  trailing?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={hint}
      onClick={onClick}
      className={`qb-menu__item${danger ? " is-danger" : ""}`}
    >
      {icon ? <Icon name={icon} size={16} className="qb-menu__icon" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? <span className="qb-menu__trailing">{trailing}</span> : null}
    </button>
  );
}

export function MenuDivider() {
  return <div className="qb-menu__divider" />;
}

/**
 * Superfície única de modal do app. Máquina, celular e plugins abriam cada um do
 * seu jeito — um como página inteira preta, outro como cartão de 860 px.
 */
export function Modal({
  title,
  onClose,
  width = 560,
  children,
}: {
  title: string;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className="qb-modal">
      <button
        type="button"
        aria-label={`Fechar ${title.toLowerCase()}`}
        className="qb-modal__backdrop"
        onClick={onClose}
      />
      <div
        className="qb-modal__card qb-pop-in"
        role="dialog"
        aria-label={title}
        style={{ width: `min(${width}px, calc(100vw - 48px))` }}
      >
        <div className="qb-modal__head">
          <span className="qb-modal__title">{title}</span>
          <button
            type="button"
            aria-label={`Fechar ${title.toLowerCase()}`}
            onClick={onClose}
            className="qb-modal__close"
          >
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="qb-modal__body">{children}</div>
      </div>
    </div>
  );
}
