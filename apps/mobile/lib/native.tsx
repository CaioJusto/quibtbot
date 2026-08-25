import { radii, tokens } from "@quibt/ui-tokens";
import { SymbolView } from "expo-symbols";
import { useSyncExternalStore } from "react";
import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";

export type AppSymbolName =
  | "chevron.left"
  | "chevron.down"
  | "desktopcomputer"
  | "plus"
  | "mic.fill"
  | "ellipsis"
  | "xmark"
  | "plus.circle.fill"
  | "person.2.fill"
  | "magnifyingglass"
  | "puzzlepiece.extension.fill"
  | "checkmark.circle.fill"
  | "circle"
  | "arrow.up.right.square"
  | "trash"
  | "chevron.right"
  | "slider.horizontal.3"
  | "doc.text"
  | "clock"
  | "person.badge.plus"
  | "square.grid.3x3"
  | "cursorarrow.motionlines"
  | "doc.on.clipboard"
  | "paperclip"
  | "arrow.up"
  | "arrow.down"
  | "circle.lefthalf.filled"
  | "arrow.up.circle.fill"
  | "bell.fill"
  | "qrcode.viewfinder"
  | "bolt.horizontal.circle"
  | "lock.fill"
  | "checkmark"
  | "doc.on.doc"
  | "square.and.arrow.up"
  | "stop.fill"
  | "cloud.fill"
  | "laptopcomputer"
  | "pin"
  | "pin.slash"
  | "eye"
  | "eye.slash"
  | "envelope.badge"
  | "envelope.open"
  | "crown"
  | "folder.badge.plus"
  | "pencil"
  | "keyboard"
  | "wifi.exclamationmark";

const FALLBACK_SYMBOLS: Record<AppSymbolName, string> = {
  "chevron.left": "chevron_left",
  "chevron.down": "expand_more",
  desktopcomputer: "desktop_windows",
  plus: "add",
  "mic.fill": "mic",
  ellipsis: "more_horiz",
  xmark: "close",
  "plus.circle.fill": "add_circle",
  "person.2.fill": "group",
  magnifyingglass: "search",
  "puzzlepiece.extension.fill": "extension",
  "checkmark.circle.fill": "check_circle",
  circle: "circle",
  "arrow.up.right.square": "open_in_new",
  trash: "delete",
  "chevron.right": "chevron_right",
  "slider.horizontal.3": "filter_list",
  "doc.text": "description",
  clock: "schedule",
  "person.badge.plus": "person_add",
  "square.grid.3x3": "apps",
  "cursorarrow.motionlines": "touch_app",
  "doc.on.clipboard": "content_paste",
  paperclip: "attach_file",
  "arrow.up": "arrow_upward",
  "arrow.down": "arrow_downward",
  "circle.lefthalf.filled": "contrast",
  "arrow.up.circle.fill": "arrow_circle_up",
  "bell.fill": "notifications",
  "qrcode.viewfinder": "qr_code_scanner",
  "bolt.horizontal.circle": "bolt",
  "lock.fill": "lock",
  checkmark: "check",
  "doc.on.doc": "content_copy",
  "square.and.arrow.up": "ios_share",
  "stop.fill": "stop",
  pin: "push_pin",
  "pin.slash": "push_pin",
  eye: "visibility",
  "eye.slash": "visibility_off",
  "envelope.badge": "mark_email_unread",
  "envelope.open": "drafts",
  crown: "workspace_premium",
  "folder.badge.plus": "create_new_folder",
  pencil: "edit",
  keyboard: "keyboard",
  "cloud.fill": "cloud",
  laptopcomputer: "laptop",
  "wifi.exclamationmark": "wifi_off",
};

