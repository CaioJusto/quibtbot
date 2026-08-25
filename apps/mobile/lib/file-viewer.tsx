/**
 * O visualizador de arquivos do app: imagem, vídeo e texto abrem aqui dentro, em tela
 * cheia escura, em vez de caírem direto na folha de compartilhar. O arquivo é baixado
 * uma vez para o cache (a URL exige autenticação, e player e leitor não mandam header),
 * e o que o app não sabe mostrar continua indo para o compartilhar de sempre.
 */
import { fileViewerKind, TEXT_VIEWER_MAX_BYTES } from "@quibt/core";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fileUrl, openAttachmentFile } from "./attachments";
import { COLORS } from "./design-system";
import { AppSymbol } from "./native";

export type ViewerFile = {
  artifactId: string;
  name: string;
  mimeType?: string;
  size?: number;
};

type Loaded =
  | { state: "loading" }
  | { state: "ready"; uri: string; text?: string }
  | { state: "error"; message: string };

async function downloadToCache(
  file: ViewerFile,
  options: { apiBase: string; authHeaders: Record<string, string> },
): Promise<string> {
  const FileSystem = await import("expo-file-system/legacy");
  const safe = file.name.replace(/[^\w.-]+/g, "_") || file.artifactId;
  const dest = `${FileSystem.cacheDirectory}viewer-${file.artifactId}-${safe}`;
  const info = await FileSystem.getInfoAsync(dest);
  if (info.exists && (info.size ?? 0) > 0) return dest;
  const url = fileUrl(file.artifactId, options.apiBase);
  const downloaded = await FileSystem.downloadAsync(url, dest, { headers: options.authHeaders });
  if (downloaded.status !== 200) throw new Error(`download falhou (${downloaded.status})`);
  return downloaded.uri;
}

function VideoBody({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.play();
  });
  return <VideoView player={player} style={styles.media} contentFit="contain" nativeControls />;
}

export function FileViewer({
  file,
  apiBase,
  authHeaders,
  onClose,
}: {
  file: ViewerFile | null;
  apiBase: string;
  authHeaders: () => Promise<Record<string, string>>;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const kind = file ? fileViewerKind(file.mimeType, file.name) : "other";

  useEffect(() => {
    if (!file) return;
    let active = true;
    setLoaded({ state: "loading" });
    void (async () => {
      try {
        const headers = await authHeaders();
        if (kind === "other" || (kind === "text" && (file.size ?? 0) > TEXT_VIEWER_MAX_BYTES)) {
          // Nada para mostrar aqui dentro: vai direto para a folha do sistema e fecha.
          await openAttachmentFile(file.artifactId, file.name, { apiBase, authHeaders: headers });
          if (active) onClose();
          return;
        }
        const uri = await downloadToCache(file, { apiBase, authHeaders: headers });
        if (!active) return;
        if (kind === "text") {
          const FileSystem = await import("expo-file-system/legacy");
          const text = await FileSystem.readAsStringAsync(uri);
          if (active) setLoaded({ state: "ready", uri, text });
          return;
        }
        setLoaded({ state: "ready", uri });
      } catch (err) {
        if (active) {
          setLoaded({
            state: "error",
            message: err instanceof Error ? err.message : "Não foi possível abrir o arquivo",
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [file, kind, apiBase, authHeaders, onClose]);

  if (!file || kind === "other") return null;

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top, 14) + 4 }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Fechar" onPress={onClose}>
            <View style={styles.headerButton}>
              <AppSymbol name="xmark" size={17} color="#F1F1F2" />
            </View>
          </Pressable>
          <Text numberOfLines={1} style={styles.headerTitle}>
            {file.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Compartilhar arquivo"
            onPress={() => {
              void authHeaders().then((headers) =>
                openAttachmentFile(file.artifactId, file.name, { apiBase, authHeaders: headers }),
              );
            }}
          >
            <View style={styles.headerButton}>
              <AppSymbol name="square.and.arrow.up" size={17} color="#F1F1F2" />
            </View>
          </Pressable>
        </View>

        {loaded.state === "loading" ? (
          <View style={styles.center}>
            <ActivityIndicator color="#F1F1F2" />
          </View>
        ) : loaded.state === "error" ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>{loaded.message}</Text>
          </View>
        ) : kind === "image" ? (
          <Image
            source={{ uri: loaded.uri }}
            style={styles.media}
            contentFit="contain"
            accessibilityLabel={file.name}
          />
        ) : kind === "video" || kind === "audio" ? (
          <VideoBody uri={loaded.uri} />
        ) : (
          <ScrollView
            style={styles.textScroll}
            contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24 }}
          >
            <Text selectable style={styles.textBody}>
              {loaded.text ?? ""}
            </Text>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /** A tela do arquivo é sempre escura, como um visualizador de fotos — não é cromo do app. */
  screen: { flex: 1, backgroundColor: "#0B0B0C" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    color: "#F1F1F2",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: "#FF8A8E", fontSize: 15, textAlign: "center" },
  media: { flex: 1 },
  textScroll: { flex: 1, backgroundColor: COLORS.background },
  textBody: {
    color: COLORS.primary,
    fontSize: 14,
    lineHeight: 21,
    fontFamily: "Menlo",
  },
});
