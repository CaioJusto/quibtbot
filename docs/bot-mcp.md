# Per-bot MCP tool servers

Each bot can have up to ten additional MCP servers. Configure them in the Portuguese web UI under
**Ajustes → Mais opções → Servidores MCP**. These entries provide tools to that bot at run time;
they do not expose a CLI server for managing Quibt itself.

## Transports

- **Command (stdio):** enter one executable in **Comando** and one argv item per line in
  **Argumentos**. The executable is never interpreted by a shell. The child receives only a small
  safe subset of the host environment plus variables explicitly entered for that server.
- **HTTPS:** enter a public HTTPS MCP endpoint. Cleartext HTTP, embedded URL credentials, private
  addresses, and redirects are refused.

Environment variables may be supplied only while adding a server. List responses and the settings
screen never return them. Server data and tool results are redacted before logs or thread messages
are persisted.

## Tools and approvals

Discovered tools are prefixed as `mcp__name__tool`, using the configured server name, so a remote
tool such as `shell` cannot replace the built-in `shell` tool. MCP calls follow the same approval
gate as every other agent tool. In particular, unattended runs do not auto-approve MCP calls.

A stdio server that cannot spawn or complete its MCP initialization is disabled with a short
reason. Other configured servers and the run continue normally. The process stays alive only for
the run and is terminated when the run ends or is aborted.

## Difference from Plugins MCP

The Plugins overlay already supports user-level HTTP MCP capability installs shared by the user's
runs. Per-bot MCP servers are an additional, bot-scoped list and can use either stdio argv or HTTPS.
Both paths feed the existing executor tool list and approval flow.
