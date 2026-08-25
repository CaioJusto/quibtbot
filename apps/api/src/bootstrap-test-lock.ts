import { it as vitestIt } from "vitest";

/** Serializes bootstrap DB tests that share deployment_settings / bootstrap_invite rows. */
let chain = Promise.resolve();

export function withBootstrapDbLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function bootstrapIt(name: string, fn: () => void | Promise<void>, timeout?: number): void {
  vitestIt(name, () => withBootstrapDbLock(async () => await fn()), timeout);
}
