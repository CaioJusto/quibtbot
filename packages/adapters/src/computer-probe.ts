import { bootableKind } from "@quibt/core";

export interface ComputerProbeInput {
  kind: string;
  endpoint?: string;
  apiKey?: string;
  supervisorUrl?: string;
  supervisorToken?: string;
}

export interface ComputerProbeResult {
  ok: boolean;
  message: string;
}

export async function probeComputer(
  input: ComputerProbeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ComputerProbeResult> {
  const boot = bootableKind(input.kind);
  if (!boot) {
    return { ok: false, message: `Máquina desconhecida: ${input.kind}` };
  }
  if (boot === "e2b") {
    const key = input.apiKey?.trim();
    if (!key) return { ok: false, message: "Cole a E2B_API_KEY para testar." };
    return { ok: true, message: "Chave presente. O próximo computador sobe na E2B." };
  }
  if (boot === "box") {
    const key = input.apiKey?.trim();
    if (!key) return { ok: false, message: "Cole a BOX_API_KEY para testar." };
    return { ok: true, message: "Chave presente. O próximo computador sobe no Box." };
  }
  const url = (input.endpoint || input.supervisorUrl || "").replace(/\/$/, "");
  if (boot === "remote-supervisor" && !url) {
    return { ok: false, message: "Cole a URL do supervisor (https://vps:7091)." };
  }
  const target = url || "http://127.0.0.1:7091";
  try {
    const headers: Record<string, string> = {};
    const token = input.apiKey || input.supervisorToken;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(`${target}/health`, {
      headers,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { ok: false, message: `Supervisor respondeu ${res.status} em ${target}.` };
    }
    return { ok: true, message: `Supervisor ok em ${target}.` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "sem resposta";
    return { ok: false, message: `Não alcançou ${target}: ${detail}` };
  }
}
