import { radii } from "@quibt/ui-tokens";
import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { COLORS } from "./design-system";
import { filterSelectOptions, type SelectOption, selectedOptionLabel } from "./select-options";

/**
 * A single-line field that opens a searchable sheet, for lists too long to lay out flat.
 *
 * "Modelo" used to print one row per catalogue entry: over three hundred of them behind an
 * OpenRouter key, so the card scrolled forever and the rest of it was unreachable. Web solves
 * this with a `<select>`; React Native has none, and a wheel picker with three hundred entries
 * cannot be searched, so the sheet carries its own search field.
 */
export function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder = "Escolher",
  searchPlaceholder = "Buscar",
  disabled,
}: {
  label: string;
  value: string | null | undefined;
  options: SelectOption[];
  onChange: (id: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterSelectOptions(options, query), [options, query]);
  const current = selectedOptionLabel(options, value, placeholder);

  function close() {
    setOpen(false);
    // A busca da próxima abertura começa limpa: o filtro de ontem escondia a lista inteira.
    setQuery("");
  }

  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${current}`}
        accessibilityState={{ disabled: Boolean(disabled) || options.length === 0 }}
        disabled={disabled || options.length === 0}
        onPress={() => setOpen(true)}
        style={styles.field}
      >
        <Text numberOfLines={1} style={styles.fieldValue}>
          {options.length === 0 ? "—" : current}
        </Text>
        <Text style={styles.chevron}>⌄</Text>
      </Pressable>

      <Modal
        animationType="slide"
        onRequestClose={close}
        statusBarTranslucent
        transparent
        visible={open}
      >
        <View style={styles.backdrop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fechar"
            onPress={close}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>{label}</Text>
              <Pressable accessibilityRole="button" onPress={close}>
                <Text style={styles.sheetClose}>Fechar</Text>
              </Pressable>
            </View>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
              placeholderTextColor={COLORS.tertiary}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.search}
            />
            <FlatList
              data={shown}
              keyExtractor={(option) => option.id}
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              ListEmptyComponent={<Text style={styles.empty}>Nada com esse nome.</Text>}
              renderItem={({ item }) => {
                const active = item.id === value;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      onChange(item.id);
                      close();
                    }}
                    style={styles.row}
                  >
                    <View style={styles.rowText}>
                      <Text
                        numberOfLines={1}
                        style={active ? styles.rowLabelActive : styles.rowLabel}
                      >
                        {item.label}
                      </Text>
                      {item.hint && item.hint !== item.label ? (
                        <Text numberOfLines={1} style={styles.rowHint}>
                          {item.hint}
                        </Text>
                      ) : null}
                    </View>
                    {active ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  label: { color: COLORS.secondary, fontSize: 13, marginTop: 14 },
  field: {
    alignItems: "center",
    backgroundColor: COLORS.background,
    borderColor: COLORS.separator,
    borderRadius: radii.sm,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  fieldValue: { color: COLORS.primary, flex: 1, fontSize: 16 },
  chevron: { color: COLORS.secondary, fontSize: 16, marginTop: -4 },
  backdrop: { backgroundColor: COLORS.scrim, flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    maxHeight: "78%",
    paddingBottom: 28,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  sheetHead: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  sheetTitle: { color: COLORS.primary, fontSize: 17, fontWeight: "600" },
  sheetClose: { color: COLORS.blue, fontSize: 16 },
  search: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.separator,
    borderRadius: radii.sm,
    borderWidth: 1,
    color: COLORS.primary,
    fontSize: 16,
    marginTop: 12,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  list: { marginTop: 8 },
  row: {
    alignItems: "center",
    borderBottomColor: COLORS.separator,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 13,
  },
  rowText: { flex: 1 },
  rowLabel: { color: COLORS.primary, fontSize: 16 },
  rowLabelActive: { color: COLORS.blue, fontSize: 16, fontWeight: "600" },
  rowHint: { color: COLORS.tertiary, fontSize: 12, marginTop: 2 },
  check: { color: COLORS.blue, fontSize: 16 },
  empty: { color: COLORS.secondary, fontSize: 15, paddingVertical: 18 },
});
