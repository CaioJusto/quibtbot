import type { ComputerCatalogItem } from "@quibt/contracts";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MachineGuide } from "../components/MachineGuide";
import {
  activateMachine,
  MachineCredentials,
  MachinePicker,
  probeMachine,
} from "../components/MachinePicker";
import { QuibtCloudPanel } from "../components/QuibtCloudPanel";
import { machineCredentialsReady } from "../lib/onboarding-flow";
import { rpc } from "../lib/rpc";
import { errorMessage } from "../lib/rpc-errors";

export function MachineSettingsPage() {
  const navigate = useNavigate();
  return (
    <div className="qb-machine-page min-h-full px-6 py-8">
      <div className="mx-auto w-full max-w-[900px]">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-[var(--qb-t-sm)] text-[var(--qb-muted)] transition-colors hover:text-[var(--qb-ink)]"
        >
          ← Voltar
        </button>
        <div className="mt-5">
          <MachineSettingsBody />
        </div>
      </div>
    </div>
  );
}

/** O mesmo conteúdo na rota e no modal aberto pelo menu da conta. */
export function MachineSettingsBody() {
  const [items, setItems] = useState<ComputerCatalogItem[]>([]);
  const [selected, setSelected] = useState("docker");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [cloudSessionToken, setCloudSessionToken] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Só quem instalou o Quibt troca a máquina; para o resto a API responde FORBIDDEN. */
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    void Promise.all([
      rpc.computers.catalog({}).catch(() => []),
      rpc.deployment.get().catch(() => null),
      rpc.me(),
    ])
      .then(([catalog, deployment, me]) => {
        setItems(catalog);
        setSelected(deployment?.sandboxProvider ?? catalog[0]?.kind ?? "docker");
        setActive(deployment?.sandboxProvider ?? me.sandboxProvider ?? null);
        setEndpoint(deployment?.sandboxEndpoint ?? "");
        setIsOwner(me.isDeploymentOwner);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err, "Não foi possível carregar o catálogo"));
      });
  }, []);

  const item = items.find((entry) => entry.kind === selected);
  const effectiveApiKey = selected === "quibt-cloud" ? (cloudSessionToken ?? "") : apiKey;

  async function save() {
    const ready = machineCredentialsReady(item, { endpoint, apiKey: effectiveApiKey });
    if (!ready.ok) {
      setError(ready.message);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const settings = await activateMachine({
        kind: selected,
        endpoint,
        apiKey: effectiveApiKey,
      });
      setActive(settings.sandboxProvider);
      setApiKey("");
    } catch (err) {
      setError(errorMessage(err, "Não foi possível salvar a máquina"));
    } finally {
      setPending(false);
    }
  }

  async function test() {
    setPending(true);
    setError(null);
    try {
      const result = await probeMachine({ kind: selected, endpoint, apiKey: effectiveApiKey });
      setProbe(result.message);
      if (!result.ok) setError(result.message);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível testar a máquina"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="qb-machine-page">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[var(--qb-t-sm)] leading-[1.45] text-[var(--qb-muted)]">
          Instale, copie a chave e pronto. A Quibt não revende máquina.
        </p>
        {active ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--qb-hairline)] bg-[var(--qb-surface-2)] px-2.5 py-1 text-[11px] text-[var(--qb-muted)]">
            <span className="qb-live-dot h-1.5 w-1.5" />
            Em uso: {active}
          </span>
        ) : null}
      </div>

      {isOwner ? null : (
        // Sem este aviso, o clique voltava um "Forbidden" cru e sem saída.
        <p className="qb-onboarding__notice mt-4">
          O computador dos bots foi escolhido por quem instalou o Quibt aqui. Você usa o mesmo, e
          não precisa configurar nada.
        </p>
      )}

      <div className="mt-4">
        <MachinePicker
          items={items}
          selected={selected}
          onSelect={setSelected}
          disabled={pending}
        />
        <MachineCredentials
          item={item}
          recipes={items}
          endpoint={endpoint}
          apiKey={apiKey}
          onEndpoint={setEndpoint}
          onApiKey={setApiKey}
          onSelectRecipe={setSelected}
          disabled={pending}
        />
        {selected === "quibt-cloud" ? (
          <QuibtCloudPanel
            configured={item?.configured}
            disabled={pending}
            onSessionToken={setCloudSessionToken}
          />
        ) : null}
        <div className="mt-4">
          <MachineGuide kind={selected} />
        </div>
      </div>

      {probe ? (
        <p className="qb-machine-page__note mt-4 rounded-xl px-4 py-3 text-[13px]">{probe}</p>
      ) : null}
      {error ? (
        <p className="qb-machine-page__error mt-3 rounded-xl px-4 py-3 text-[13px]">{error}</p>
      ) : null}

      {isOwner ? (
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => void save()}
            className="qb-primary-button disabled:opacity-40"
          >
            {pending ? "Salvando…" : "Usar esta máquina"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void test()}
            className="qb-secondary-button disabled:opacity-40"
          >
            Testar
          </button>
        </div>
      ) : null}
    </div>
  );
}
