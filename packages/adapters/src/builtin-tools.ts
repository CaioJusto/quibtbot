import type { ConnectorTool } from "@quibt/adapter-kit";

export const DELEGATION_TOOL_NAMES = new Set(["run_subagent", "spawn_bot", "delete_bot"]);

export const builtinAgentTools: ConnectorTool[] = [
  {
    name: "screenshot",
    description:
      "Take a picture of this bot's screen and send it into the chat. Use it whenever the person asks to see the screen.",
    inputSchema: {
      type: "object",
      properties: {
        caption: { type: "string", description: "One short line about what is on screen." },
      },
    },
  },
  {
    name: "record_screen",
    description:
      "Record a short video of this bot's screen and send it into the chat. Use it when showing something that moves — a flow, an animation, a bug that only appears while clicking.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "How long to record. Default 10, at most 60." },
        caption: { type: "string", description: "One short line about what the video shows." },
      },
    },
  },
  {
    name: "send_file",
    description:
      "Send a file from the computer into the chat, where the person can see or download it. Use it for a screenshot, a PDF, a spreadsheet, a recording — anything you produced or were asked for. Take the screenshot or write the file with `shell` first, then send its path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file inside the computer." },
        caption: { type: "string", description: "One short line about what this is." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write a UTF-8 file into this bot's private home filesystem. The file shows up in Files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "shell",
    description:
      "Run a command inside this bot's computer (the sandbox). cwd defaults to the bot home.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "open_url",
    description:
      "Open an HTTP or HTTPS page inside this bot's own graphical browser. Use this instead of shell/xdg-open. It does not open an external browser and does not need user approval.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page address to open." },
      },
      required: ["url"],
    },
  },
  {
    name: "request_takeover",
    description:
      "Ask the user to take over the computer screen for login or human judgment. Protected input stays off the thread.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "memory",
    description:
      "Save durable facts to persistent memory that survive across sessions. Memory is injected into every future turn, so keep entries compact and high-signal.\n\n" +
      "HOW: make ALL your changes in ONE call via an 'operations' array (each item: {action, content?, old_text?}). The batch applies atomically and the char limit is checked only on the FINAL result — so a single call can remove/replace stale entries to free room AND add new ones, even when an add alone would overflow. Use the bare action/content/old_text fields only for a single lone change.\n\n" +
      "WHEN: save proactively when the user states a preference, correction, or personal detail, or you learn a stable fact about their environment, conventions, or workflow. Priority: user preferences & corrections > environment facts > procedures. The best memory stops the user repeating themselves.\n\n" +
      "IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that removes or shortens enough stale entries and adds the new one together.\n\n" +
      "TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, conventions, tool quirks, lessons).\n\n" +
      "SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, temporary TODO state. Reusable procedures belong in a skill, not memory.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "replace", "remove"],
          description: "The action to perform (single-op shape). Omit when using 'operations'.",
        },
        target: {
          type: "string",
          enum: ["memory", "user"],
          description: "Which memory store: 'memory' for personal notes, 'user' for user profile.",
        },
        content: {
          type: "string",
          description:
            "The entry content. Required for 'add' and 'replace' (single-op shape). Alias: 'new_text'.",
        },
        old_text: {
          type: "string",
          description:
            "REQUIRED for 'replace' and 'remove': a short unique substring identifying the existing entry.",
        },
        new_text: {
          type: "string",
          description: "Alias for 'content'. If both are set, 'content' wins.",
        },
        operations: {
          type: "array",
          description:
            "Batch shape: operations applied atomically against the final char budget. Each item is {action, content?, old_text?}.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              content: { type: "string" },
              new_text: { type: "string" },
              old_text: { type: "string" },
            },
            required: ["action"],
          },
        },
      },
      required: ["target"],
    },
  },
  {
    name: "remember",
    description:
      "Deprecated alias for memory(action=add, target=memory). Prefer the memory tool: add, replace, or remove one compact entry.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        path: { type: "string" },
        target: { type: "string", enum: ["memory", "user"] },
      },
      required: ["content"],
    },
  },
  {
    name: "save_skill",
    description:
      "Save a reusable skill (how to do a task). The user can invoke it later with /Name. A skill is not a schedule.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short slash name, e.g. Weekly account health." },
        instructions: {
          type: "string",
          description: "When to use it, steps, expected output, and approval boundaries.",
        },
      },
      required: ["name", "instructions"],
    },
  },
  {
    name: "create_routine",
    description:
      "Schedule a recurring job for this bot (or this group chat). Use when the user says every day, weekdays, every Monday, etc. A routine is when to run; put the how into prompt or a skill.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string", description: "What to do on each run." },
        schedule: {
          type: "string",
          description:
            "Everyday language or a 5-field cron, e.g. 'todo dia às 9' or '0 9 * * 1-5'.",
        },
        timezone: { type: "string", description: "IANA timezone. Defaults to America/Sao_Paulo." },
        active: { type: "boolean", description: "Defaults to true." },
      },
      required: ["name", "prompt", "schedule"],
    },
  },
  {
    name: "run_subagent",
    description:
      "Run a short-lived helper inside this turn only. It is not a bot: no list entry, no thread, no computer of its own, and it disappears when this turn ends. Never call this because the user asked to create a bot — that is spawn_bot, and spawn_bot alone.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short label shown in the thread, e.g. scout or reviewer.",
        },
        task: { type: "string", description: "The work the helper should complete." },
        instructions: {
          type: "string",
          description: "Optional extra system instructions for the helper.",
        },
      },
      required: ["name", "task"],
    },
  },
  {
    name: "spawn_bot",
    description:
      "Create a full, regular bot — the same kind the user creates from the + button. It gets its own thread, computer, and memory, and appears as a peer in the bot list. Do not also call run_subagent. Creating the bot is the whole action. Only set prompt if the user asked that new bot to start work immediately.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        instructions: { type: "string" },
        prompt: {
          type: "string",
          description: "Optional first task to run in the new bot's thread.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "delete_bot",
    description:
      "Permanently delete a bot this bot created, including its thread, computer, memory, and files. Only do this when the user asked or that bot is finished and unused. confirm_name must exactly match its name. This cannot delete you, bots the user created, or bots another bot created.",
    inputSchema: {
      type: "object",
      properties: {
        confirm_name: { type: "string", description: "Exact current name of the bot to delete." },
        bot_id: {
          type: "string",
          description:
            "Optional bot id. If omitted, the unique bot this bot created with confirm_name is deleted.",
        },
      },
      required: ["confirm_name"],
    },
  },
];

export const collaborationAgentTools: ConnectorTool[] = [
  {
    name: "list_teammates",
    description: "List the other bots in this workspace that you can collaborate with.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_bots",
    description: "List the other bots on this team, including who is busy.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "message_teammate",
    description:
      "Send a fire-and-forget message to another bot and wake it to work on the message.",
    inputSchema: {
      type: "object",
      properties: {
        botId: { type: "string" },
        name: { type: "string" },
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
  {
    name: "ask_bot",
    description:
      "Ask another bot a question and wait for its reply before you continue. Use this when you need the answer.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string" },
        botId: { type: "string" },
        name: { type: "string" },
        message: { type: "string" },
      },
      required: ["message"],
    },
  },
];
