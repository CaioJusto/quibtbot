import { Asset } from "expo-asset";
import type { ImageSourcePropType } from "react-native";
import { mascotSources } from "./agent-mark";
import { brandSources } from "./brand";

/**
 * Baixa de uma vez os mascotes e as artes de marca. No Expo Go (e no primeiro
 * uso de qualquer build) cada `require` de imagem é buscado por rede na hora de
 * desenhar — no túnel isso vira segundos de bolha vazia. Buscar tudo logo que o
 * app abre deixa cada tela achando a imagem no cache do aparelho.
 */
export function preloadArtwork(): Promise<void> {
  const sources: ImageSourcePropType[] = [...brandSources(), ...mascotSources()];
  const modules = sources.filter((source): source is number => typeof source === "number");
  return Asset.loadAsync(modules)
    .then(() => undefined)
    .catch(() => undefined);
}
