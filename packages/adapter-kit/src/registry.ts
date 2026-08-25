export class AdapterRegistry {
  private readonly adapters = new Map<string, unknown>();

  register<T>(slot: string, adapter: T): void {
    this.adapters.set(slot, adapter);
  }

  get<T>(slot: string): T {
    const adapter = this.adapters.get(slot);
    if (!adapter) {
      throw new Error(`No adapter registered for ${slot}`);
    }
    return adapter as T;
  }

  tryGet<T>(slot: string): T | undefined {
    return this.adapters.get(slot) as T | undefined;
  }

  has(slot: string): boolean {
    return this.adapters.has(slot);
  }

  keys(): string[] {
    return [...this.adapters.keys()];
  }
}

export const slots = {
  runtime: "runtime",
  sandbox: "sandbox",
  memory: "memory",
  home: "home",
  artifacts: "artifacts",
  secrets: "secrets",
  wakeup: "wakeup",
  realtime: "realtime",
  notifications: "notifications",
  models: "models",
  connector: "connector",
  auth: "connection-auth",
  runner: "runner",
} as const;
