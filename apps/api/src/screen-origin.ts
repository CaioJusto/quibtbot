/**
 * De onde a tela do bot deve ser servida para este cliente.
 *
 * O proxy do noVNC vive no web (`/novnc/…`), mas a URL assinada carregava sempre o
 * `webOrigin` do servidor — no local-first, `http://127.0.0.1:5173`. Para o celular
 * isso é o próprio celular: a WebView abria o nada e a tela ficava preta, mesmo com
 * o controle na mão. O host por onde o pedido chegou à API é, por definição, um
 * endereço que este cliente alcança; troca-se só a porta pela do web.
 */
/**
 * Um host que só existe dentro da rede do Docker ("api", "web", "supervisor") não é um
 * endereço que o navegador ou o celular consigam abrir. Quando o proxy à frente não
 * encaminha o host original, é isso que chega aqui — e a tela era assinada como
 * `http://api:5173/novnc/…`, ou seja, preta em todo cliente.
 */
export function reachableFromClient(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  // IPv4/IPv6 literais e qualquer nome com ponto (FQDN, .local, .ts.net) são endereços reais.
  if (hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  return hostname.includes(".");
}

export function screenProxyOrigin(input: {
  requestUrl: string;
  forwardedProto?: string | null;
  forwardedHost?: string | null;
  /** O `webOrigin` do servidor: dá a porta do web e é a saída quando nada serve. */
  fallback: string;
  /**
   * `x-forwarded-*` só vale quando quem falou com a API foi um proxy que este deploy
   * declarou confiável (`TRUSTED_PROXY_IPS`). Vindo direto do cliente, o cabeçalho é
   * escolhido por ele: bastaria mandar `x-forwarded-host: sitedele.com` para receber
   * de volta a tela do bot assinada para um endereço que ele controla.
   */
  forwardedTrusted?: boolean;
}): string {
  try {
    const url = new URL(input.requestUrl);
    const web = new URL(input.fallback);
    const trusted = input.forwardedTrusted !== false;
    const forwarded = trusted ? input.forwardedHost?.split(",")[0]?.trim() : undefined;
    const forwardedProto = trusted ? input.forwardedProto?.split(",")[0]?.trim() : undefined;
    const proto = forwardedProto || url.protocol.replace(/:$/, "");
    if (proto !== "http" && proto !== "https") return input.fallback;
    // Atrás de um proxy reverso, o host encaminhado já é a fachada inteira (web + api).
    if (forwarded) {
      const forwardedHostname = forwarded.replace(/:\d+$/, "");
      if (reachableFromClient(forwardedHostname)) return `${proto}://${forwarded}`;
    }
    if (!reachableFromClient(url.hostname)) return input.fallback;
    // Mesmo hostname que alcançou a API, na porta em que o web serve o proxy.
    const port = web.port ? `:${web.port}` : "";
    return `${proto}://${url.hostname}${port}`;
  } catch {
    return input.fallback;
  }
}
