import type { ComputerCatalogItem } from "@quibt/contracts";
import { useEffect, useState } from "react";
import { MachineGuide } from "../components/MachineGuide";
import { activateMachine, MachineCredentials, MachinePicker } from "../components/MachinePicker";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { errorMessage } from "../lib/rpc-errors";

export function HostComputerPrompt() {
  const desktop = desktopBridge();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ComputerCatalogItem[]>([]);
  const [selected, setSelected] = useState("docker");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostLabel =
    desktop?.platform === "darwin"
      ? "este Mac"
      : desktop?.platform === "win32"
        ? "este Windows"
        : desktop?.platform === "linux"
          ? "este Linux"
          : "este computador";

  useEffect(() => {
    if (!desktop) return;
    void Promise.all([
      rpc.me(),
      rpc.deployment.get().catch(() => null),
      rpc.computers.catalog({}).catch(() => []),
    ])
      .then(([me, deployment, catalog]) => {
        // Quem não instalou o Quibt aqui não escolhe a máquina: perguntar só
        // levaria a um "Forbidden" no clique.
        if (me.isDeploymentOwner && me.canChooseMachine && !deployment?.sandboxProvider) {
          setItems(catalog);
          setOpen(true);
        }
      })
      .catch(() => undefined);
  }, [desktop]);

  if (!open) return null;

  async function choose() {
    setPending(true);
    setError(null);
    try {
      await activateMachine({ kind: selected, endpoint, apiKey });
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível salvar essa escolha"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-[var(--qb-scrim)] px-6">
      <div className="max-h-[90vh] w-[520px] overflow-y-auto rounded-[var(--qb-r-xl)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] p-6">
        <h2 className="text-[var(--qb-t-title)] font-semibold text-[var(--qb-ink)]">
          Onde os bots devem rodar?
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--qb-muted)]">
          Em {hostLabel} o padrão é Docker. Toque numa opção e leia o quadro: o que instalar, onde
          copiar a chave e se os bots compartilham o computador. VPS, E2B e Box usam a sua conta — a
          Quibt não cobra a máquina.
        </p>
        <div className="mt-5">
          <MachinePicker
            items={items}
            selected={selected}
            onSelect={setSelected}
            disabled={pending}
          />
          <MachineCredentials
            item={items.find((item) => item.kind === selected)}
            recipes={items}
            endpoint={endpoint}
            apiKey={apiKey}
            onEndpoint={setEndpoint}
            onApiKey={setApiKey}
            onSelectRecipe={setSelected}
            disabled={pending}
          />
          <MachineGuide kind={selected} />
        </div>
        {error ? <p className="mt-3 text-sm text-[var(--qb-danger)]">{error}</p> : null}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => void choose()}
            className="qb-primary-button w-full disabled:opacity-40"
          >
            {pending ? "Salvando…" : "Usar esta máquina"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setOpen(false)}
            className="qb-secondary-button w-full disabled:opacity-40"
          >
            Decidir depois
          </button>
        </div>
      </div>
    </div>
  );
}