export function AppSymbol({
  name,
  size = 22,
  color = tokens.ink,
}: {
  name: AppSymbolName;
  size?: number;
  color?: string;
}) {
  if (Platform.OS === "ios") {
    return (
      <SymbolView
        name={name}
        tintColor={color}
        weight="medium"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <Text
      style={{
        color,
        fontFamily: "MaterialSymbols_400Regular",
        fontSize: size,
        lineHeight: size,
      }}
    >
      {FALLBACK_SYMBOLS[name]}
    </Text>
  );
}

export type SheetAction = { label: string; onPress: () => void; destructive?: boolean };

type SheetInput = {
  title?: string;
  message?: string;
  cancel?: string;
  actions: SheetAction[];
};

let activeSheet: SheetInput | null = null;
const sheetListeners = new Set<() => void>();

function subscribeToSheet(listener: () => void) {
  sheetListeners.add(listener);
  return () => sheetListeners.delete(listener);
}

function currentSheet() {
  return activeSheet;
}

function updateSheet(next: SheetInput | null) {
  activeSheet = next;
  for (const listener of sheetListeners) listener();
}

/** Native action sheet on iOS; app-styled modal sheet on Android and web. */
export function showNativeSheet(input: SheetInput) {
  const cancel = input.cancel ?? "Cancelar";
  if (Platform.OS === "ios") {
    const options = [...input.actions.map((action) => action.label), cancel];
    const destructive = input.actions.findIndex((action) => action.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: input.title,
        message: input.message,
        options,
        cancelButtonIndex: options.length - 1,
        destructiveButtonIndex: destructive >= 0 ? destructive : undefined,
        userInterfaceStyle: "light",
      },
      (index) => {
        if (index == null || index === options.length - 1) return;
        input.actions[index]?.onPress();
      },
    );
    return;
  }
  updateSheet({ ...input, cancel });
}

export function NativeSheetHost() {
  const sheet = useSyncExternalStore(subscribeToSheet, currentSheet, currentSheet);

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => updateSheet(null)}
      statusBarTranslucent
      transparent
      visible={sheet !== null}
    >
      <View style={sheetStyles.backdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fechar opções"
          onPress={() => updateSheet(null)}
          style={StyleSheet.absoluteFill}
        />
        <View style={sheetStyles.sheet}>
          {sheet?.title ? <Text style={sheetStyles.title}>{sheet.title}</Text> : null}
          {sheet?.message ? <Text style={sheetStyles.message}>{sheet.message}</Text> : null}
          <View style={sheetStyles.actions}>
            {sheet?.actions.map((action) => (
              <Pressable
                accessibilityRole="button"
                key={action.label}
                onPress={() => {
                  updateSheet(null);
                  action.onPress();
                }}
                style={({ pressed }) => [sheetStyles.action, pressed && sheetStyles.pressed]}
              >
                <Text
                  style={[sheetStyles.actionText, action.destructive && sheetStyles.destructive]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => updateSheet(null)}
              style={({ pressed }) => [
                sheetStyles.action,
                sheetStyles.cancel,
                pressed && sheetStyles.pressed,
              ]}
            >
              <Text style={sheetStyles.cancelText}>{sheet?.cancel ?? "Cancelar"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export const isIOS = Platform.OS === "ios";

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    padding: 14,
    backgroundColor: tokens.scrim,
  },
  sheet: {
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
    marginBottom: 10,
  },
  title: {
    color: tokens.ink,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "700",
    textAlign: "center",
    paddingHorizontal: 24,
  },
  message: {
    color: tokens.muted,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    paddingHorizontal: 24,
    marginTop: 7,
  },
  actions: {
    overflow: "hidden",
    borderRadius: radii.xl,
    marginTop: 14,
    backgroundColor: tokens.page,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.hairline,
  },
  action: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.hairline,
  },
  actionText: { color: tokens.ink, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  destructive: { color: tokens.danger },
  cancel: { borderBottomWidth: 0 },
  cancelText: { color: tokens.accent, fontSize: 17, lineHeight: 22, fontWeight: "700" },
  pressed: { opacity: 0.62 },
});
