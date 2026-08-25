import { ORPCError } from "@orpc/server";
import { IsolationError } from "@quibt/db";

/**
 * IsolationError is the data layer saying "this actor cannot see that row".
 * Without a mapping, oRPC turns it into a 500 and the client learns nothing useful.
 */
export function isolationToOrpc(error: IsolationError): ORPCError<string, unknown> {
  const message = error.message || "Resource not found";
  if (/busy|waiting/i.test(message)) {
    return new ORPCError("CONFLICT", { message });
  }
  if (/cannot|keep at least|itself/i.test(message)) {
    return new ORPCError("BAD_REQUEST", { message });
  }
  return new ORPCError("NOT_FOUND", { message });
}

export function rethrowIsolation(error: unknown): never {
  if (error instanceof IsolationError) throw isolationToOrpc(error);
  throw error;
}

export async function withIsolation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    rethrowIsolation(error);
  }
}
