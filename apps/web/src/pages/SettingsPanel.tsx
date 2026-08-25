import { type ReactNode, useState } from "react";
import { Icon } from "../components/desktop-ui";
import { AccountSettingsBody } from "./Account";
import { MachineSettingsBody } from "./MachineSettings";
import { PhoneConnectBody } from "./PhoneConnect";

/** "models" é a Conta aberta direto na aba Modelo — o destino de "Conectar modelo". */
export type SettingsPage = "account" | "models" | "machine" | "phone";

const TITLES: Record<SettingsPage, string> = {
  account: "Conta",
  models: "Modelo",
  machine: "Máquina",
  phone: "Conectar o celular",
};

/**
 * Um painel só para as configurações, com subpáginas em pilha — o desenho dos ajustes
 * do iOS e da referência do Grok Bot. Antes cada item do menu da conta abria um
 * modal próprio, de 620 a 760 px, um por cima do outro; era modal dentro de modal, e
 * quem queria ir de Conta para Máquina fechava um e abria outro.
 */
export function SettingsPanel({
  initial,
  onClose,
  onSignedOut,
}: {
  initial: SettingsPage;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [stack, setStack] = useState<SettingsPage[]>([initial]);
  const page = stack[stack.length - 1] ?? initial;
  const canGoBack = stack.length > 1;
  const push = (next: SettingsPage) => setStack((current) => [...current, next]);
  const back = () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));

  return (
    <div className="qb-modal">
      <button
        type="button"
        aria-label="Fechar configurações"
        className="qb-modal__backdrop"
        onClick={onClose}
      />
      <div
        className="qb-modal__card qb-pop-in qb-settings-panel"
        role="dialog"
        aria-label={TITLES[page]}
      >
        <div className="qb-modal__head qb-settings-panel__head">
          {canGoBack ? (
            <button
              type="button"
              aria-label="Voltar"
              className="qb-settings-panel__back"
              onClick={back}
            >
              <Icon name="chevronRight" size={14} className="rotate-180" />
              <span>Voltar</span>
            </button>
          ) : (
            <span className="qb-settings-panel__spacer" />
          )}
          <span className="qb-modal__title">{TITLES[page]}</span>
          <button
            type="button"
            aria-label="Fechar configurações"
            className="qb-modal__close"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="qb-modal__body qb-settings-panel__body">
          <PanelPage
            key={page}
            page={page}
            onOpen={push}
            onSignedOut={onSignedOut}
            onDone={onClose}
          />
        </div>
      </div>
    </div>
  );
}

function PanelPage({
  page,
  onOpen,
  onSignedOut,
  onDone,
}: {
  page: SettingsPage;
  onOpen: (next: SettingsPage) => void;
  onSignedOut: () => void;
  /** A página terminou o que veio fazer (o celular entrou): o painel pode fechar. */
  onDone?: () => void;
}): ReactNode {
  if (page === "machine") return <MachineSettingsBody />;
  if (page === "phone") return <PhoneConnectBody onConnected={onDone} />;
  return (
    <>
      <AccountSettingsBody
        initialTab={page === "models" ? "models" : "profile"}
        onSignedOut={onSignedOut}
      />
      {/* Atalhos para as outras páginas do mesmo painel: `>` leva, "Voltar" traz. */}
      <div className="qb-settings-panel__links">
        <button type="button" className="qb-settings-panel__link" onClick={() => onOpen("machine")}>
          <span>Máquina</span>
          <Icon name="chevronRight" size={14} className="qb-menu__icon" />
        </button>
        <button type="button" className="qb-settings-panel__link" onClick={() => onOpen("phone")}>
          <span>Conectar o celular</span>
          <Icon name="chevronRight" size={14} className="qb-menu__icon" />
        </button>
      </div>
    </>
  );
}
