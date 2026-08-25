/**
 * Conversation branching hook.
 *
 * Threads today are a single `seq` per bot (or group). A real fork would need
 * `Message.parentId` plus a way to render alternate timelines. That is a
 * schema and UI product of its own — do not add the column in this wave.
 */
export const CONVERSATION_BRANCHING = {
  supported: false,
  reason: "Thread messages are a linear seq. Branching needs Message.parentId and a fork UI.",
} as const;
