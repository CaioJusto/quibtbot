import type { MascotColorKey, MascotFamily } from "@quibt/ui-tokens";
import { mascotFamilyFor, nearestMascotColorKey } from "@quibt/ui-tokens";
import blobCitrus from "./assets/mascot-blob-citrus.png";
import blobCloudee from "./assets/mascot-blob-cloudee.png";
import blobCubee from "./assets/mascot-blob-cubee.png";
import blobFreddy from "./assets/mascot-blob-freddy.png";
import blobGrok from "./assets/mascot-blob-grok.png";
import blobKirby from "./assets/mascot-blob-kirby.png";
import blobNavy from "./assets/mascot-blob-navy.png";
import blobNova from "./assets/mascot-blob-nova.png";
import blobOnee from "./assets/mascot-blob-onee.png";
import blobStrobi from "./assets/mascot-blob-strobi.png";
import blobSunee from "./assets/mascot-blob-sunee.png";
import blobWhite from "./assets/mascot-blob-white.png";
import cubeCitrus from "./assets/mascot-cube-citrus.png";
import cubeCloudee from "./assets/mascot-cube-cloudee.png";
import cubeCubee from "./assets/mascot-cube-cubee.png";
import cubeFreddy from "./assets/mascot-cube-freddy.png";
import cubeGrok from "./assets/mascot-cube-grok.png";
import cubeKirby from "./assets/mascot-cube-kirby.png";
import cubeNavy from "./assets/mascot-cube-navy.png";
import cubeNova from "./assets/mascot-cube-nova.png";
import cubeOnee from "./assets/mascot-cube-onee.png";
import cubeStrobi from "./assets/mascot-cube-strobi.png";
import cubeSunee from "./assets/mascot-cube-sunee.png";
import cubeWhite from "./assets/mascot-cube-white.png";
import dropCitrus from "./assets/mascot-drop-citrus.png";
import dropCloudee from "./assets/mascot-drop-cloudee.png";
import dropCubee from "./assets/mascot-drop-cubee.png";
import dropFreddy from "./assets/mascot-drop-freddy.png";
import dropGrok from "./assets/mascot-drop-grok.png";
import dropKirby from "./assets/mascot-drop-kirby.png";
import dropNavy from "./assets/mascot-drop-navy.png";
import dropNova from "./assets/mascot-drop-nova.png";
import dropOnee from "./assets/mascot-drop-onee.png";
import dropStrobi from "./assets/mascot-drop-strobi.png";
import dropSunee from "./assets/mascot-drop-sunee.png";
import dropWhite from "./assets/mascot-drop-white.png";
import orbCitrus from "./assets/mascot-orb-citrus.png";
import orbCloudee from "./assets/mascot-orb-cloudee.png";
import orbCubee from "./assets/mascot-orb-cubee.png";
import orbFreddy from "./assets/mascot-orb-freddy.png";
import orbGrok from "./assets/mascot-orb-grok.png";
import orbKirby from "./assets/mascot-orb-kirby.png";
import orbNavy from "./assets/mascot-orb-navy.png";
import orbNova from "./assets/mascot-orb-nova.png";
import orbOnee from "./assets/mascot-orb-onee.png";
import orbStrobi from "./assets/mascot-orb-strobi.png";
import orbSunee from "./assets/mascot-orb-sunee.png";
import orbWhite from "./assets/mascot-orb-white.png";

const MASCOT_ASSETS = {
  blob: {
    white: blobWhite,
    navy: blobNavy,
    strobi: blobStrobi,
    freddy: blobFreddy,
    citrus: blobCitrus,
    nova: blobNova,
    grok: blobGrok,
    sunee: blobSunee,
    kirby: blobKirby,
    cloudee: blobCloudee,
    cubee: blobCubee,
    onee: blobOnee,
  },
  cube: {
    white: cubeWhite,
    navy: cubeNavy,
    strobi: cubeStrobi,
    freddy: cubeFreddy,
    citrus: cubeCitrus,
    nova: cubeNova,
    grok: cubeGrok,
    sunee: cubeSunee,
    kirby: cubeKirby,
    cloudee: cubeCloudee,
    cubee: cubeCubee,
    onee: cubeOnee,
  },
  drop: {
    white: dropWhite,
    navy: dropNavy,
    strobi: dropStrobi,
    freddy: dropFreddy,
    citrus: dropCitrus,
    nova: dropNova,
    grok: dropGrok,
    sunee: dropSunee,
    kirby: dropKirby,
    cloudee: dropCloudee,
    cubee: dropCubee,
    onee: dropOnee,
  },
  orb: {
    white: orbWhite,
    navy: orbNavy,
    strobi: orbStrobi,
    freddy: orbFreddy,
    citrus: orbCitrus,
    nova: orbNova,
    grok: orbGrok,
    sunee: orbSunee,
    kirby: orbKirby,
    cloudee: orbCloudee,
    cubee: orbCubee,
    onee: orbOnee,
  },
} satisfies Record<MascotFamily, Record<MascotColorKey, string>>;

type RasterAssetImport = string | { src: string };

/**
 * Vite exposes imported images as URL strings, while Astro can expose the same
 * imports as ImageMetadata objects. Normalise both shapes before assigning the
 * value to an <img src>, otherwise Astro serialises the object as
 * "[object Object]" in production.
 */
export function rasterAssetSrc(asset: RasterAssetImport): string {
  return typeof asset === "string" ? asset : asset.src;
}

export function rasterMascotSrc(shape: string | null | undefined, color: string): string {
  return rasterAssetSrc(MASCOT_ASSETS[mascotFamilyFor(shape)][nearestMascotColorKey(color)]);
}
