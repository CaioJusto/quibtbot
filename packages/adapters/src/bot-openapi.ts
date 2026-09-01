import type { ConnectorTool } from "@quibt/adapter-kit";
import { BOT_OPENAPI_LIMITS } from "@quibt/contracts";
import { parse as parseYaml } from "yaml";
import { builtinAgentTools } from "./builtin-tools.js";
import { type ResolveHost, validatePublicHttpsEndpoint } from "./mcp-http.js";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
type OpenApiMethod = (typeof METHODS)[number];
const METHOD_SET = new Set<string>(METHODS);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_KEY =
  /(^|[_-])(api[_-]?key|authorization|cookie|credential|password|secret|signature|token)([_-]|$)/i;
const CREDENTIAL_QUERY_KEY =
  /(^|[_-])(access[_-]?token|api[_-]?key|auth|authorization|credential|password|secret|signature|token)([_-]|$)/i;

export type RuntimeBotOpenApiSource = {
  id: string;
  workspaceId: string;
  botId: string;
  name: string;
  url: string;
  enabled: boolean;
};

export type BotOpenApiRuntime = {
  tools: ConnectorTool[];
  has(toolName: string): boolean;
  call(toolName: string, args: Record<string, unknown>): Promise<unknown>;
};

export type BotOpenApiRuntimeOptions = {
  fetchImpl?: typeof fetch;
  resolver?: ResolveHost;
  signal?: AbortSignal;
  maxTools?: number;
  disable?: (source: RuntimeBotOpenApiSource, reason: string) => Promise<unknown>;
};

type JsonObject = Record<string, unknown>;
type OperationCall = (args: Record<string, unknown>) => Promise<unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function slug(value: string, max = 48): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, max) || "source"
  );
}

function operationSlug(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "operation"
  );
}

export function openApiToolName(sourceName: string, method: string, operation: string): string {
  return `oa__${slug(sourceName, 32).toLowerCase()}__${method.toLowerCase()}__${operationSlug(operation)}`;
}

export function parseOpenApiToolName(
  name: string,
): { sourceSlug: string; method: OpenApiMethod; operation: string } | null {
  const match = /^oa__(.+?)__(get|put|post|delete|patch|head|options)__(.+)$/i.exec(name);
  const method = match?.[2]?.toLowerCase();
  if (!match?.[1] || !method || !METHOD_SET.has(method) || !match[3]) return null;
  return { sourceSlug: match[1], method: method as OpenApiMethod, operation: match[3] };
}

export function isOpenApiReadMethod(methodOrTool: string): boolean {
  const parsed = parseOpenApiToolName(methodOrTool);
  const method = parsed?.method ?? methodOrTool.toLowerCase();
  return method === "get" || method === "head" || method === "options";
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /(password|secret|token|api[_-]?key|authorization|cookie)"?\s*[:=]\s*"?[^\s"',}]+/gi,
      "$1=[redacted]",
    )
    .replace(/\bey[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[redacted]");
}

/** Removes credential-shaped fields before OpenAPI args/results enter effects or transcripts. */
export function openApiValueForTranscript(value: unknown, depth = 0): unknown {
  if (depth > 16) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => openApiValueForTranscript(item, depth + 1));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : openApiValueForTranscript(item, depth + 1),
    ]),
  );
}

function failureReason(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
}

function assertNoCredentialQuery(url: URL, label: string): void {
  if ([...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY_KEY.test(key))) {
    throw new Error(`${label} must not contain credential query parameters`);
  }
}

function pointerValue(document: JsonObject, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error("OpenAPI remote references are not allowed");
  let current: unknown = document;
  for (const raw of ref.slice(2).split("/")) {
    const key = decodeURIComponent(raw.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!isObject(current) && !Array.isArray(current)) {
      throw new Error(`OpenAPI reference not found: ${ref}`);
    }
    current = (current as JsonObject)[key];
  }
  if (current === undefined) throw new Error(`OpenAPI reference not found: ${ref}`);
  return current;
}

