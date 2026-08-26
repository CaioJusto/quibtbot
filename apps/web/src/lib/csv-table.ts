/**
 * Planilha de texto (CSV/TSV) lida como tabela, sem biblioteca.
 *
 * O visualizador de arquivos já abre CSV como texto puro, e uma planilha em texto puro é
 * ilegível: as colunas não batem e as aspas aparecem. Aqui o arquivo vira linhas e células
 * para a tabela desenhar. Só isto: nada de tipos, fórmulas ou ordenação — o que não é
 * texto separado por vírgula continua baixando.
 *
 * `.xlsx` não passa por aqui: é binário e segue como download.
 */

/** Quantas linhas a tabela desenha. Acima disto a rolagem custa mais do que ajuda. */
export const CSV_MAX_ROWS = 500;
/** Teto de colunas. Planilha exportada de sistema às vezes traz centenas de colunas vazias. */
export const CSV_MAX_COLUMNS = 60;

export type CsvTable = {
  /** Primeira linha do arquivo — a tabela a usa como cabeçalho. */
  header: string[];
  rows: string[][];
  /** Quantas linhas de dados o arquivo tem no total, mesmo as que não desenhamos. */
  totalRows: number;
  /** Quantas colunas o arquivo tem na linha mais larga, mesmo as que não desenhamos. */
  totalColumns: number;
  /** O separador que o arquivo usa de fato, para a tela poder dizer qual foi. */
  delimiter: string;
};

const DELIMITERS = [",", ";", "\t", "|"] as const;

const SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv"]);
const SPREADSHEET_MIMES = new Set([
  "text/csv",
  "text/tab-separated-values",
  "application/csv",
  "text/comma-separated-values",
]);

function extensionOf(name: string | undefined): string {
  const clean = (name ?? "").split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

/**
 * Se este arquivo merece a tabela em vez do texto cru. O tipo MIME manda; quando ele vem
 * genérico, a extensão desempata — a mesma regra do resto do visualizador.
 */
export function isSpreadsheetFile(mimeType: string | undefined, name?: string): boolean {
  const mime = (mimeType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (SPREADSHEET_MIMES.has(mime)) return true;
  return SPREADSHEET_EXTENSIONS.has(extensionOf(name));
}

/**
 * Qual separador o arquivo usa. Vale a contagem na primeira linha de verdade, fora das aspas:
 * o cabeçalho de um CSV brasileiro exportado do Excel vem com ponto e vírgula, e chutar
 * vírgula transformaria a planilha inteira numa coluna só.
 */
export function detectDelimiter(text: string, name?: string): string {
  if (extensionOf(name) === "tsv") return "\t";
  const sample = firstLogicalLine(text);
  let best = ",";
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    const count = countOutsideQuotes(sample, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** A primeira linha do arquivo, pulando quebras que estejam dentro de aspas. */
function firstLogicalLine(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) return text.slice(0, i);
  }
  return text;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === delimiter) count += 1;
  }
  return count;
}

/**
 * Leitura no estilo RFC 4180: aspas protegem separador e quebra de linha, e duas aspas
 * seguidas dentro do campo valem uma aspa.
 */
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === "\r") {
      // \r\n conta como uma quebra só; \r sozinho (Mac antigo) também quebra.
      if (text[i + 1] === "\n") i += 1;
      endRow();
      continue;
    }
    if (char === "\n") {
      endRow();
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) endRow();

  // A quebra final do arquivo não é uma linha vazia de dados.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last && last.length === 1 && last[0] === "") rows.pop();
    else break;
  }
  return rows;
}

/**
 * O arquivo virado em tabela, ou `null` quando não há tabela nenhuma ali: uma coluna só
 * não é planilha, é texto — e texto é melhor lido no visualizador de texto.
 */
export function parseCsvTable(text: string, name?: string): CsvTable | null {
  const delimiter = detectDelimiter(text, name);
  const all = parseRows(text, delimiter);
  if (all.length === 0) return null;

  const totalColumns = all.reduce((widest, line) => Math.max(widest, line.length), 0);
  if (totalColumns < 2) return null;

  const columns = Math.min(totalColumns, CSV_MAX_COLUMNS);
  const clip = (line: string[]) =>
    Array.from({ length: columns }, (_, index) => line[index]?.trim() ?? "");

  const [first, ...rest] = all;
  return {
    header: clip(first ?? []),
    rows: rest.slice(0, CSV_MAX_ROWS).map(clip),
    totalRows: rest.length,
    totalColumns,
    delimiter,
  };
}

/** O nome do separador em português, para a legenda embaixo da tabela. */
export function delimiterLabel(delimiter: string): string {
  if (delimiter === "\t") return "tabulação";
  if (delimiter === ";") return "ponto e vírgula";
  if (delimiter === "|") return "barra";
  return "vírgula";
}

/**
 * A frase honesta embaixo da tabela: quantas linhas o arquivo tem, e o que ficou de fora
 * quando ele é maior do que a tela desenha.
 */
export function csvTableNote(table: CsvTable): string {
  const rowWord = table.totalRows === 1 ? "linha" : "linhas";
  const shown = table.rows.length;
  const base = `${table.totalRows} ${rowWord} · separado por ${delimiterLabel(table.delimiter)}`;
  const parts: string[] = [];
  if (shown < table.totalRows) parts.push(`mostrando as ${shown} primeiras`);
  if (table.totalColumns > table.header.length) {
    parts.push(`${table.totalColumns - table.header.length} colunas fora da tela`);
  }
  if (!parts.length) return base;
  return `${base} · ${parts.join(" · ")} — baixe o arquivo para ver tudo`;
}
