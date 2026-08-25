/**
 * Entrar de verdade depois que o servidor gravou o cookie.
 *
 * As telas de entrada falam com a API por `fetch` cru (sem e-mail e senha, o cliente do
 * better-auth nem deixa chamar). O hook `useSession` não fica sabendo desse cookie, e um
 * `navigate("/onboarding")` chegava com a sessão velha — a rota mandava de volta para
 * "Entrar com código" bem depois de a conta ter sido criada. Recarregar a página é o
 * jeito honesto de a sessão nova valer em todo lugar.
 */
export function enterApp(path: string, assign: (url: string) => void = defaultAssign): void {
  assign(path);
}

function defaultAssign(url: string): void {
  window.location.assign(url);
}

/** O destino depois do cadastro: o onboarding, carregando o plano quando houver. */
export function onboardingPath(plan: string | null): string {
  return plan ? `/onboarding?plan=${encodeURIComponent(plan)}` : "/onboarding";
}