function dereference(
  value: unknown,
  document: JsonObject,
  depth = 0,
  trail: ReadonlySet<string> = new Set(),
): unknown {
  if (depth > BOT_OPENAPI_LIMITS.refDepth) {
    throw new Error(`OpenAPI reference depth exceeds ${BOT_OPENAPI_LIMITS.refDepth}`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => dereference(item, document, depth, trail));
  }
  if (!isObject(value)) return value;
  const ref = typeof value.$ref === "string" ? value.$ref : null;
  if (ref) {
    if (!ref.startsWith("#/")) throw new Error("OpenAPI remote references are not allowed");
    if (trail.has(ref)) return {};
    const nextTrail = new Set(trail);
    nextTrail.add(ref);
    const target = dereference(pointerValue(document, ref), document, depth + 1, nextTrail);
    const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
    const resolvedSiblings = dereference(siblings, document, depth + 1, nextTrail);
    return isObject(target) && isObject(resolvedSiblings)
      ? { ...target, ...resolvedSiblings }
      : target;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, dereference(item, document, depth, trail)]),
  );
}

function assertNoRemoteReferences(value: unknown, depth = 0): void {
  if (depth > 64) return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoRemoteReferences(item, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#/")) {
    throw new Error("OpenAPI remote references are not allowed");
  }
  for (const item of Object.values(value)) assertNoRemoteReferences(item, depth + 1);
}

function parseDocument(text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = parseYaml(text, { maxAliasCount: 100 });
  }
  if (!isObject(value) || typeof value.openapi !== "string" || !/^3(?:\.|$)/.test(value.openapi)) {
    throw new Error("OpenAPI document must declare openapi 3.x");
  }
  if (!isObject(value.paths)) throw new Error("OpenAPI document must contain paths");
  assertNoRemoteReferences(value);
  return value;
}

async function readLimited(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error(`${label} is too large`);
  if (!response.body) {
    const bytes = new TextEncoder().encode(await response.text());
    if (bytes.byteLength > limit) throw new Error(`${label} is too large`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`${label} is too large`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchSpec(
  source: RuntimeBotOpenApiSource,
  options: BotOpenApiRuntimeOptions,
): Promise<{ document: JsonObject; finalUrl: URL }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current = await validatePublicHttpsEndpoint(source.url, "OpenAPI URL", options.resolver);
  current.hash = "";
  assertNoCredentialQuery(current, "OpenAPI URL");
  const timeout = AbortSignal.timeout(BOT_OPENAPI_LIMITS.fetchTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json, application/yaml, text/yaml, application/x-yaml, text/plain",
      },
      signal,
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      if (redirects >= BOT_OPENAPI_LIMITS.redirects) {
        throw new Error(`OpenAPI URL exceeded ${BOT_OPENAPI_LIMITS.redirects} redirects`);
      }
      const location = response.headers.get("location");
      if (!location) throw new Error("OpenAPI redirect is missing a location");
      current = await validatePublicHttpsEndpoint(
        new URL(location, current).href,
        "OpenAPI redirect",
        options.resolver,
      );
      current.hash = "";
      assertNoCredentialQuery(current, "OpenAPI redirect");
      continue;
    }
    if (!response.ok) throw new Error(`OpenAPI URL returned HTTP ${response.status}`);
    const bytes = await readLimited(response, BOT_OPENAPI_LIMITS.specBytes, "OpenAPI document");
    return { document: parseDocument(new TextDecoder().decode(bytes)), finalUrl: current };
  }
}

