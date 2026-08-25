export const LOCAL_UNAVAILABLE_MESSAGE =
  "O stack local não responde. Use o setup para instalar ou conectar a outro servidor.";

export const REMOTE_UNAVAILABLE_MESSAGE =
  "O servidor remoto salvo não responde. Voltamos ao setup local — você pode instalar neste computador ou conectar outro servidor.";

export type InitialNavigationPlan =
  | { action: "navigate"; url: string; remote: boolean }
  | { action: "setup"; clearRemote: boolean; message: string };

export async function planInitialNavigation(
  target: string,
  probe: (url: string) => Promise<boolean>,
  isLocal: (url: string) => boolean,
): Promise<InitialNavigationPlan> {
  const available = await probe(target);
  if (isLocal(target)) {
    if (!available) {
      return { action: "setup", clearRemote: false, message: LOCAL_UNAVAILABLE_MESSAGE };
    }
    return { action: "navigate", url: target, remote: false };
  }
  if (!available) {
    return {
      action: "setup",
      clearRemote: true,
      message: REMOTE_UNAVAILABLE_MESSAGE,
    };
  }
  return { action: "navigate", url: target, remote: true };
}
