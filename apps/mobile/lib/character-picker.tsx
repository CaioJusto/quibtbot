import {
  DEFAULT_APPEARANCE,
  MARK_STYLE_LABELS,
  type MarkShape,
  PICKER_SHAPES,
} from "@quibt/ui-tokens";
import * as Haptics from "expo-haptics";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { AgentMark } from "./agent-mark";
import { COLORS } from "./design-system";

const PICKER_COLORS = {
  card: COLORS.card,
  secondary: COLORS.secondary,
  separator: COLORS.separator,
  blue: COLORS.blue,
} as const;

function selectionHaptic() {
  if (Platform.OS === "ios") void Haptics.selectionAsync().catch(() => undefined);
}

export function CharacterPicker(props: {
  color: string;
  shape: string;
  onChange: (next: { color: string; shape: MarkShape }) => void;
}) {
  const { color, shape, onChange } = props;

  return (
    <View style={styles.card}>
      <Text style={styles.sectionLabel}>Formato</Text>
      <View style={styles.shapes}>
        {PICKER_SHAPES.map((id) => {
          const selected = shape === id;
          return (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={`Formato ${MARK_STYLE_LABELS[id]}`}
              accessibilityState={{ selected }}
              onPress={() => {
                selectionHaptic();
                onChange({ color, shape: id });
              }}
              style={[styles.shapeChoice, selected && styles.shapeSelected]}
            >
              <AgentMark color={color} shape={id} size={60} />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.separator} />
      <Text style={styles.sectionLabel}>Cor</Text>
      <View style={styles.palette}>
        <ColorChoice
          label="Branco"
          value="#FFFFFF"
          swatchStyle={swatchStyles.white}
          selected={color.toLowerCase() === "#ffffff"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Azul marinho"
          value="#0B3A78"
          swatchStyle={swatchStyles.navy}
          selected={color.toLowerCase() === "#0b3a78"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Azul Quibt"
          value="#5B7FE5"
          swatchStyle={swatchStyles.strobi}
          selected={color.toLowerCase() === "#5b7fe5"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Coral"
          value="#E6855C"
          swatchStyle={swatchStyles.freddy}
          selected={color.toLowerCase() === "#e6855c"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Amarelo"
          value="#FFCF24"
          swatchStyle={swatchStyles.citrus}
          selected={color.toLowerCase() === "#ffcf24"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Turquesa"
          value="#55B6C3"
          swatchStyle={swatchStyles.nova}
          selected={color.toLowerCase() === "#55b6c3"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Preto"
          value="#111316"
          swatchStyle={swatchStyles.grok}
          selected={color.toLowerCase() === "#111316" || color.toLowerCase() === "#000000"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Laranja"
          value="#E69A5C"
          swatchStyle={swatchStyles.sunee}
          selected={color.toLowerCase() === "#e69a5c"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Rosa"
          value="#FFC2E9"
          swatchStyle={swatchStyles.kirby}
          selected={color.toLowerCase() === "#ffc2e9"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Cinza"
          value="#C9CBCF"
          swatchStyle={swatchStyles.cloudee}
          selected={color.toLowerCase() === "#c9cbcf"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Vermelho"
          value="#E65C5C"
          swatchStyle={swatchStyles.cubee}
          selected={color.toLowerCase() === "#e65c5c"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Azul gelo"
          value="#DBE2F5"
          swatchStyle={swatchStyles.onee}
          selected={color.toLowerCase() === "#dbe2f5"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Verde água"
          value="#4ECDC4"
          swatchStyle={swatchStyles.pip}
          selected={color.toLowerCase() === "#4ecdc4"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
        <ColorChoice
          label="Prata"
          value="#B4B7BC"
          swatchStyle={swatchStyles.loom}
          selected={color.toLowerCase() === "#b4b7bc"}
          shape={shape as MarkShape}
          onChange={onChange}
        />
      </View>
      <View style={styles.separator} />
      <Pressable
        onPress={() => {
          selectionHaptic();
          onChange({ ...DEFAULT_APPEARANCE });
        }}
        style={styles.reset}
      >
        <Text style={styles.resetText}>Voltar ao padrão</Text>
      </Pressable>
    </View>
  );
}

function ColorChoice(props: {
  label: string;
  value: string;
  swatchStyle: object;
  selected: boolean;
  shape: MarkShape;
  onChange: (next: { color: string; shape: MarkShape }) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={() => {
        selectionHaptic();
        props.onChange({ color: props.value, shape: props.shape });
      }}
      style={[styles.colorChoice, props.selected && styles.colorSelected]}
    >
      <View style={[styles.color, props.swatchStyle]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: PICKER_COLORS.card, borderRadius: 16, overflow: "hidden" },
  sectionLabel: {
    color: PICKER_COLORS.secondary,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.35,
    textTransform: "uppercase",
    paddingHorizontal: 18,
    paddingTop: 18,
  },
  shapes: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 6,
  },
  shapeChoice: {
    width: 72,
    height: 76,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  shapeSelected: { borderColor: COLORS.separator, backgroundColor: COLORS.tile },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: PICKER_COLORS.separator },
  palette: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 20,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  colorChoice: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: "transparent",
  },
  colorSelected: {
    borderColor: PICKER_COLORS.blue,
    backgroundColor: "rgba(0,113,251,0.14)",
  },
  color: { width: 34, height: 34, borderRadius: 17 },
  reset: { minHeight: 54, paddingHorizontal: 18, justifyContent: "center" },
  resetText: { color: PICKER_COLORS.blue, fontSize: 17, fontWeight: "600" },
});

const swatchStyles = StyleSheet.create({
  white: { backgroundColor: "#FFFFFF" },
  navy: { backgroundColor: "#0B3A78" },
  strobi: { backgroundColor: "#5B7FE5" },
  freddy: { backgroundColor: "#E6855C" },
  citrus: { backgroundColor: "#FFCF24" },
  nova: { backgroundColor: "#55B6C3" },
  grok: { backgroundColor: "#111316" },
  sunee: { backgroundColor: "#E69A5C" },
  kirby: { backgroundColor: "#FFC2E9" },
  cloudee: { backgroundColor: "#C9CBCF" },
  cubee: { backgroundColor: "#E65C5C" },
  onee: { backgroundColor: "#DBE2F5" },
  pip: { backgroundColor: "#4ECDC4" },
  loom: { backgroundColor: "#B4B7BC" },
});
