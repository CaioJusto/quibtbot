import type { RealtimeFanout } from "@quibt/adapter-kit";
import type { Pool } from "pg";

export class PostgresRealtimeFanout implements RealtimeFanout {
  constructor(private readonly pool: Pool) {}

  describe() {
    return {
      id: "postgres",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { postgres: true },
    };
  }

  async publish(channel: string, payload: string): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [channel, payload]);
  }

  async subscribe(
    channel: string,
    onMessage: (payload: string) => void,
  ): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    await client.query(`LISTEN ${channel}`);
    const handler = (msg: { channel: string; payload?: string }) => {
      if (msg.channel === channel && msg.payload) onMessage(msg.payload);
    };
    client.on("notification", handler);
    return async () => {
      client.off("notification", handler);
      await client.query(`UNLISTEN ${channel}`);
      client.release();
    };
  }
}
