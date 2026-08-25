export type SelectOption = {
  id: string;
  label: string;
  /** Second line, when the id says something the label does not (`deepseek/deepseek-v4`). */
  hint?: string;
};

/** Lowercase and unaccented, so "gpt" finds "GPT" and "codestral" finds "Codestral". */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Narrows a list of options by a typed query.
 *
 * The OpenRouter catalogue alone is over three hundred models. Every term has to match
 * somewhere — label, hint or id — so "claude haiku" finds the one model whose words are split
 * across name and id, which a single substring test would miss.
 */
export function filterSelectOptions(options: SelectOption[], query: string): SelectOption[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return options;
  return options.filter((option) => {
    const haystack = normalize(`${option.label} ${option.hint ?? ""} ${option.id}`);
    return terms.every((term) => haystack.includes(term));
  });
}

/** What the closed field shows: the chosen option's label, or a prompt to open it. */
export function selectedOptionLabel(
  options: SelectOption[],
  id: string | null | undefined,
  fallback = "Escolher",
): string {
  if (!id) return fallback;
  return options.find((option) => option.id === id)?.label ?? id;
}
