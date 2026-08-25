import type { AdapterContext, AgentRunRequest } from "@quibt/adapter-kit";
import { describe, expect, it } from "vitest";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

const context = { signal: new AbortController().signal } as unknown as AdapterContext;

async function collect(request: AgentRunRequest) {
  const events = [];
  for await (const event of new ScriptedAgentRuntime().run(request, context)) events.push(event);
  return events;
}

describe("ScriptedAgentRuntime execution ids", () => {
  it("gives every tool call its own id, even when the tool repeats", async () => {
    const events = await collect({
      runId: "run-1",
      prompt: "two files",
      history: [],
      script: [
        {
          toolCalls: [
            { name: "write_file", args: { path: "a.txt", content: "a" } },
            { name: "write_file", args: { path: "b.txt", content: "b" } },
          ],
          complete: true,
        },
      ],
    } as unknown as AgentRunRequest);
    const ids = events
      .filter((event) => event.type === "tool")
      .map((event) => (event as { executionId: string }).executionId);
    expect(ids).toHaveLength(2);
    // Same key means the effect ledger answers the second write with the first result.
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith("run-1:write_file"))).toBe(true);
  });
});
