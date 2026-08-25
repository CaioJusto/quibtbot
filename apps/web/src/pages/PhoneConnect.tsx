import {
  connectApiBase,
  connectDeepLink,
  connectLinkIsReachable,
  defaultPhoneConnectReach,
  isLoopbackHost,
  LOCAL_PHONE_TUNNEL_TARGET,
  localPhoneTunnelCommand,
  normalizeRemoteConnectApi,
  type PhoneConnectReach,
  qrImageSrc,
} from "@quibt/core";
import { formatDeviceCode } from "@quibt/core/device-code";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth";
import type { RemoteAccess } from "../lib/desktop";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { errorMessage } from "../lib/rpc-errors";

/** O código vale 2 minutos no servidor. A contagem aqui espelha isso na tela. */
const PAIR_SECONDS = 120;

const FIELD =
  "qb-settings-field mt-2 w-full rounded-[12px] bg-[var(--qb-surface-2)] px-4 py-3 text-left text-[15px] text-[var(--qb-ink)] outline-none";

export function PhoneConnectPage() {
  const navigate = useNavigate();
  return (
    <div className="qb-settings-page min-h-full px-6 py-8">
      <div className="mx-auto w-full max-w-[620px]">
        <button type="button" onClick={() => navigate(-1)} className="qb-settings-back">
          ← Voltar
        </button>
        <div className="mt-5">
          <PhoneConnectBody />
        </div>
      </div>
    </div>
  );
}

