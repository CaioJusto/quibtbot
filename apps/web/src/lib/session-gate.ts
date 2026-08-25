/**
 * O que a raiz mostra enquanto a sessão ainda não é conhecida.
 *
 * "Não há usuário" e "a API não respondeu" são coisas diferentes, e o app tratava as
 * duas como a primeira: no desktop a UI sobe segundos antes da API, o `get-session`
 * falha, e a tela de boas-vindas aparecia para quem já estava logado — o cookie
 * estava lá o tempo todo. Erro de rede vira "carregando", com nova tentativa; só a
 * resposta clara da API decide entre Welcome e app.
 */

export type SessionSnapshot = {
  isPending: boolean;
  hasUser: boolean;
  error: unknown;
};

export type SessionGate = "loading" | "signed-in" | "signed-out" | "unreachable";

/** Depois deste tanto de tentativas seguidas, é honesto dizer que a API não está lá. */
export const MAX_SESSION_RETRIES = 6;
export const SESSION_RETRY_MS = 1_500;

export function sessionGate(snapshot: SessionSnapshot, retries: number): SessionGate {
  if (snapshot.isPending) return "loading";
  if (snapshot.hasUser) return "signed-in";
  if (snapshot.error) return retries < MAX_SESSION_RETRIES ? "loading" : "unreachable";
  return "signed-out";
}
