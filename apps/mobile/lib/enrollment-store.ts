import * as SecureStore from "expo-secure-store";

/**
 * O convite de proprietário guardado depois de validar o código da instalação.
 * Mora num arquivo próprio para `api.ts` não precisar importar `bootstrap-pairing.ts`
 * (que importa `api.ts`) — o ciclo deixava valores indefinidos na carga do bundle.
 */
export const BOOTSTRAP_ENROLLMENT_KEY = "quibt.bootstrap_enrollment";

export async function saveEnrollmentToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(BOOTSTRAP_ENROLLMENT_KEY, token);
}

export async function loadEnrollmentToken(): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(BOOTSTRAP_ENROLLMENT_KEY)) ?? "";
  } catch {
    return "";
  }
}

export async function clearEnrollmentToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(BOOTSTRAP_ENROLLMENT_KEY);
  } catch {
    // Enrollment is best-effort to clear; signup already succeeded or failed terminally.
  }
}

export async function hasEnrollmentToken(): Promise<boolean> {
  return Boolean((await loadEnrollmentToken()).trim());
}

export function isTerminalEnrollmentSignupFailure(status: number): boolean {
  return status === 403 || status === 409;
}
