import type { BillingSnapshot, ComputerCatalogItem } from "@quibt/contracts";
import {
  catalogPlans,
  formatPlanPrice,
  machineStepNeeded,
  type Plan,
  parseOssMachine,
  planHighlights,
  type QuibtEdition,
  startPolling,
} from "@quibt/core";
import { formatAppearance, type MarkShape } from "@quibt/ui-tokens";
import { BotAvatar, CharacterPicker } from "@quibt/ui-web";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { MachineGuide } from "../components/MachineGuide";
import {
  activateMachine,
  MachineCredentials,
  MachinePicker,
  probeMachine,
} from "../components/MachinePicker";
import { billingReturnUrls, openBillingUrl } from "../lib/billing-url";
import {
  chooseMode,
  chooseProvider,
  chosenMachineMatches,
  localModelUrl,
  machineCredentialsReady,
  machineNotice,
  modelSaveAction,
  providersForMode,
  resolveOnboardingFlow,
  type TokenSource,
} from "../lib/onboarding-flow";
import { rpc } from "../lib/rpc";
import { errorMessage } from "../lib/rpc-errors";

const switchModelsToPlan = rpc.models.usePlan;

// O catálogo do Pi descreve a cobrança em inglês. O produto é todo em português.
const BILLING_PT: Record<string, string> = {
  "openai-codex":
    "Entre com ChatGPT Plus ou Pro. O uso sai da sua assinatura OpenAI — a Quibt não paga.",
  anthropic: "Entre com a sua assinatura Claude. O uso sai dela — a Quibt não paga.",
  "github-copilot": "Entre com a sua assinatura GitHub Copilot. O uso sai dela — a Quibt não paga.",
  xai: "Entre com a sua assinatura SuperGrok. O uso sai dela — a Quibt não paga.",
  "kimi-for-coding":
    "Entre com a sua assinatura Kimi For Coding. O uso sai dela — a Quibt não paga.",
  openrouter: "Cole a sua chave OpenRouter. O uso sai da sua conta — a Quibt não paga.",
};

function billingText(entry: CatalogEntry | undefined): string {
  if (!entry) return "";
  const mapped = BILLING_PT[entry.provider];
  if (mapped) return mapped;
  return entry.subscription
    ? "Entre com a assinatura que você já tem. O uso sai dela — a Quibt não paga."
    : "Cole a chave da sua conta. O uso sai dela — a Quibt não paga.";
}

const PRESETS: Array<{ name: string; title: string; color: string; shape: MarkShape }> = [
  { name: "Quib", title: "Assistente", color: "#5B7FE5", shape: "strobi" },
  { name: "FINN", title: "Eng", color: "#8B5CF6", shape: "cubee" },
  { name: "Sinclair", title: "Pesquisa", color: "#14B8A6", shape: "nova" },
  { name: "Cecil", title: "Operações", color: "#F59E0B", shape: "onee" },
  { name: "Chief", title: "Chief of staff", color: "#5B7FE5", shape: "onee" },
];

type CatalogEntry = {
  provider: string;
  providerName?: string;
  id: string;
  label: string;
  billing: string;
  auth?: "api-key" | "oauth" | "both";
  oauthLabel?: string;
  subscription?: boolean;
  signIn?: "device-code";
};

type OAuthFlow =
  | { state: "idle" }
  | { state: "waiting"; loginId: string; userCode: string; verificationUri: string }
  | { state: "connected"; label: string }
  | { state: "error"; error: string };

