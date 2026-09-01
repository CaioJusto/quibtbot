# Per-bot OpenAPI tools

Each bot can have up to ten OpenAPI 3 document sources. Add a public JSON or YAML document in the
Portuguese web UI under **Ajustes → Mais opções → Ferramentas OpenAPI**. The document URL must use
HTTPS and cannot contain embedded credentials. API keys and authentication headers are not
supported.

## Discovery and calls

Operations become bot-scoped tools named `oa__source__method__operation`, for example
`oa__pets__get__listPets`. The source name keeps tools separate from built-in and plugin tools.
Only OpenAPI 3 documents and local `#/components/...` references are accepted. Documents,
operation counts, redirects, reference depth, responses, and request time are bounded.

The first OpenAPI server URL, or the document origin when none is declared, supplies the operation
base URL. Both the document and operation targets must be public HTTPS endpoints without embedded
credentials. Cleartext or private-network targets are refused.

## Approvals and failures

`GET`, `HEAD`, and `OPTIONS` operations are read-only and use the same safe treatment as a web
fetch. `POST`, `PUT`, `PATCH`, and `DELETE` are side-effecting and go through the existing approval
cards. Unattended runs never auto-approve those mutations. Credential-shaped fields are redacted
before tool arguments or results are persisted.

If a document cannot be fetched or parsed, that source is disabled with a short reason. Other
sources and the bot run continue.

## Difference from MCP

OpenAPI sources describe ordinary HTTPS request/response operations from an OpenAPI 3 document.
MCP servers expose tools through the MCP protocol and may use stdio or HTTPS. They are separate
per-bot lists, use different tool prefixes, and both feed the same executor and approval gate.
