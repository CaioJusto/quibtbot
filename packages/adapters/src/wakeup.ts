import type { AdapterContext, WakeupDriver, WakeupJob } from "@quibt/adapter-kit";
import { makeWorkerUtils, run, type WorkerUtils } from "graphile-worker";

export class GraphileWakeupDriver implements WakeupDriver {
  private runner: Awaited<ReturnType<typeof run>> | undefined;
  private utils: Promise<WorkerUtils> | undefined;

  constructor(private readonly connectionString: string) {}

  describe() {
    return {
      id: "graphile",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { cron: true, delay: true },
    };
  }

  /** Lazily create one WorkerUtils (and its pg pool) and reuse it across enqueues. */
  private workerUtils(): Promise<WorkerUtils> {
    this.utils ??= makeWorkerUtils({ connectionString: this.connectionString }).catch((error) => {
      this.utils = undefined;
      throw error;
    });
    return this.utils;
  }

  async enqueue(job: WakeupJob): Promise<void> {
    const utils = await this.workerUtils();
    await utils.addJob(job.name, job.payload, {
      runAt: job.runAt,
      jobKey: job.jobKey,
      jobKeyMode: job.jobKey ? "replace" : undefined,
    });
  }

  async start(
    handlers: Record<string, (payload: Record<string, unknown>) => Promise<void>>,
  ): Promise<void> {
    const taskList: Record<string, (payload: unknown) => Promise<void>> = {};
    for (const [name, handler] of Object.entries(handlers)) {
      taskList[name] = async (payload) => {
        await handler((payload ?? {}) as Record<string, unknown>);
      };
    }
    this.runner = await run({
      connectionString: this.connectionString,
      concurrency: 4,
      pollInterval: 500,
      taskList,
    });
  }

  async stop(): Promise<void> {
    await this.runner?.stop();
    this.runner = undefined;
    const utils = this.utils;
    this.utils = undefined;
    if (utils) await utils.then((u) => u.release()).catch(() => undefined);
  }
}

export class InMemoryWakeupDriver implements WakeupDriver {
  private handlers: Record<string, (payload: Record<string, unknown>) => Promise<void>> = {};
  private timers: NodeJS.Timeout[] = [];
  private keyed = new Map<string, NodeJS.Timeout>();
  private running = new Set<Promise<void>>();
  private stopping = false;

  describe() {
    return {
      id: "memory",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { cron: true, delay: true },
    };
  }

  async enqueue(job: WakeupJob, _context?: AdapterContext): Promise<void> {
    if (this.stopping) return;
    const delay = job.runAt ? Math.max(0, job.runAt.getTime() - Date.now()) : 0;
    if (job.jobKey) {
      const existing = this.keyed.get(job.jobKey);
      if (existing) {
        clearTimeout(existing);
        this.timers = this.timers.filter((timer) => timer !== existing);
      }
    }
    const timer = setTimeout(() => {
      // Without this the array grows for every job the process ever ran.
      this.timers = this.timers.filter((entry) => entry !== timer);
      if (job.jobKey) this.keyed.delete(job.jobKey);
      const handler = this.handlers[job.name];
      if (!handler) {
        console.error(`No wakeup handler for ${job.name}`);
        return;
      }
      const running = handler(job.payload).catch((error) => console.error(job.name, error));
      this.running.add(running);
      void running.finally(() => this.running.delete(running));
    }, delay);
    this.timers.push(timer);
    if (job.jobKey) this.keyed.set(job.jobKey, timer);
  }

  async start(
    handlers: Record<string, (payload: Record<string, unknown>) => Promise<void>>,
  ): Promise<void> {
    this.stopping = false;
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.keyed.clear();
    await Promise.all([...this.running]);
    this.running.clear();
    this.handlers = {};
  }
}
