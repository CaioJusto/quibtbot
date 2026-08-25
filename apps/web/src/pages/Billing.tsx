import type { BillingSnapshot } from "@quibt/contracts";
import {
  catalogPlans,
  displayPlanName,
  displayPlanStatus,
  formatMeter,
  formatPlanPrice,
  formatTokenBudget,
  planHighlights,
} from "@quibt/core";
import { BotAvatar } from "@quibt/ui-web";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { billingReturnUrls, openBillingUrl } from "../lib/billing-url";
import { rpc } from "../lib/rpc";

type PlanCard = BillingSnapshot["plans"][number];

const CHARACTERS = [
  { name: "FINN", color: "#111316", shape: "grok" },
  { name: "Sinclair", color: "#E6855C", shape: "freddy" },
  { name: "Cecil", color: "#55B6C3", shape: "nova" },
  { name: "Ada", color: "#E69A5C", shape: "sunee" },
];

export function BillingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(() => {
    const state = location.state as { checkoutError?: unknown } | null;
    return typeof state?.checkoutError === "string" ? state.checkoutError : null;
  });
  const notice = params.get("billing");
  const fromApp = params.get("app") === "1";

  useEffect(() => {
    void rpc.billing
      .get()
      .then(setBilling)
      .catch(() => setBilling(null));
  }, []);

  async function subscribe(planId: string) {
    setBusy(planId);
    setError(null);
    setCheckoutNotice(null);
    try {
      const { url } = await rpc.billing.checkout({ planId, ...billingReturnUrls() });
      openBillingUrl(url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "O checkout do Stripe não está configurado neste deploy.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function portal() {
    setBusy("portal");
    setError(null);
    try {
      const { url } = await rpc.billing.portal();
      openBillingUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível abrir o portal de cobrança");
    } finally {
      setBusy(null);
    }
  }

  // The server is the source of truth for what this deploy sells; the core
  // catalog is only the fallback while the snapshot is still loading.
  const plans: PlanCard[] = billing?.plans ?? catalogPlans();

  if (billing && !billing.enabled) {
    return <Navigate to="/settings/machine" replace />;
  }

  return (
    <div className="qb-settings-page min-h-full bg-black px-6 py-12 text-[var(--qb-ink)]">
      <div className="mx-auto w-full max-w-[920px]">
        <button type="button" onClick={() => navigate("/app")} className="qb-settings-back">
          ← Voltar à inbox
        </button>
        <header className="qb-settings-simple-hero mt-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="qb-kicker">Plano e uso</span>
            <h1 className="text-[32px] font-semibold tracking-tight">Assinatura</h1>
            <p className="mt-2 max-w-[520px] text-[16px] text-[var(--qb-muted)]">
              O trial é grátis. Starter e Pro passam pelo Stripe. As chaves do modelo continuam
              suas.
            </p>
          </div>
          <div className="flex -space-x-2">
            {CHARACTERS.map((bot) => (
              <BotAvatar key={bot.name} color={bot.color} shape={bot.shape} size={40} />
            ))}
          </div>
        </header>
        {fromApp ? (
          <a
            href={`quibt://billing?billing=${notice ?? "success"}`}
            className="mt-6 block rounded-[12px] bg-[var(--qb-ink-strong)] px-4 py-3 text-center text-[15px] font-semibold text-[var(--qb-ink)]"
          >
            Voltar ao app
          </a>
        ) : null}
        {notice === "success" ? (
          <p className="mt-6 rounded-[12px] bg-[#132A1C] px-4 py-3 text-[15px] text-[#30D158]">
            O Stripe confirmou a assinatura. O plano do workspace atualiza assim que o webhook
            chegar.
          </p>
        ) : null}
        {notice === "canceled" ? (
          <p className="mt-6 rounded-[12px] bg-[var(--qb-surface-2)] px-4 py-3 text-[15px] text-[var(--qb-muted)]">
            O checkout foi cancelado. Você continua no {billing?.planName ?? "Trial"}.
          </p>
        ) : null}
        {billing ? (
          <div className="mt-6">
            <p className="text-[15px] text-[var(--qb-muted)]">
              Plano atual:{" "}
              <span className="text-[var(--qb-ink)]">
                {displayPlanName(billing)} · {displayPlanStatus(billing.status)}
              </span>
              {billing.enabled ? null : " · Stripe ainda não está ligado neste servidor"}
            </p>
            <dl className="mt-4 grid gap-3 sm:grid-cols-3">
              <Meter label="Bots" value={formatMeter(billing.usage.bots, billing.limits.maxBots)} />
              <Meter
                label="Tokens no período"
                value={formatMeter(
                  billing.usage.tokens,
                  billing.limits.tokensPerMonth,
                  formatTokenBudget,
                )}
              />
              <Meter
                label="Computador"
                value={formatMeter(
                  Math.round(billing.usage.computerMinutes / 60),
                  billing.limits.computerMinutesPerMonth === null
                    ? null
                    : billing.limits.computerMinutesPerMonth / 60,
                  (n) => `${n}h`,
                )}
              />
            </dl>
          </div>
        ) : null}
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {plans.map((plan) => (
            <PlanColumn
              key={plan.id}
              plan={plan}
              current={billing?.planId === plan.id}
              enabled={Boolean(billing?.enabled)}
              busy={busy}
              onSubscribe={() => void subscribe(plan.id)}
            />
          ))}
        </div>
        {checkoutNotice ? <p className="mt-4 text-sm text-[#FF9F0A]">{checkoutNotice}</p> : null}
        {error ? <p className="mt-4 text-sm text-[var(--qb-danger)]">{error}</p> : null}
        {billing?.enabled ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void portal()}
            className="mt-8 text-[15px] text-[var(--qb-muted)] disabled:opacity-50"
          >
            Gerenciar cobrança no Stripe
          </button>
        ) : (
          <p className="mt-8 text-[14px] text-[var(--qb-muted)]">
            O checkout pago precisa de <code>BILLING_ENABLED=true</code> e dos price ids do Stripe.{" "}
            <Link to="/account" className="text-[var(--qb-ink)]">
              Ver a conta
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div className="qb-settings-meter rounded-[12px] bg-[var(--qb-surface-2)] px-4 py-3">
      <dt className="text-[12px] tracking-wide text-[var(--qb-muted)] uppercase">{label}</dt>
      <dd className="mt-1 text-[17px] font-semibold text-[var(--qb-ink)]">{value}</dd>
    </div>
  );
}

function PlanColumn({
  plan,
  current,
  enabled,
  busy,
  onSubscribe,
}: {
  plan: PlanCard;
  current: boolean;
  enabled: boolean;
  busy: string | null;
  onSubscribe: () => void;
}) {
  const paid = plan.priceUsd > 0;
  return (
    <article
      className="qb-plan-column flex flex-col rounded-[18px] border p-5"
      style={{ borderColor: current ? "#5B7FE5" : "#DEDEE1" }}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[20px] font-semibold">{plan.name}</h2>
        {current ? <span className="text-[12px] text-[var(--qb-accent)]">Atual</span> : null}
      </div>
      <p className="mt-2 text-[28px] font-semibold tracking-tight">
        {formatPlanPrice(plan)}
        {paid ? (
          <span className="text-[15px] font-normal text-[var(--qb-muted)]"> / mês</span>
        ) : null}
      </p>
      <ul className="mt-4 flex-1 space-y-1.5 text-[14px] text-[var(--qb-muted)]">
        {planHighlights(plan).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {paid ? (
        <button
          type="button"
          disabled={!enabled || current || busy !== null}
          onClick={onSubscribe}
          className="mt-5 rounded-full bg-[var(--qb-ink-strong)] py-2.5 text-[15px] font-semibold text-[var(--qb-canvas)] disabled:opacity-40"
        >
          {busy === plan.id
            ? "Abrindo o Stripe…"
            : current
              ? "Plano atual"
              : `Assinar ${plan.name}`}
        </button>
      ) : (
        <p className="mt-5 text-[13px] text-[var(--qb-muted)]">Incluso ao criar a conta.</p>
      )}
    </article>
  );
}
