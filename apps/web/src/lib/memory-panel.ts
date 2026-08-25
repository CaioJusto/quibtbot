import type { MemoryDocument } from "@quibt/contracts";

/** Hermes stores: MEMORY.md (bot notes) and USER.md (account profile). */
export function splitMemoryDocs(docs: MemoryDocument[]) {
  return {
    bot: docs.find((doc) => doc.scope === "bot" && doc.path === "MEMORY.md"),
    user:
      docs.find((doc) => doc.scope === "user" && doc.path === "USER.md") ??
      docs.find((doc) => doc.scope === "user" && doc.path === "MEMORY.md"),
  };
}

export function memoryLabel(scope: "bot" | "user") {
  return scope === "bot" ? "MEMORY.md — notas do agente" : "USER.md — perfil";
}
