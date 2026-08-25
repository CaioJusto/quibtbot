import { readFileSync } from "node:fs";

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

type Line = { indent: number; text: string };

/**
 * Minimal reader for the YAML subset compose files use (nested maps, scalar lists and
 * JSON-style flow sequences). It exists so the compose policies can be asserted in
 * `verify:fast`, with no new dependency and without needing a Docker daemon.
 */
export function parseComposeYaml(source: string): YamlMap {
  const lines: Line[] = source
    .split("\n")
    .filter((raw) => raw.trim() && !raw.trim().startsWith("#"))
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }));
  const [value] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  return (value ?? {}) as YamlMap;
}

export function readComposeFile(file: string): YamlMap {
  return parseComposeYaml(readFileSync(file, "utf8"));
}

export function composeServices(config: YamlMap): Record<string, YamlMap> {
  return (config.services ?? {}) as Record<string, YamlMap>;
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  if (lines[start]?.text.startsWith("- ")) return parseSequence(lines, start, indent);
  const map: YamlMap = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.indent < indent) break;
    if (line.indent > indent) throw new Error(`unexpected indentation: ${line.text}`);
    const separator = line.text.indexOf(":");
    if (separator < 0) throw new Error(`expected "key: value": ${line.text}`);
    const key = line.text.slice(0, separator).trim();
    const inline = line.text.slice(separator + 1).trim();
    index += 1;
    if (inline) {
      map[key] = parseScalar(inline);
      continue;
    }
    const next = lines[index];
    if (next && next.indent > indent) {
      const [value, consumed] = parseBlock(lines, index, next.indent);
      map[key] = value;
      index = consumed;
    } else {
      map[key] = null;
    }
  }
  return [map, index];
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.indent < indent || !line.text.startsWith("- ")) break;
    items.push(parseScalar(line.text.slice(2).trim()));
    index += 1;
  }
  return [items, index];
}

function parseScalar(raw: string): YamlValue {
  if (raw.startsWith("[") || raw.startsWith("{")) return JSON.parse(raw) as YamlValue;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}
