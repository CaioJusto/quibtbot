import { lookup as dnsLookup } from "node:dns/promises";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateMcpAddress, type ResolveHost } from "./mcp-http.js";

/**
 * O socket das sondas, preso ao IP que a política aprovou.
 *
 * As sondas conferiam o endereço e depois chamavam `fetch`, que resolvia o DNS DE NOVO:
 * entre a conferência e o aperto de mão sobrava uma janela em que o mesmo nome passava a
 * responder 169.254.169.254 (o clássico DNS rebinding). O preflight continua onde estava
 * — é ele que escreve a frase amigável sem abrir socket —, mas quem realmente decide agora
 * é o `lookup` do próprio socket: a resolução usada para conectar é a MESMA que passa pela
 * política, então não há mais duas resoluções para divergirem.
 *
 * O nome continua no lugar do nome: `hostname` (e, em https, `servername`) guardam o host
 * escrito pela pessoa, então o cabeçalho `Host` do virtual host e o SNI do TLS não mudam;
 * só o destino do pacote é fixado no IP conferido.
 *
 * Redirect é um salto novo, e um salto novo é um endereço novo: cada `Location` passa pela
 * mesma política antes de virar requisição, e a credencial não atravessa uma troca de
 * origem. Quem pede `redirect: "manual"` continua recebendo o 3xx cru, como antes.
 */

/** Teto do corpo que uma sonda aceita ler: nenhuma delas lê mais que uma lista curta. */
export const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;

/** Saltos de redirect que a sonda segue antes de desistir. */
export const MAX_PROBE_REDIRECTS = 3;

const resolveHostDefault: ResolveHost = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * O endereço não passou na política. A frase fica genérica de propósito: quem sonda não
 * descobre, pela mensagem, o que mora atrás do nome.
 */
export class BlockedAddressError extends Error {
  /** Um código fora da lista que as sondas traduzem: ele não vaza para a tela. */
  readonly code = "EQUIBT_BLOCKED";
  constructor(message = "endereço recusado pela política da sonda") {
    super(message);
    this.name = "BlockedAddressError";
  }
}

export interface ProbeNetworkPolicy {
  /**
   * Nomes documentados que valem por si (`localhost`, `host.docker.internal`): eles moram
   * no computador da pessoa e o IP que entregam não é julgado.
   */
  isTrustedHost: (hostname: string) => boolean;
  /** Um host que já é IP literal — nenhum DNS no meio — pode ser alcançado? */
  isAllowedLiteral: (address: string) => boolean;
}

export interface GuardedFetchOptions {
  policy: ProbeNetworkPolicy;
  /** Os testes trocam o DNS; em produção é o `lookup` do Node. */
  resolveHost?: ResolveHost;
  /**
   * O transporte dos testes. Quando vem preenchido, o socket fixado não entra em cena —
   * em produção ele fica vazio e quem conecta é {@link pinnedFetch}.
   */
  transport?: typeof fetch;
  /** Só os testes trocam: o `http.request`/`https.request` que abre a conexão. */
  requestImpl?: ProbeRequest;
}

export type ProbeRequest = (
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Os IPs que este destino pode receber. Um nome é julgado pelo IP que ele entrega, e um só
 * endereço interno derruba a lista inteira: é assim que o rebinding deixa de valer a pena.
 */
async function approvedAddresses(
  url: URL,
  policy: ProbeNetworkPolicy,
  resolveHost: ResolveHost,
): Promise<string[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedAddressError();
  if (url.username || url.password) throw new BlockedAddressError();
  const hostname = hostOf(url);
  if (!hostname) throw new BlockedAddressError();
  if (isIP(hostname)) {
    if (!policy.isAllowedLiteral(hostname)) throw new BlockedAddressError();
    return [hostname];
  }
  const addresses = (await resolveHost(hostname)).map(({ address }) => address);
  if (!addresses.length) throw new BlockedAddressError();
  if (policy.isTrustedHost(hostname)) return addresses;
  if (addresses.some((address) => isPrivateMcpAddress(address))) throw new BlockedAddressError();
  return addresses;
}

/**
 * O `lookup` que o socket usa: ele não resolve nada por conta própria, só entrega os IPs
 * que a política já aprovou. É este passo que fecha a janela entre conferir e conectar.
 */
function pinnedLookup(addresses: string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const asked = options?.family;
    const wanted = asked === 4 || asked === "IPv4" ? 4 : asked === 6 || asked === "IPv6" ? 6 : 0;
    const entries = addresses
      .map((address) => ({ address, family: isIP(address) }))
      .filter((entry) => entry.family !== 0 && (wanted === 0 || entry.family === wanted));
    const first = entries[0];
    if (!first) {
      callback(new BlockedAddressError(), "");
      return;
    }
    if (options?.all) callback(null, entries);
    else callback(null, first.address, first.family);
  };
}

