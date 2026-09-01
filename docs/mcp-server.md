# Quibt Bot MCP server

`quibtbot mcp` is a bounded stdio control plane for the roster already running in your Quibt
installation. Claude Desktop, Cursor, Codex, and other MCP clients can inspect bot/group threads,
send work, wait for runs, interrupt them, and select a connected model. The MCP process does not
start Quibt: keep the local API running first.

The default connection is `http://127.0.0.1:3100`. The CLI verifies that this port is serving Quibt,
then requests the installation's loopback-only local owner session. To use another deployment, set
`QUIBTBOT_URL`. Set `QUIBTBOT_TOKEN` to an existing Quibt session bearer token only together with an
explicit `QUIBTBOT_URL`; the CLI will never send a credential while probing local ports.

Remote cleartext HTTP is refused. Use HTTPS, or explicitly set `ALLOW_INSECURE_HTTP=true` only for a
trusted private network whose transport risk you accept.

## Cursor

Add this to `.cursor/mcp.json` (project scope) or Cursor's user MCP configuration:

```json
{
  "mcpServers": {
    "quibtbot": {
      "command": "quibtbot",
      "args": ["mcp"]
    }
  }
}
```

For a remote HTTPS deployment, pass environment variables through the client configuration:

```json
{
  "mcpServers": {
    "quibtbot": {
      "command": "quibtbot",
      "args": ["mcp"],
      "env": {
        "QUIBTBOT_URL": "https://quibt.example.com",
        "QUIBTBOT_TOKEN": "your-existing-quibt-session-token"
      }
    }
  }
}
```

The same command/arguments pair works in Claude Desktop and Codex MCP server configuration. Restart
the MCP client after changing its configuration.

## Tools

Inspect:

- `get_system_health`
- `list_bots`
- `list_groups`
- `get_bot_messages`
- `get_group_messages`
- `search_messages`
- `list_available_models`

Run:

- `send_bot_message`
- `send_group_message`
- `wait_for_conversation`
- `interrupt_conversation`
- `set_bot_model`

`wait_for_conversation` and `interrupt_conversation` accept either a bot or a group. For a group,
pass the `run_ids` returned by `send_group_message` when you need to wait for that specific turn.

`set_bot_model` checks that the selected bot has no active run, then selects the connected
provider/model used by subsequent runs. Quibt's current model RPC stores that selection as the
owner's default, so it also becomes the default for other bots owned by the same account.

Transcript reads are paged and capped at 50 messages per call. Search is capped at 20 results. MCP
responses omit screenshot pixels, screen-control URLs, credential/secret-looking fields, approval
policy fields, and computer lifecycle state.

The allowlist intentionally has no tools for approval grants, deletion, credentials, pairing
secrets, computer/VM lifecycle, team-pack import, or settings dumps. Unknown tools and unknown input
fields are rejected.

## Troubleshooting

- `Quibt API was not found`: start the local Quibt stack and confirm port `3100` is available.
- `Could not create a local Quibt session`: open/claim the installation locally first, or configure
  an explicit HTTPS URL and an existing session token.
- Authentication failure against a remote URL: refresh the Quibt session token in the MCP client's
  environment.

MCP JSON-RPC uses stdout exclusively. Diagnostics and startup failures go to stderr, so redirecting
or decorating stdout will break the protocol.
