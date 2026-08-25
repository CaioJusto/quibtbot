export interface InstallActiveState {
  kind: "ssh" | "box";
  boxId?: string;
  apiKey?: string;
}

export class InstallConcurrencyGate<T> {
  private inFlight: { id: string; promise: Promise<T>; abort: AbortController } | null = null;
  private installActiveState: InstallActiveState | null = null;

  get busy(): boolean {
    return this.inFlight !== null;
  }

  currentId(): string | null {
    return this.inFlight?.id ?? null;
  }

  activeState(): InstallActiveState | null {
    return this.installActiveState;
  }

  setActiveState(state: InstallActiveState | null): void {
    this.installActiveState = state;
  }

  async run(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.inFlight) {
      if (this.inFlight.id === id) return this.inFlight.promise;
      throw new Error("Another install operation is already in progress.");
    }
    const abort = new AbortController();
    const promise = work(abort.signal).finally(() => {
      if (this.inFlight?.id === id) {
        this.inFlight = null;
        this.installActiveState = null;
      }
    });
    this.inFlight = { id, promise, abort };
    return promise;
  }

  cancel(id: string): boolean {
    if (!this.inFlight || this.inFlight.id !== id) return false;
    this.inFlight.abort.abort();
    return true;
  }
}