function headerRecord(init: RequestInit["headers"]): Record<string, string> | undefined {
  if (!init) return undefined;
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function webResponse(res: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, item);
      } catch {
        // Um cabeçalho que o WHATWG recusa some, em vez de derrubar a resposta inteira.
      }
    }
  }
  const status = res.statusCode ?? 502;
  const empty = status === 204 || status === 205 || status === 304;
  return new Response(empty ? null : body, {
    status,
    statusText: res.statusMessage ?? "",
    headers,
  });
}

/** Uma requisição, num IP já conferido, com o nome intacto no `Host` e no SNI. */
async function pinnedRequest(
  url: URL,
  init: RequestInit,
  addresses: string[],
  requestImpl?: ProbeRequest,
): Promise<Response> {
  const secure = url.protocol === "https:";
  const send = requestImpl ?? (secure ? httpsRequest : httpRequest);
  const hostname = hostOf(url);
  const body =
    typeof init.body === "string" ? Buffer.from(init.body) : (init.body as Buffer | undefined);
  return new Promise<Response>((resolve, reject) => {
    const req = send(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: headerRecord(init.headers),
        lookup: pinnedLookup(addresses),
        // Um socket keep-alive aberto por outra chamada ao mesmo hostname poderia pular o
        // lookup acima. Sondas são raras e curtas: abrir uma conexão nova é o preço correto
        // para garantir que TODO pacote use um IP desta lista aprovada.
        agent: false,
        servername: secure && !isIP(hostname) ? hostname : undefined,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PROBE_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error("resposta grande demais"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve(webResponse(res, Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Um `fetch` com a mesma assinatura do global, que só alcança o que a política aprovou —
 * no primeiro endereço e em cada redirect — e que conecta no IP conferido.
 */
export function createGuardedFetch(options: GuardedFetchOptions): typeof fetch {
  const resolveHost = options.resolveHost ?? resolveHostDefault;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = new URL(String(input instanceof Request ? input.url : input));
    let request: RequestInit = { ...init };
    const mode = init.redirect ?? "follow";
    for (let hop = 0; hop <= MAX_PROBE_REDIRECTS; hop += 1) {
      // O primeiro endereço já passou pelo preflight da sonda; do segundo salto em diante
      // é aqui que ele passa. Em produção o socket confere os dois de novo, na hora.
      const addresses =
        hop === 0 && options.transport
          ? []
          : await approvedAddresses(url, options.policy, resolveHost);
      const res = options.transport
        ? await options.transport(url.toString(), { ...request, redirect: "manual" })
        : await pinnedRequest(url, request, addresses, options.requestImpl);
      const location = res.headers.get("location");
      if (!isRedirectStatus(res.status) || !location) return res;
      if (mode === "manual") return res;
      if (mode === "error") throw new Error("redirecionamento não é aceito aqui");
      if (hop === MAX_PROBE_REDIRECTS) throw new Error("redirecionamentos demais");
      const next = new URL(location, url);
      request = nextRequest(request, url, next, res.status);
      url = next;
    }
    throw new Error("redirecionamentos demais");
  }) as typeof fetch;
}

/**
 * O que sobrevive a um salto: a credencial não atravessa uma troca de origem, e um 303 (ou
 * um 301/302 que veio de POST) vira GET sem corpo, como manda o fetch.
 */
function nextRequest(current: RequestInit, from: URL, to: URL, status: number): RequestInit {
  const next: RequestInit = { ...current };
  if (from.origin !== to.origin && next.headers) {
    const headers = new Headers(next.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    next.headers = headerRecord(headers);
  }
  const method = (next.method ?? "GET").toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    next.method = "GET";
    next.body = undefined;
  }
  return next;
}
