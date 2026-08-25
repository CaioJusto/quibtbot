export interface InstallEmitContext {
  senderId: number;
  navigationId: number;
}

export class InstallEmitContextRegistry {
  private readonly contexts = new Map<string, InstallEmitContext>();

  set(operationId: string, context: InstallEmitContext): void {
    this.contexts.set(operationId, context);
  }

  get(operationId: string): InstallEmitContext | null {
    return this.contexts.get(operationId) ?? null;
  }

  clear(operationId: string): void {
    this.contexts.delete(operationId);
  }
}