/** O mesmo conteúdo na rota e no modal aberto pelo menu da conta. */
export function PhoneConnectBody({ onConnected }: { onConnected?: () => void } = {}) {
  const [pageHost, setPageHost] = useState("");
  /** O nome do aparelho que acabou de entrar — a tela vira um "conectado" e se despede. */
  const [connected, setConnected] = useState<string | null>(null);
  const [pageOrigin, setPageOrigin] = useState("");
  const [lanApi, setLanApi] = useState<string | null>(null);
  const [remoteApi, setRemoteApi] = useState<string | null>(null);
  const [reach, setReach] = useState<PhoneConnectReach>("lan");
  const [isOwner, setIsOwner] = useState(false);
  const [remoteDraft, setRemoteDraft] = useState("");
  const [savingRemote, setSavingRemote] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [pair, setPair] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [minting, setMinting] = useState(false);
  const [typedCode, setTypedCode] = useState<string | null>(null);
  const [requests, setRequests] = useState<Array<{ id: string; device: string; askedAt: string }>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"api" | "tunnel" | null>(null);
  const [tailscale, setTailscale] = useState<RemoteAccess | null>(null);
  const [switching, setSwitching] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const localPc = Boolean(pageHost) && isLoopbackHost(pageHost);
  const remote = normalizeRemoteConnectApi(remoteApi);

  useEffect(() => {
    const desktop = desktopBridge();
    const host = window.location.hostname;
    const origin = window.location.origin;
    setPageHost(host);
    setPageOrigin(origin);
    void Promise.all([
      Promise.resolve(desktop?.lanInfo?.())
        .then((lan) => {
          if (lan?.remote) setTailscale(lan.remote);
          return lan?.api ?? null;
        })
        .catch(() => null),
      rpc.deployment.get().catch(() => null),
      rpc.me().catch(() => null),
    ]).then(([lan, deployment, me]) => {
      setLanApi(lan);
      const saved = normalizeRemoteConnectApi(deployment?.webhookPublicUrl);
      setRemoteApi(saved);
      setRemoteDraft(saved ?? "");
      setIsOwner(Boolean(me?.isDeploymentOwner));
      if (isLoopbackHost(host)) setReach(defaultPhoneConnectReach(saved));
    });
  }, []);

  /**
   * Enquanto esta tela está aberta, ela pergunta quem está batendo. Só aqui, e só
   * enquanto alguém olha: aprovar é um ato de quem está na máquina, não um processo
   * de fundo que segue rodando quando ninguém está vendo.
   */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const rows = await rpc.deviceRequests.list().catch(() => null);
      if (alive && rows) setRequests(rows);
    };
    void tick();
    const timer = setInterval(() => void tick(), 2_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  async function decide(requestId: string, approved: boolean) {
    const device = requests.find((row) => row.id === requestId)?.device ?? "Celular";
    await rpc.deviceRequests.decide({ requestId, approved }).catch(() => undefined);
    setRequests((current) => current.filter((row) => row.id !== requestId));
    if (approved) markConnected(device);
  }

  /**
   * Conectou: o QR some, fica o verde com o nome do aparelho, e o painel fecha sozinho
   * daqui a pouco — ninguém precisa ficar olhando um código que já cumpriu o papel.
   */
  function markConnected(device: string) {
    if (timer.current) clearInterval(timer.current);
    setPair(null);
    setTypedCode(null);
    setConnected(device);
    window.setTimeout(() => onConnected?.(), 1800);
  }

  /**
   * O outro jeito de entrar — ler o QR liberado — não passa pela fila de aprovação. Enquanto
   * a entrada está liberada, olhamos se apareceu uma sessão nova nesta conta; se sim, foi
   * o celular que leu o QR, e a tela diz isso em vez de ficar parada no código.
   */
  useEffect(() => {
    if (!pair) return;
    let alive = true;
    let baseline: number | null = null;
    const tick = async () => {
      const result = await authClient.listSessions().catch(() => null);
      const count = result?.data?.length ?? null;
      if (!alive || count === null) return;
      if (baseline === null) {
        baseline = count;
        return;
      }
      if (count > baseline) markConnected("Celular");
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pair]);

  // O código morre com a tela: ninguém deixa um login válido pendurado num QR aberto.
  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  /**
   * O passo de aprovar. Enquanto ninguém clica, o QR só diz onde fica o servidor, e o
   * celular ainda precisa da senha. Depois do clique, ele carrega um código de uso único
   * e o celular entra sozinho — por dois minutos, e uma vez só.
   */
  async function release() {
    if (minting) return;
    setMinting(true);
    setError(null);
    const result = await authClient.oneTimeToken.generate().catch(() => null);
    // Nem toda câmera lê o QR (e nem todo aparelho tem câmera): o mesmo clique
    // solta um código curto para digitar. Ver docs/entrar-sem-senha.md.
    const typed = await fetch("/api/pairing/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: "{}",
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ code?: string }>) : null))
      .catch(() => null);
    setMinting(false);
    const token = result?.data?.token ?? null;
    if (!token) {
      setError("Não foi possível liberar a entrada agora. Tente de novo.");
      return;
    }
    setTypedCode(typed?.code ?? null);
    setPair(token);
    setLeft(PAIR_SECONDS);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      setLeft((value) => {
        if (value <= 1) {
          if (timer.current) clearInterval(timer.current);
          setPair(null);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
  }

  /**
   * O atalho para quem já tem o Tailscale logado neste computador: o Quibt sobe o
   * `tailscale serve` e guarda a https do tailnet como o endereço remoto — o mesmo
   * campo que o túnel manual preenche, sem digitar nada. O Quibt não instala nem
   * loga o Tailscale; isso continua sendo do usuário, como no túnel.
   */
  async function enableTailscale() {
    const desktop = desktopBridge();
    if (!desktop?.remoteAccess || switching) return;
    setSwitching(true);
    setRemoteError(null);
    try {
      const next = await desktop.remoteAccess(true);
      setTailscale(next);
      if (next.kind !== "on") return;
      const settings = await rpc.deployment.update({
        webhookPublicUrl: next.url,
      });
      const saved = normalizeRemoteConnectApi(settings.webhookPublicUrl);
      setRemoteApi(saved);
      setRemoteDraft(saved ?? "");
      setReach("remote");
    } catch (cause) {
      setRemoteError(errorMessage(cause, "Não foi possível ligar o acesso pelo Tailscale."));
    } finally {
      setSwitching(false);
    }
  }

  async function saveRemote() {
    if (savingRemote) return;
    const normalized = normalizeRemoteConnectApi(remoteDraft);
    if (!normalized) {
      setRemoteError(
        "Cole um endereço https:// público, sem senha na URL. HTTP só vale nesta rede.",
      );
      return;
    }
    setSavingRemote(true);
    setRemoteError(null);
    try {
      const settings = await rpc.deployment.update({
        webhookPublicUrl: normalized,
      });
      const saved = normalizeRemoteConnectApi(settings.webhookPublicUrl);
      setRemoteApi(saved);
      setRemoteDraft(saved ?? "");
      setReach("remote");
    } catch (cause) {
      setRemoteError(errorMessage(cause, "Não foi possível guardar este endereço."));
    } finally {
      setSavingRemote(false);
    }
  }

  async function clearRemote() {
    if (savingRemote) return;
    setSavingRemote(true);
    setRemoteError(null);
    try {
      await rpc.deployment.update({ webhookPublicUrl: null });
      setRemoteApi(null);
      setRemoteDraft("");
      setReach("lan");
    } catch (cause) {
      setRemoteError(errorMessage(cause, "Não foi possível remover o endereço."));
    } finally {
      setSavingRemote(false);
    }
  }

  const api = pageHost
    ? connectApiBase({
        pageHost,
        pageOrigin,
        lanApi,
        remoteApi: remote,
        reach,
      })
    : "";
  /**
   * Um QR com endereço de loopback é bem formado e nunca conecta: lido no celular,
   * `127.0.0.1` é o próprio celular. Acontece ao abrir esta página no navegador, sem o
   * app do computador por perto para dizer qual é o endereço da rede. Melhor não
   * desenhar o código e explicar o que fazer do que entregar um QR que só falha.
   */
  const apiReachable = Boolean(api) && connectLinkIsReachable(api);
  const showQr = !connected && apiReachable && (reach === "lan" || Boolean(remote));
  const link = showQr ? connectDeepLink(api, pair) : "";
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const tunnelCommand = localPhoneTunnelCommand();

  return (
    <div className="text-center">
      <p className="text-left text-[13px] leading-[1.5] text-[var(--qb-muted)]">
        O celular fala com o servidor — não com esta janela. Em uma VPS, ele continua funcionando
        mesmo com o computador desligado.
      </p>

      {!localPc && pageHost ? (
        <div className="mt-4 rounded-[var(--qb-r-md)] bg-[var(--qb-inset)] px-4 py-3 text-left">
          <p className="text-[12px] font-semibold text-[var(--qb-ink)]">Celular → {pageHost}</p>
          <p className="mt-1 text-[12px] leading-[1.5] text-[var(--qb-muted)]">
            Este desktop já está numa VPS. O QR conecta o celular diretamente a ela, sem passar por
            este computador.
          </p>
        </div>
      ) : null}

      {localPc ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setReach("lan")}
            disabled={!lanApi}
            className={reach === "lan" ? "qb-primary-button" : "qb-secondary-button"}
          >
            Tailscale
          </button>
          <button
            type="button"
            onClick={() => setReach("remote")}
            className={reach === "remote" ? "qb-primary-button" : "qb-secondary-button"}
          >
            Qualquer rede
          </button>
        </div>
      ) : null}

      {localPc && reach === "remote" ? (
        <div className="mt-4 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] p-4 text-left">
          <p className="text-[13px] leading-[1.5] text-[var(--qb-muted)]">
            Fora do Tailscale deste PC o celular precisa de um endereço <strong>https://</strong>{" "}
            que aponte de volta para esta janela. Você mesmo sobe um Cloudflare Tunnel ou um
            Tailscale Funnel — e, se for pago, paga direto a eles. O Quibt não fornece, não hospeda
            e não vende túnel.
          </p>
          <p className="mt-2 text-[12px] leading-[1.5] text-[var(--qb-muted-2)]">
            Aponte o túnel para <code>{LOCAL_PHONE_TUNNEL_TARGET}</code>. O QR passa a usar o
            https://, então dados móveis e outro Wi-Fi funcionam. Este computador continua
            precisando ficar ligado.
          </p>
          {isOwner && tailscale && tailscale.kind !== "on" ? (
            <div className="mt-3 rounded-[var(--qb-r-md)] bg-[var(--qb-inset)] p-3">
              <p className="text-[12px] font-semibold text-[var(--qb-ink)]">Tailscale</p>
              <p className="mt-1 text-[12px] leading-[1.5] text-[var(--qb-muted)]">
                {tailscale.reason === "not-serving"
                  ? "Já está logado aqui. Ligue e o endereço https do tailnet entra sozinho."
                  : tailscale.reason === "logged-out"
                    ? "Instalado, mas sem login. Abra o Tailscale e entre; depois volte aqui."
                    : "Instale o Tailscale neste computador e entre na conta; depois volte aqui."}
              </p>
              {tailscale.reason === "not-serving" ? (
                <button
                  type="button"
                  className="qb-primary-button mt-2"
                  disabled={switching}
                  onClick={() => void enableTailscale()}
                >
                  {switching ? "Ligando…" : "Ligar pelo Tailscale"}
                </button>
              ) : null}
            </div>
          ) : null}
          {isOwner ? (
            <>
              <label className="mt-3 block text-[12px] font-semibold text-[var(--qb-muted-2)]">
                Endereço https do seu túnel
                <input
                  className={FIELD}
                  value={remoteDraft}
                  onChange={(event) => setRemoteDraft(event.target.value)}
                  placeholder="https://seu-tunel.exemplo"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={savingRemote}
                  onClick={() => void saveRemote()}
                  className="qb-secondary-button"
                >
                  {savingRemote ? "Salvando…" : "Usar este endereço no QR"}
                </button>
                {remote ? (
                  <button
                    type="button"
                    disabled={savingRemote}
                    onClick={() => void clearRemote()}
                    className="text-[13px] text-[var(--qb-muted-2)] disabled:opacity-40"
                  >
                    Voltar ao Tailscale
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="mt-3 text-[13px] leading-[1.45] text-[var(--qb-muted-2)]">
              {remote
                ? `Endereço público configurado: ${remote}.`
                : "Nenhum endereço https configurado ainda."}{" "}
              Só quem instalou o Quibt neste computador pode colar o túnel.
            </p>
          )}
          {remoteError ? (
            <p role="alert" className="mt-2 text-[13px] text-[var(--qb-danger)]">
              {remoteError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(tunnelCommand);
              setCopied("tunnel");
            }}
            className="qb-secondary-button mt-3"
          >
            {copied === "tunnel" ? "Comando copiado" : "Copiar comando do Cloudflare Tunnel"}
          </button>
        </div>
      ) : null}

      {!apiReachable && api ? (
        <div className="mt-4 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-inset)] p-4 text-left">
          <p className="text-[13px] font-semibold text-[var(--qb-ink)]">
            Falta um endereço seguro para o celular
          </p>
          <p className="mt-1 text-[13px] leading-[1.5] text-[var(--qb-muted)]">
            O QR sairia apontando para <code>{api}</code>, e no celular esse endereço é o próprio
            celular. Conecte este computador e o celular ao <strong>Tailscale</strong> — ou use
            "Qualquer rede" acima e cole o https do seu túnel.
          </p>
        </div>
      ) : null}
      {link ? (
        <>
          <img
            alt="QR para conectar o celular"
            src={qrImageSrc(link)}
            className="mx-auto mt-5 h-[196px] w-[196px] rounded-[var(--qb-r-lg)] border border-[var(--qb-hairline)] bg-[var(--qb-canvas)] p-3"
          />
          <p className="mt-4 text-[13px] text-[var(--qb-muted)]">
            {pair
              ? "Leia agora no celular: ele entra direto, sem senha."
              : reach === "remote"
                ? "Leia o QR no app. Este endereço https funciona fora do Wi-Fi deste PC."
                : "Leia o QR no app pelo Tailscale. Para entrar sem digitar senha, libere a entrada abaixo."}
          </p>
          <p className="mt-2 break-all text-[12px] text-[var(--qb-muted-2)]">{api}</p>

          {connected ? (
            <div className="mt-4 flex items-center gap-3 rounded-[var(--qb-r-md)] border border-[#BEDCC5] bg-[#E4EFE6] px-4 py-3 text-left">
              <span className="qb-live-dot" />
              <div>
                <p className="text-[14px] font-semibold text-[var(--qb-ink)]">
                  {connected} conectado
                </p>
                <p className="text-[12.5px] text-[var(--qb-muted)]">
                  Já pode fechar — a conversa e os bots aparecem lá.
                </p>
              </div>
            </div>
          ) : pair ? (
            <>
              <p className="mt-4 text-[13px] font-semibold text-[var(--qb-ink)]">
                Entrada liberada · expira em {clock}
              </p>
              {typedCode ? (
                <div className="mt-3">
                  <p className="text-[13px] text-[var(--qb-muted)]">
                    Sem câmera? Digite este código no celular, em “Entrar com código”:
                  </p>
                  <p className="rk-mono mt-1 text-[26px] tracking-[6px] text-[var(--qb-ink)]">
                    {formatDeviceCode(typedCode)}
                  </p>
                </div>
              ) : null}
              {/*
                O segundo lado da porta: o código põe o aparelho nesta fila, e é aqui
                que ele entra de verdade. Quem viu o código de longe esbarra nisto.
              */}
              {requests.length ? (
                <div className="mt-4 rounded-[var(--qb-r-md)] border border-[var(--qb-hairline)] bg-[var(--qb-inset)] p-3 text-left">
                  <p className="text-[13px] font-semibold text-[var(--qb-ink)]">
                    Querendo entrar agora
                  </p>
                  {requests.map((request) => (
                    <div className="mt-2 flex items-center justify-between gap-3" key={request.id}>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--qb-ink)]">
                        {request.device}
                      </span>
                      <button
                        type="button"
                        className="qb-primary-button"
                        onClick={() => void decide(request.id, true)}
                      >
                        Aprovar
                      </button>
                      <button
                        type="button"
                        className="qb-secondary-button"
                        onClick={() => void decide(request.id, false)}
                      >
                        Recusar
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <button type="button" onClick={() => void release()} className="qb-primary-button mt-4">
              {minting ? "Liberando…" : "Liberar entrada por 2 minutos"}
            </button>
          )}
          {error ? <p className="mt-3 text-[13px] text-[var(--qb-danger)]">{error}</p> : null}
          <p className="mt-3 text-[12px] leading-[1.5] text-[var(--qb-muted-2)]">
            Libere só com o celular na mão: enquanto está liberado, quem ler este QR entra na sua
            conta.
          </p>

          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(api);
              setCopied("api");
            }}
            className="qb-secondary-button mt-4"
          >
            {copied === "api" ? "Endereço copiado" : "Copiar endereço do servidor"}
          </button>
        </>
      ) : localPc && reach === "remote" && !remote ? (
        <p className="mt-6 text-[13px] text-[var(--qb-muted)]">
          Cole o https:// do túnel para o QR apontar para qualquer rede.
        </p>
      ) : (
        <p className="mt-6 text-[13px] text-[var(--qb-muted)]">
          Descobrindo o endereço na sua rede…
        </p>
      )}
    </div>
  );
}
