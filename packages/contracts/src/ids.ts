import * as z from "zod";

export const Id = z.string().min(1);
export const IsoDate = z.string().datetime({ offset: true });

export const ActorSchema = z.object({
  userId: Id,
  workspaceId: Id,
  workspaceRole: z.string().min(1),
  email: z.string().email(),
  isDeploymentOwner: z.boolean(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const BOT_COLORS = [
  "#E8A54B",
  "#6B8AFF",
  "#3DDC97",
  "#A78BFA",
  "#38BDF8",
  "#F2626A",
  "#FB7185",
] as const;

export const RunStatus = z.enum([
  "queued",
  "leased",
  "running",
  "waiting_input",
  "waiting_takeover",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const EffectStatus = z.enum(["intended", "completed", "failed", "ambiguous", "reconciled"]);
export type EffectStatus = z.infer<typeof EffectStatus>;

export const MemoryScope = z.enum(["bot", "user"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const SandboxKind = z.enum(["docker", "remote-supervisor", "e2b", "box", "desktop", "fake"]);
export type SandboxKind = z.infer<typeof SandboxKind>;

export const OssMachineKind = z.enum(["docker", "remote-supervisor", "e2b", "box"]);
export type OssMachineKind = z.infer<typeof OssMachineKind>;