function serverUrl(
  document: JsonObject,
  pathItem: JsonObject,
  operation: JsonObject,
  specUrl: URL,
): URL | null {
  const candidates = [operation.servers, pathItem.servers, document.servers];
  let raw: string | undefined;
  let variables: JsonObject | undefined;
  for (const candidate of candidates) {
    const first = Array.isArray(candidate) && isObject(candidate[0]) ? candidate[0] : null;
    if (first && typeof first.url === "string") {
      raw = first.url;
      variables = isObject(first.variables) ? first.variables : undefined;
      break;
    }
  }
  let expanded = raw ?? `${specUrl.origin}/`;
  expanded = expanded.replace(/\{([^}]+)\}/g, (match, key: string) => {
    const variable = variables?.[key];
    return isObject(variable) && typeof variable.default === "string" ? variable.default : match;
  });
  if (expanded.includes("{")) return null;
  let url: URL;
  try {
    url = new URL(expanded, specUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if ([...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY_KEY.test(key))) return null;
  url.hash = "";
  return url;
}

function operationInputSchema(
  document: JsonObject,
  pathItem: JsonObject,
  operation: JsonObject,
): {
  schema: JsonObject;
  parameters: Array<{ name: string; in: "path" | "query"; required: boolean }>;
} {
  const properties: JsonObject = {};
  const required = new Set<string>();
  const parameters: Array<{ name: string; in: "path" | "query"; required: boolean }> = [];
  const rawParameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];
  for (const raw of rawParameters) {
    const parameter = dereference(raw, document);
    if (!isObject(parameter) || typeof parameter.name !== "string") continue;
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    const name = parameter.name;
    properties[name] = isObject(parameter.schema)
      ? dereference(parameter.schema, document)
      : { type: "string" };
    const isRequired = parameter.in === "path" || parameter.required === true;
    if (isRequired) required.add(name);
    parameters.push({ name, in: parameter.in, required: isRequired });
  }
  if (operation.requestBody) {
    const requestBody = dereference(operation.requestBody, document);
    if (isObject(requestBody) && isObject(requestBody.content)) {
      const jsonEntry = Object.entries(requestBody.content).find(
        ([contentType]) => contentType === "application/json" || contentType.endsWith("+json"),
      );
      const media = jsonEntry?.[1];
      if (isObject(media)) {
        properties.body = isObject(media.schema)
          ? dereference(media.schema, document)
          : { type: "object" };
        if (requestBody.required === true) required.add("body");
      }
    }
  }
  return {
    schema: {
      type: "object",
      properties,
      ...(required.size ? { required: [...required] } : {}),
      additionalProperties: false,
    },
    parameters,
  };
}