function resetOnboardingScroll(element: HTMLElement | null): void {
  if (element) element.scrollTop = 0;
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const stageRef = useRef<HTMLElement>(null);
  const loadRequestRef = useRef(0);
  // Sem telas de introdução: o que o produto faz já ficou na tela de entrada. Aqui são
  // só as decisões que o primeiro bot precisa — modelo, (máquina) e quem ele é.
  const [step, setStep] = useState<"loading" | "plan" | "model" | "machine" | "bot">("loading");
  const [edition, setEdition] = useState<QuibtEdition>("oss");
  const [canChooseMachine, setCanChooseMachine] = useState(true);
  const [availableMachines, setAvailableMachines] = useState<string[]>(["docker"]);
  const [machineCatalog, setMachineCatalog] = useState<ComputerCatalogItem[]>([]);
  const [machine, setMachine] = useState("docker");
  const [machineEndpoint, setMachineEndpoint] = useState("");
  const [machineKey, setMachineKey] = useState("");
  const [runningSandbox, setRunningSandbox] = useState("docker");
  const [savedMachine, setSavedMachine] = useState<string | null>(null);
  const [savingMachine, setSavingMachine] = useState(false);
  const [machineProbe, setMachineProbe] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("deepseek/deepseek-v4-flash-0731");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("Quib");
  const [title, setTitle] = useState("Assistente");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#5B7FE5");
  const [shape, setShape] = useState<MarkShape>("strobi");
  const [planId, setPlanId] = useState("trial");
  const [billing, setBilling] = useState<BillingSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tokenSource, setTokenSource] = useState<TokenSource>("key");
  const [oauthFlow, setOauthFlow] = useState<OAuthFlow>({ state: "idle" });
  const [loadFailed, setLoadFailed] = useState(false);
  /** Assinaturas que esta conta já conectou antes: não faz sentido pedir login de novo. */
  const [connectedProviders, setConnectedProviders] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    const requestId = ++loadRequestRef.current;
    setError(null);
    setLoadFailed(false);
    return Promise.all([
      rpc.me(),
      rpc.health().catch(() => null),
      rpc.models.list().catch(() => []),
      rpc.billing.get().catch(() => null),
      rpc.deployment.get().catch(() => null),
      rpc.computers.catalog({}).catch(() => []),
      rpc.models.credentials().catch(() => []),
    ])
      .then(([me, health, models, snap, deployment, machines, credentials]) => {
        if (requestId !== loadRequestRef.current) return;
        const flow = resolveOnboardingFlow({ health, me, billing: snap });
        setEdition(flow.edition);
        setCanChooseMachine(flow.canChooseMachine);
        setAvailableMachines(
          machines.length ? machines.map((item) => item.kind) : flow.availableMachines,
        );
        setMachineCatalog(machines);
        setRunningSandbox(flow.runningSandbox);
        setSavedMachine(deployment?.sandboxProvider ?? null);
        const chosen = deployment?.sandboxProvider ?? parseOssMachine(flow.runningSandbox);
        if (chosen) setMachine(chosen);
        setIsOwner(me.isDeploymentOwner);
        setCatalog(models);
        setBilling(snap);
        const preferred =
          models.find(
            (entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel,
          ) ??
          models.find((entry) => entry.provider === me.defaultProvider) ??
          models[0];
        if (preferred) {
          setProvider(preferred.provider);
          setModelId(preferred.id);
        }
        // O cartão marcado tem de bater com o provedor que a lista já mostra: começar em
        // "Chave OpenRouter" com um provedor de assinatura selecionado confunde.
        setTokenSource(
          preferred?.subscription || preferred?.signIn === "device-code"
            ? "subscription"
            : flow.tokenSource,
        );
        setConnectedProviders(new Set(credentials.map((entry) => entry.provider)));
        setStep(flow.firstStep);
      })
      .catch(() => {
        if (requestId !== loadRequestRef.current) return;
        // A dead end here would trap the account on a blank step: say so and offer another try.
        setLoadFailed(true);
        setError("Não foi possível carregar sua conta. Verifique a conexão e tente de novo.");
        setStep("model");
      });
  }, []);

  useEffect(() => {
    const requested = params.get("plan") ?? sessionStorage.getItem("quibt.plan") ?? "trial";
    if (requested) setPlanId(requested);
    void load();
  }, [params, load]);

  // The model catalog is intentionally scrollable. Without resetting that scroll when the
  // step changes, the next screen can open halfway down with its heading outside the viewport.
  useLayoutEffect(() => {
    resetOnboardingScroll(stageRef.current);
  }, [step]);

  const providers = useMemo(() => {
    const seen = new Map<string, CatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return [...seen.values()];
  }, [catalog]);

  /** Só os provedores que o cartão marcado aceita: é o que o campo Provedor lista. */
  const providerOptions = useMemo(
    () => providersForMode(providers, tokenSource),
    [providers, tokenSource],
  );

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const acceptsKey = selected?.auth !== "oauth";
  // Continuar sem concluir o login gravaria um provedor sem credencial e o primeiro
  // recado do bot viraria "provider is not configured".
  const alreadyConnected = Boolean(selected && connectedProviders.has(selected.provider));
  const needsSignInFirst =
    selected?.signIn === "device-code" && oauthFlow.state !== "connected" && !alreadyConnected;
  const plans = catalogPlans();

  function pickProvider(nextProvider: string) {
    // A key pasted for one provider must never travel to the next one.
    const next = chooseProvider({ provider, modelId, apiKey }, catalog, nextProvider);
    setProvider(next.provider);
    setModelId(next.modelId);
    setApiKey(next.apiKey);
  }

  function pickTokenSource(next: TokenSource) {
    setTokenSource(next);
    setError(null);
    const fixed = chooseMode({ provider, modelId, apiKey }, catalog, next);
    setProvider(fixed.provider);
    setModelId(fixed.modelId);
    setApiKey(next === "local" && !fixed.apiKey ? localModelUrl(fixed.provider) : fixed.apiKey);
  }

  /**
   * Docker ainda mostra o passo: o dono confirma "Nesta máquina (Docker)" em vez de
   * pular Modelo → Bot sem ver o computador. Box/E2B já escolhidos pulam.
   */
  function nextStepAfterModel(): "machine" | "bot" {
    return canChooseMachine && isOwner && machineStepNeeded({ sandbox: runningSandbox })
      ? "machine"
      : "bot";
  }

  async function saveModel() {
    if (savingModel) return;
    setError(null);
    const action = modelSaveAction({
      tokenSource,
      apiKey,
      acceptsKey,
      needsSignIn: selected?.signIn === "device-code",
      // Uma assinatura já conectada nesta conta vale como login: pedir de novo só
      // trava quem já passou por isso antes.
      signedIn: oauthFlow.state === "connected" || alreadyConnected,
    });
    if (action.kind === "blocked") {
      // Moving on without saving anything would look like it worked. Say what is missing.
      setError(action.message);
      return;
    }
    setSavingModel(true);
    try {
      if (action.kind === "plan") {
        await switchModelsToPlan();
      } else {
        if (action.kind === "connect") {
          await rpc.models.connect({
            provider,
            apiKey,
            modelId,
            label: selected?.providerName ?? provider,
          });
        }
        await rpc.models.setDefault({ provider, modelId });
      }
      setStep(nextStepAfterModel());
    } catch (err) {
      setError(errorMessage(err, "Não foi possível salvar o modelo"));
    } finally {
      setSavingModel(false);
    }
  }

  async function beginSubscriptionSignIn(entry: CatalogEntry) {
    setError(null);
    setOauthFlow({ state: "idle" });
    try {
      const begun = await rpc.models.beginOAuth({
        provider: entry.provider,
        modelId: entry.id,
        // O rótulo vira o nome da credencial salva: use o provedor, não o texto do botão.
        label: entry.providerName ?? entry.provider,
      });
      setOauthFlow({
        state: "waiting",
        loginId: begun.loginId,
        userCode: begun.userCode,
        verificationUri: begun.verificationUri,
      });
    } catch (err) {
      setOauthFlow({
        state: "error",
        error: errorMessage(err, "Não foi possível iniciar o login"),
      });
    }
  }

  useEffect(() => {
    if (oauthFlow.state !== "waiting") return;
    const loginId = oauthFlow.loginId;
    return startPolling(
      async () => {
        const result = await rpc.models.completeOAuth({ loginId });
        if (result.status === "connected") {
          setOauthFlow({ state: "connected", label: result.credential.label });
        } else if (result.status === "error") {
          setOauthFlow({ state: "error", error: result.error });
        }
      },
      3000,
      {
        onError: (err) =>
          setOauthFlow({
            state: "error",
            error: errorMessage(err, "Não foi possível concluir o login"),
          }),
      },
    );
  }, [oauthFlow]);

  function applyPreset(preset: (typeof PRESETS)[number]) {
    setName(preset.name);
    setTitle(preset.title);
    setColor(preset.color);
    setShape(preset.shape);
  }

  async function createBot() {
    if (creating) return;
    setCreating(true);
    setError(null);
    const chief =
      title.toLowerCase().includes("chief of staff") || name.trim() === "Chief"
        ? "You are the workspace Chief of Staff. Coordinate other bots instead of doing specialist work yourself when a teammate is a better fit. Use spawn_bot only when the user asked for a lasting new bot."
        : "";
    // Sem roteiro de "primeira conversa" nas instruções: gravado ali ele virava regra
    // permanente, e o bot ficava perguntando "o que você quer delegar?" a quem pedia um
    // print. Um pedido direto tem que ser atendido na hora; a apresentação é do produto.
    const instructions = [chief, description].filter(Boolean).join("\n\n");
    try {
      const bot = await rpc.bots.create({
        name: name.trim(),
        title,
        description,
        instructions,
        notifyOnFinish: true,
        color: formatAppearance({ color, shape }),
        shape,
      });
      if (planId !== "trial" && billing?.enabled) {
        try {
          const { url } = await rpc.billing.checkout({ planId, ...billingReturnUrls() });
          // In the desktop app checkout opens in the system browser, so the bot's thread
          // is still the right place to land while Stripe finishes.
          if (openBillingUrl(url)) navigate(`/app/${bot.id}`);
          return;
        } catch (checkoutError) {
          navigate("/billing", {
            replace: true,
            state: {
              checkoutError: `Seu bot foi criado, mas o checkout não abriu: ${
                checkoutError instanceof Error ? checkoutError.message : "tente novamente abaixo"
              }`,
            },
          });
          return;
        }
      }
      navigate(`/app/${bot.id}`);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível criar este bot"));
    } finally {
      setCreating(false);
    }
  }

  const selectedMachine =
    machineCatalog.find((item) => item.kind === machine) ??
    (machine === "docker"
      ? {
          kind: "docker",
          family: "docker",
          title: "Nesta máquina (Docker)",
          body: "",
          category: "local" as const,
          needsKey: false,
          needsEndpoint: false,
          needsDocker: true,
          ready: true,
          configured: true,
          searchable: ["docker"],
        }
      : undefined);

  async function saveMachine() {
    if (savingMachine) return;
    const ready = machineCredentialsReady(selectedMachine, {
      endpoint: machineEndpoint,
      apiKey: machineKey,
    });
    if (!ready.ok) {
      setError(ready.message);
      return;
    }
    setSavingMachine(true);
    setError(null);
    try {
      const settings = await activateMachine({
        kind: machine,
        endpoint: machineEndpoint,
        apiKey: machineKey,
      });
      // Trust the write response, not the click: this is what the deploy really has now.
      setSavedMachine(settings.sandboxProvider);
      const health = await rpc.health().catch(() => null);
      const running = health?.sandbox ?? runningSandbox;
      setRunningSandbox(running);
      // Only leave the screen once the API says the chosen machine is the one running.
      if (
        chosenMachineMatches(settings.sandboxProvider, machine) &&
        running === settings.sandboxProvider
      ) {
        setStep("bot");
      }
    } catch (err) {
      setError(errorMessage(err, "Não foi possível salvar a máquina"));
    } finally {
      setSavingMachine(false);
    }
  }

  async function testMachine() {
    if (savingMachine) return;
    setSavingMachine(true);
    setError(null);
    try {
      const result = await probeMachine({
        kind: machine,
        endpoint: machineEndpoint,
        apiKey: machineKey,
      });
      setMachineProbe(result.message);
      if (!result.ok) setError(result.message);
    } catch (err) {
      setError(errorMessage(err, "Não foi possível testar a máquina"));
    } finally {
      setSavingMachine(false);
    }
  }

  const notice = machineNotice({ chosen: machine, running: runningSandbox, saved: savedMachine });
  const machineStep = canChooseMachine && isOwner && machineStepNeeded({ sandbox: runningSandbox });

  return (
    <div className="qb-onboarding qb-onboarding-flow">
      <header className="qb-onboarding-intro__header">
        <div className="qb-onboarding-intro__wordmark">
          <BotAvatar color="#5B7FE5" shape="strobi" size={34} />
          <span>Quibt Bot</span>
        </div>
        <OnboardingProgress
          position={flowPosition(step, machineStep, edition)}
          total={flowLength(edition, machineStep)}
        />
      </header>
      <main ref={stageRef} className="qb-onboarding-flow__stage">
        {step === "loading" ? <p className="text-[var(--qb-muted)]">Carregando…</p> : null}
        {step === "plan" ? (
          <div>
            <p className="qb-kicker">Comece do seu jeito</p>
            <h1 className="mt-3 text-[var(--qb-ink)]">
              Escolha o plano. O agente vem logo depois.
            </h1>
            <p className="mt-2 text-[var(--qb-muted)]">
              Durante o beta você pode entrar grátis e sem cartão. Nenhuma chave de API é necessária
              — o Quibt cuida do modelo para você.
            </p>
            <div className="mt-8 grid gap-3 md:grid-cols-3">
              {plans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  selected={planId === plan.id}
                  onSelect={() => setPlanId(plan.id)}
                />
              ))}
            </div>
          </div>
        ) : null}
        {step === "model" ? (
          <div>
            <h1 className="text-[var(--qb-ink)]">
              {edition === "cloud" ? "Como pagar pelos modelos?" : "Qual modelo seus bots usam?"}
            </h1>
            <p className="mt-3 max-w-[620px] text-[15.5px] leading-[1.55] text-[var(--qb-muted)]">
              {edition === "cloud"
                ? "Tokens do plano, a sua chave OpenRouter ou a assinatura que você já tem."
                : "Você paga o modelo direto a quem o faz. A Quibt não cobra tokens."}
            </p>
            <div className="mt-7 grid gap-3 md:grid-cols-3">
              {edition === "cloud" ? (
                <TokenCard
                  selected={tokenSource === "plan"}
                  source="plan"
                  title="Tokens Quibt"
                  body="Cota mensal do plano, sem chave para configurar."
                  onSelect={() => pickTokenSource("plan")}
                />
              ) : null}
              <TokenCard
                selected={tokenSource === "key"}
                source="key"
                title="Chave OpenRouter"
                body="Uma chave, centenas de modelos."
                onSelect={() => pickTokenSource("key")}
              />
              {edition === "oss" ? (
                <TokenCard
                  selected={tokenSource === "local"}
                  source="local"
                  title="Modelo local"
                  body="Ollama ou LM Studio. Nada sai daqui."
                  onSelect={() => pickTokenSource("local")}
                />
              ) : null}
              <TokenCard
                selected={tokenSource === "subscription"}
                source="subscription"
                title="Minha assinatura"
                body="ChatGPT, Claude, Copilot ou SuperGrok."
                onSelect={() => pickTokenSource("subscription")}
              />
            </div>
            {/* Um painel só, com o que muda conforme o cartão marcado. A busca e a lista
                rolável de provedores saíram: com o modo escolhido, o que resta cabe em
                dois campos, e rolar dentro de uma etapa que já rola era o pior dos dois. */}
            {tokenSource === "key" || tokenSource === "subscription" || tokenSource === "local" ? (
              <div className="mt-5 rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-5 pt-4 pb-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block text-[var(--qb-t-xs)] text-[var(--qb-muted)]">
                    Provedor
                    <select
                      value={provider}
                      onChange={(e) => pickProvider(e.target.value)}
                      className="mt-1.5 h-11 w-full rounded-[var(--qb-r-sm)] px-3 text-[var(--qb-t-lg)] text-[var(--qb-ink)]"
                    >
                      {providerOptions.map((entry) => (
                        <option key={entry.provider} value={entry.provider}>
                          {entry.providerName ?? entry.provider}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-[var(--qb-t-xs)] text-[var(--qb-muted)]">
                    Modelo
                    <select
                      value={selected?.id ?? modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      className="mt-1.5 h-11 w-full rounded-[var(--qb-r-sm)] px-3 text-[var(--qb-t-lg)] text-[var(--qb-ink)]"
                    >
                      {modelsForProvider.map((entry) => (
                        <option key={`${entry.provider}:${entry.id}`} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {selected?.signIn === "device-code" ? (
                  <div
                    className={
                      oauthFlow.state === "idle"
                        ? "mt-4"
                        : "mt-4 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] px-4 py-4"
                    }
                  >
                    {oauthFlow.state === "connected" ? (
                      <p className="text-[15px] text-[#2C8A4B]">
                        Conectado como {oauthFlow.label}. O uso sai da sua assinatura.
                      </p>
                    ) : oauthFlow.state === "waiting" ? (
                      <div>
                        <p className="text-[15px] text-[var(--qb-ink)]">
                          Abra{" "}
                          <a
                            href={oauthFlow.verificationUri}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--qb-accent)] underline"
                          >
                            {oauthFlow.verificationUri}
                          </a>{" "}
                          e digite o código:
                        </p>
                        <p className="rk-mono mt-2 text-[24px] tracking-[4px] text-[var(--qb-ink)]">
                          {oauthFlow.userCode}
                        </p>
                        <p className="mt-2 text-[13px] text-[var(--qb-muted)]">
                          Aguardando confirmação… esta tela atualiza sozinha.
                        </p>
                      </div>
                    ) : (
                      <div>
                        {alreadyConnected ? (
                          <p className="mb-3 text-[14px] text-[#3E9B57]">
                            Esta assinatura já está conectada nesta conta.
                          </p>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => selected && void beginSubscriptionSignIn(selected)}
                          className="rounded-full bg-[var(--qb-ink-strong)] px-5 py-2.5 font-semibold text-[var(--qb-canvas)]"
                        >
                          {alreadyConnected
                            ? "Entrar de novo"
                            : (selected?.oauthLabel ?? "Entrar com assinatura")}
                        </button>
                        {oauthFlow.state === "error" ? (
                          <p className="mt-3 text-sm text-[#E65707]">{oauthFlow.error}</p>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
                {acceptsKey ? (
                  <label className="mt-4 block text-[var(--qb-t-xs)] text-[var(--qb-muted)]">
                    {tokenSource === "local" ? "URL do modelo" : "Chave de API"}
                    <input
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={tokenSource === "local" ? localModelUrl(provider) : "sk-…"}
                      type={tokenSource === "local" ? "url" : "password"}
                      className="mt-1.5 h-11 w-full rounded-[var(--qb-r-sm)] px-3 text-[var(--qb-t-lg)] text-[var(--qb-ink)]"
                    />
                  </label>
                ) : selected?.signIn === "device-code" ? null : (
                  <p className="mt-4 text-[13px] leading-[1.45] text-[var(--qb-muted)]">
                    {selected?.oauthLabel ?? selected?.providerName ?? provider} usa OAuth ou
                    assinatura. O Pi cuida desse login. Pule se este deploy já tiver credenciais.
                  </p>
                )}
                <p className="mt-3.5 flex items-start gap-2 text-[13px] leading-[1.45] text-[var(--qb-muted)]">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="var(--qb-muted-2)"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="mt-[2px] shrink-0"
                    aria-hidden="true"
                  >
                    <rect x="4" y="8.6" width="12" height="8" rx="2" />
                    <path d="M7 8.6V6.4a3 3 0 0 1 6 0v2.2" />
                  </svg>
                  {billingText(selected)}
                </p>
              </div>
            ) : null}
            {error ? <p className="mt-3 text-sm text-[#E65707]">{error}</p> : null}
          </div>
        ) : null}

        {step === "machine" ? (
          <div>
            <h1 className="text-[var(--qb-ink)]">Onde o computador dos bots roda?</h1>
            <p className="mt-3 max-w-[620px] text-[15.5px] leading-[1.55] text-[var(--qb-muted)]">
              Um Linux de verdade, com tela e navegador. O quadro abaixo diz o que instalar e o que
              custa.
            </p>
            {runningSandbox === "docker" ? (
              <p className="qb-onboarding__notice mt-4">
                Docker neste aparelho. Os bots usam o computador deste install — confirme ou escolha
                outra máquina.
              </p>
            ) : null}
            {isOwner ? null : (
              // Trocar a máquina é do dono do install. Sem este aviso, o clique
              // voltava um "Forbidden" cru no meio do onboarding.
              <p className="qb-onboarding__notice mt-4">
                O computador dos bots já foi escolhido por quem instalou o Quibt aqui. Você usa o
                mesmo, e não precisa configurar nada.
              </p>
            )}
            <div className="mt-6">
              <MachinePicker
                items={
                  machineCatalog.length
                    ? machineCatalog
                    : availableMachines.map((kind) => ({
                        kind,
                        family: kind,
                        title: kind,
                        body: "",
                        category: "local" as const,
                        needsKey: false,
                        needsEndpoint: false,
                        needsDocker: kind === "docker",
                        ready: true,
                        configured: false,
                        searchable: [kind],
                      }))
                }
                selected={machine}
                onSelect={(kind) => {
                  setMachine(kind);
                  setMachineProbe(null);
                  setError(null);
                }}
                disabled={savingMachine}
              />
              <MachineCredentials
                item={selectedMachine}
                recipes={machineCatalog}
                endpoint={machineEndpoint}
                apiKey={machineKey}
                onEndpoint={setMachineEndpoint}
                onApiKey={setMachineKey}
                onSelectRecipe={(kind) => {
                  setMachine(kind);
                  setMachineProbe(null);
                }}
                disabled={savingMachine}
              />
              <MachineGuide kind={machine} />
            </div>
            {machineProbe ? (
              <p className="mt-4 text-[13px] text-[var(--qb-muted)]">{machineProbe}</p>
            ) : null}
            {notice ? (
              <p
                className="mt-4 text-[13px]"
                style={{
                  color:
                    notice.tone === "ok"
                      ? "#4ECB71"
                      : notice.tone === "warn"
                        ? "#C9A227"
                        : "#85858A",
                }}
              >
                {notice.text}
              </p>
            ) : null}
            {error ? <p className="mt-3 text-sm text-[#E65707]">{error}</p> : null}
          </div>
        ) : null}

        {step === "bot" ? (
          <div>
            <h1 className="text-[var(--qb-ink)]">Crie seu primeiro bot.</h1>
            <p className="mt-3 max-w-[600px] text-[15.5px] leading-[1.55] text-[var(--qb-muted)]">
              Um nome e uma função bastam. O resto ele aprende conversando.
            </p>
            {/* Duas colunas: de um lado quem ele é, do outro o que se escreve sobre ele.
                Empilhado, a etapa passava de mil pixels e pedia rolagem para tudo. */}
            <div className="mt-7 grid gap-7 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
              <div>
                <div className="flex flex-col items-center gap-1.5 rounded-[var(--qb-r-xl)] bg-[var(--qb-surface-2)] px-4 py-6">
                  <BotAvatar
                    color={color}
                    shape={shape}
                    size={96}
                    online
                    title={name || "Seu agente"}
                  />
                  <span className="mt-1 text-[17px] font-semibold text-[var(--qb-ink)]">
                    {name || "Seu agente"}
                  </span>
                  <span className="text-[var(--qb-t-sm)] text-[var(--qb-muted)]">
                    {title || "Escolha uma função"}
                  </span>
                </div>
                <p className="mt-5 mb-2 text-[var(--qb-t-sm)] text-[var(--qb-muted)]">
                  Comece por um pronto
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      aria-label={`${preset.name}, ${preset.title}`}
                      onClick={() => applyPreset(preset)}
                      className={`flex items-center gap-2 rounded-[var(--qb-r-md)] px-2.5 py-2 text-left transition-colors ${
                        name === preset.name
                          ? "bg-[var(--qb-inset)]"
                          : "bg-[var(--qb-surface-2)] hover:bg-[var(--qb-inset)]"
                      }`}
                    >
                      <BotAvatar color={preset.color} shape={preset.shape} size={26} />
                      {/* Só o nome: a função de cada um aparece inteira no cartão de cima,
                          e aqui ela só cabia cortada pela metade. */}
                      <span className="min-w-0 truncate text-[var(--qb-t-sm)] font-semibold text-[var(--qb-ink)]">
                        {preset.name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[var(--qb-t-sm)] text-[var(--qb-muted)]">
                  Nome
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Como ele vai se chamar?"
                    className="mt-1.5 h-10 w-full rounded-[var(--qb-r-sm)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3 text-[var(--qb-t-lg)] text-[var(--qb-ink)] outline-none"
                  />
                </label>
                <label className="mt-3.5 block text-[var(--qb-t-sm)] text-[var(--qb-muted)]">
                  Função
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Ex.: assistente, operações, pesquisa"
                    className="mt-1.5 h-10 w-full rounded-[var(--qb-r-sm)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3 text-[var(--qb-t-lg)] text-[var(--qb-ink)] outline-none"
                  />
                </label>
                <label className="mt-3.5 block text-[var(--qb-t-sm)] text-[var(--qb-muted)]">
                  Missão (opcional)
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Uma frase já basta"
                    rows={2}
                    className="mt-1.5 w-full rounded-[var(--qb-r-sm)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] px-3 py-2 text-[var(--qb-t-lg)] text-[var(--qb-ink)] outline-none"
                  />
                </label>
                <p className="mt-5 mb-2 text-[var(--qb-t-sm)] text-[var(--qb-muted)]">Personagem</p>
                <CharacterPicker
                  color={color}
                  shape={shape}
                  onChange={(next) => {
                    setColor(next.color);
                    setShape(next.shape);
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}
      </main>

      <footer className="qb-onboarding-flow__footer">
        {step === "plan" ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setStep("model");
            }}
            className="qb-primary-button"
          >
            {planId === "trial" ? "Continuar" : "Continuar para o modelo"}
          </button>
        ) : null}

        {step === "model" ? (
          <>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep(nextStepAfterModel());
              }}
              className="qb-onboarding-flow__skip"
            >
              Pular por agora
            </button>
            {loadFailed ? (
              <button type="button" onClick={() => void load()} className="qb-secondary-button">
                Tentar de novo
              </button>
            ) : null}
            <button
              type="button"
              disabled={savingModel || needsSignInFirst}
              onClick={() => void saveModel()}
              className="qb-primary-button"
            >
              {savingModel
                ? "Salvando…"
                : needsSignInFirst
                  ? "Entre na assinatura primeiro"
                  : "Continuar"}
            </button>
          </>
        ) : null}

        {step === "machine" ? (
          <>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("bot");
              }}
              className="qb-onboarding-flow__skip"
            >
              Manter o padrão
            </button>
            {isOwner ? (
              <button
                type="button"
                disabled={savingMachine}
                onClick={() => void testMachine()}
                className="qb-secondary-button"
              >
                Testar
              </button>
            ) : null}
            <button
              type="button"
              disabled={savingMachine}
              onClick={() =>
                !isOwner || chosenMachineMatches(savedMachine, machine)
                  ? setStep("bot")
                  : void saveMachine()
              }
              className="qb-primary-button"
            >
              {savingMachine
                ? "Salvando…"
                : !isOwner || chosenMachineMatches(savedMachine, machine)
                  ? "Continuar"
                  : "Salvar e continuar"}
            </button>
          </>
        ) : null}

        {step === "bot" ? (
          <button
            type="button"
            disabled={creating || !name.trim()}
            onClick={() => void createBot()}
            className="qb-primary-button"
          >
            {creating ? "Criando seu agente…" : "Abrir o Quibt Bot"}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

/** Quantas decisões este onboarding tem de verdade: plano (só cloud), modelo, máquina (só quem escolhe) e bot. */
function flowLength(edition: QuibtEdition, machineStep: boolean): number {
  return (edition === "cloud" ? 1 : 0) + 1 + (machineStep ? 1 : 0) + 1;
}

/** Posição da etapa atual na régua, contando só as etapas que existem neste deploy. */
function flowPosition(step: string, machineStep: boolean, edition: QuibtEdition): number {
  const offset = edition === "cloud" ? 1 : 0;
  if (step === "plan") return 0;
  if (step === "model") return offset;
  if (step === "machine") return offset + 1;
  if (step === "bot") return offset + (machineStep ? 2 : 1);
  return 0;
}

function OnboardingProgress({ position, total }: { position: number; total: number }) {
  const steps = Array.from({ length: total }, (_, index) => index);
  return (
    <div
      className="qb-onboarding-intro__progress"
      role="progressbar"
      aria-label="Progresso do onboarding"
      aria-valuemin={1}
      aria-valuemax={steps.length}
      aria-valuenow={position + 1}
    >
      {steps.map((index) => (
        <span key={index} className={index <= position ? "is-active" : undefined} />
      ))}
    </div>
  );
}

/** Ícones de traço, num grid de 20, para os cartões de escolha. Nunca emoji. */
const TOKEN_ICONS: Record<TokenSource, ReactNode> = {
  plan: (
    <>
      <path d="M10 2.6 12.3 7l4.9.7-3.6 3.4.9 4.8-4.5-2.4-4.5 2.4.9-4.8L2.8 7.7 7.7 7Z" />
    </>
  ),
  key: (
    <>
      <circle cx="13.2" cy="6.8" r="3.6" />
      <path d="M10.6 9.4 3.2 16.8" />
      <path d="m6 13.4 2 2" />
      <path d="m4.2 15.2 2 2" />
    </>
  ),
  local: (
    <>
      <rect x="2.6" y="3.4" width="14.8" height="5.4" rx="1.6" />
      <rect x="2.6" y="11.2" width="14.8" height="5.4" rx="1.6" />
      <path d="M5.6 6.1h.01" />
      <path d="M5.6 13.9h.01" />
    </>
  ),
  subscription: (
    <>
      <rect x="2.4" y="4.6" width="15.2" height="10.8" rx="2" />
      <path d="M2.4 8.2h15.2" />
      <path d="M5.6 12.2h3.2" />
    </>
  ),
};

function TokenCard({
  selected,
  title,
  body,
  source,
  onSelect,
}: {
  selected: boolean;
  title: string;
  body: string;
  source: TokenSource;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex flex-col items-start rounded-[var(--qb-r-lg)] border p-4 text-left transition-colors ${
        selected
          ? "border-[var(--qb-accent)] bg-[var(--qb-surface-2)]"
          : "border-[var(--qb-hairline)] hover:bg-[var(--qb-inset)]"
      }`}
    >
      <span
        className="grid h-8 w-8 place-items-center rounded-[var(--qb-r-sm)]"
        style={{ background: selected ? "rgba(60, 130, 246, 0.12)" : "var(--qb-tile)" }}
      >
        <svg
          width="19"
          height="19"
          viewBox="0 0 20 20"
          fill="none"
          stroke={selected ? "var(--qb-accent)" : "var(--qb-muted)"}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {TOKEN_ICONS[source]}
        </svg>
      </span>
      <span className="mt-3 block text-[15px] font-semibold tracking-[-0.01em] text-[var(--qb-ink)]">
        {title}
      </span>
      <span className="mt-1.5 block text-[13px] leading-[1.45] text-[var(--qb-muted)]">{body}</span>
    </button>
  );
}

function PlanCard({
  plan,
  selected,
  onSelect,
}: {
  plan: Plan;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="rounded-[16px] border p-4 text-left"
      style={{
        borderColor: selected ? "#0A84FF" : "#2C2C2E",
        background: selected ? "#111318" : "#1C1C1E",
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[17px] font-semibold text-[var(--qb-ink)]">{plan.name}</span>
        <span className="text-[15px] text-[var(--qb-muted)]">
          {formatPlanPrice(plan)}
          {plan.priceUsd > 0 ? "/mês" : ""}
        </span>
      </div>
      <ul className="mt-3 space-y-1 text-[13px] text-[var(--qb-muted)]">
        {planHighlights(plan)
          .slice(0, 3)
          .map((line) => (
            <li key={line}>{line}</li>
          ))}
      </ul>
    </button>
  );
}
