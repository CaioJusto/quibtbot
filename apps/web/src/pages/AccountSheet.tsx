import type { BillingSnapshot } from "@quibt/contracts";
import { displayPlanStatus, formatMeter, formatTokenBudget } from "@quibt/core";
import { Icon, MenuDivider, MenuItem } from "../components/desktop-ui";

export function AccountSheet({
  name,
  email,
  billing,
  billingBusy,
  billingError,
  usage,
  onLoadUsage,
  onPlugins,
  onCheckout,
  onPortal,
  onPlans,
  onMachine,
  onPhone,
  onProfile,
  onSignOut,
  onUninstall,
  image,
  onClose,
}: {
  name: string;
  email?: string;
  billing: BillingSnapshot | null;
  billingBusy: boolean;
  billingError: string | null;
  usage: { runs: number; inputTokens: number; outputTokens: number } | null;
  onLoadUsage: () => void;
  onPlugins: () => void;
  onCheckout: (planId: string) => void;
  onPortal: () => void;
  onPlans: () => void;
  onMachine: () => void;
  onPhone: () => void;
  onProfile: () => void;
  onSignOut: () => void;
  /** Só no app do desktop: o web não tem o que desinstalar. */
  onUninstall?: () => void;
  image?: string | null;
  onClose: () => void;
}) {
  const initial = name.trim().slice(0, 1).toUpperCase() || "U";
  const usageLabel = usage
    ? `${usage.runs} execuções`
    : billing
      ? formatMeter(billing.usage.tokens, billing.limits.tokensPerMonth, formatTokenBudget)
      : undefined;
  return (
    <div className="qb-account-layer">
      <button
        type="button"
        aria-label="Fechar conta"
        className="qb-account-backdrop"
        onClick={onClose}
      />
      {/* Mesmo desenho dos outros menus do app: linhas de uma altura só, sem cartões
          empilhados. O painel alto com descrições competia com a conversa. */}
      <div role="dialog" aria-label="Conta" className="qb-menu qb-account-popover qb-pop-in">
        <button type="button" onClick={onProfile} className="qb-account-popover__me">
          {image ? (
            <img
              className="qb-account-popover__avatar qb-account-popover__photo"
              src={image}
              alt=""
            />
          ) : (
            <span className="qb-account-popover__avatar">{initial}</span>
          )}
          <span className="min-w-0 flex-1">
            <span className="qb-account-popover__name">{name}</span>
            {email ? <span className="qb-account-popover__email">{email}</span> : null}
          </span>
          <Icon name="chevronRight" size={14} className="qb-menu__icon" />
        </button>

        <MenuDivider />

        <MenuItem icon="clock" label="Uso da semana" onClick={onLoadUsage} trailing={usageLabel} />
        <MenuItem icon="puzzle" label="Plugins" onClick={onPlugins} />
        <MenuItem icon="machine" label="Máquina" onClick={onMachine} />
        <MenuItem icon="phone" label="Celular" onClick={onPhone} />
        {billing?.enabled ? (
          <MenuItem
            icon="settings"
            label="Planos e cobrança"
            onClick={onPlans}
            trailing={`${billing.planName} · ${displayPlanStatus(billing.status)}`}
          />
        ) : null}

        {billing?.enabled
          ? billing.plans
              .slice(billing.plans.findIndex((plan) => plan.id === billing.planId) + 1)
              .map((plan) => (
                <MenuItem
                  key={plan.id}
                  icon="settings"
                  label={`Assinar ${plan.name}`}
                  disabled={billingBusy}
                  onClick={() => onCheckout(plan.id)}
                />
              ))
          : null}
        {billing?.enabled ? (
          <MenuItem
            icon="settings"
            label="Gerenciar cobrança"
            disabled={billingBusy}
            onClick={onPortal}
          />
        ) : null}

        {billingError ? <p className="qb-account-popover__error">{billingError}</p> : null}

        <MenuDivider />
        <MenuItem icon="logout" label="Sair" onClick={onSignOut} danger />
        {onUninstall ? (
          <MenuItem icon="trash" label="Desinstalar o Quibt…" onClick={onUninstall} danger />
        ) : null}
      </div>
    </div>
  );
}