function operationUrl(
  base: URL,
  path: string,
  parameters: Array<{ name: string; in: "path" | "query"; required: boolean }>,
  args: Record<string, unknown>,
): URL {
  let targetPath = path;
  for (const parameter of parameters.filter((item) => item.in === "path")) {
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      throw new Error(`OpenAPI path parameter is required: ${parameter.name}`);
    }
    targetPath = targetPath.replaceAll(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }
  if (/\{[^}]+\}/.test(targetPath)) throw new Error("OpenAPI path has unresolved parameters");
  const url = new URL(base.href);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/${targetPath.replace(/^\//, "")}`;
  url.search = "";
  url.hash = "";
  for (const parameter of parameters.filter((item) => item.in === "query")) {
    const value = args[parameter.name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(parameter.name, String(item));
    } else {
      url.searchParams.set(parameter.name, String(value));
    }
  }
  return url;
}

async function callOperation(
  method: OpenApiMethod,
  base: URL,
  path: string,
  parameters: Array<{ name: string; in: "path" | "query"; required: boolean }>,
  args: Record<string, unknown>,
  options: BotOpenApiRuntimeOptions,
): Promise<unknown> {
  const target = operationUrl(base, path, parameters, args);
  const endpoint = await validatePublicHttpsEndpoint(
    target.href,
    "OpenAPI operation",
    options.resolver,
  );
  assertNoCredentialQuery(endpoint, "OpenAPI operation");
  const readOnly = isOpenApiReadMethod(method);
  const timeout = AbortSignal.timeout(BOT_OPENAPI_LIMITS.fetchTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    method: method.toUpperCase(),
    redirect: "manual",
    headers: readOnly
      ? { accept: "application/json, text/plain" }
      : { "content-type": "application/json", accept: "application/json, text/plain" },
    ...(readOnly || args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
    signal,
  });
  if (REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel();
    throw new Error("OpenAPI operation redirects are not allowed");
  }
  const bytes = await readLimited(response, BOT_OPENAPI_LIMITS.responseBytes, "OpenAPI response");
  const text = new TextDecoder().decode(bytes);
  let body: unknown = text;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (text && (contentType.includes("json") || /^[\s]*[[{]/.test(text))) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return openApiValueForTranscript({ status: response.status, ok: response.ok, body });
}

function collectOperations(
  source: RuntimeBotOpenApiSource,
  document: JsonObject,
  specUrl: URL,
  options: BotOpenApiRuntimeOptions,
): Array<{ tool: ConnectorTool; call: OperationCall }> {
  const paths = document.paths as JsonObject;
  const operations: Array<{ tool: ConnectorTool; call: OperationCall }> = [];
  for (const [path, rawPathItem] of Object.entries(paths)) {
    const resolvedPathItem = dereference(rawPathItem, document);
    if (!isObject(resolvedPathItem)) continue;
    for (const method of METHODS) {
      const rawOperation = resolvedPathItem[method];
      if (!isObject(rawOperation) || rawOperation.deprecated === true) continue;
      const base = serverUrl(document, resolvedPathItem, rawOperation, specUrl);
      if (!base) continue;
      const fallback = `${method}_${slug(path.replace(/[{}]/g, ""), 56)}`;
      const operation =
        typeof rawOperation.operationId === "string" && rawOperation.operationId.trim()
          ? rawOperation.operationId.trim()
          : fallback;
      const name = openApiToolName(source.name, method, operation);
      const { schema, parameters } = operationInputSchema(document, resolvedPathItem, rawOperation);
      operations.push({
        tool: {
          name,
          description: `${method.toUpperCase()} ${path} (${source.name})`,
          inputSchema: schema,
        },
        call: (args) => callOperation(method, base, path, parameters, args, options),
      });
      if (operations.length >= BOT_OPENAPI_LIMITS.operationsPerSource) return operations;
    }
  }
  return operations;
}

/** Loads every enabled source independently; a bad document is disabled and contributes no tools. */
export async function loadBotOpenApiTools(
  input: RuntimeBotOpenApiSource[],
  options: BotOpenApiRuntimeOptions = {},
): Promise<BotOpenApiRuntime> {
  const sources = input
    .filter((source) => source.enabled)
    .slice(0, BOT_OPENAPI_LIMITS.sourcesPerBot);
  const maxTools = Math.max(
    0,
    Math.min(
      options.maxTools ?? BOT_OPENAPI_LIMITS.operationsTotal,
      BOT_OPENAPI_LIMITS.operationsTotal,
    ),
  );
  const builtinNames = new Set(builtinAgentTools.map((tool) => tool.name));
  const calls = new Map<string, OperationCall>();
  const discovered = await Promise.all(
    sources.map(async (source): Promise<ConnectorTool[]> => {
      try {
        const { document, finalUrl } = await fetchSpec(source, options);
        return collectOperations(source, document, finalUrl, options).flatMap(({ tool, call }) => {
          if (builtinNames.has(tool.name) || calls.has(tool.name)) return [];
          calls.set(tool.name, call);
          return [tool];
        });
      } catch (error) {
        if (!options.signal?.aborted) {
          await options.disable?.(source, failureReason(error)).catch(() => undefined);
        }
        return [];
      }
    }),
  );
  const tools = discovered.flat().slice(0, maxTools);
  const allowed = new Set(tools.map((tool) => tool.name));
  for (const name of calls.keys()) {
    if (!allowed.has(name)) calls.delete(name);
  }
  return {
    tools,
    has: (name) => calls.has(name),
    async call(name, args) {
      const call = calls.get(name);
      if (!call) return { error: `OpenAPI tool not found for ${name}` };
      return call(args);
    },
  };
}
