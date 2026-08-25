import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cardDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(cardDirectory, "..");
const publicDirectory = path.join(appDirectory, "public");
const outputDirectory = path.join(publicDirectory, "social");
const outputPath = path.join(outputDirectory, "quibt-open-source-v2.png");
const requireFromApp = createRequire(path.join(appDirectory, "package.json"));
const requireFromAstro = createRequire(requireFromApp.resolve("astro/package.json"));
const sharp = requireFromAstro("sharp");

await mkdir(outputDirectory, { recursive: true });

const background = Buffer.from(`
  <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#dce7ff" stop-opacity="0.92"/>
        <stop offset="58%" stop-color="#edf3ff" stop-opacity="0.54"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="64%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#f4f7ff"/>
      </linearGradient>
      <filter id="softShadow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="24"/>
      </filter>
    </defs>

    <rect width="1200" height="630" fill="url(#wash)"/>
    <ellipse cx="930" cy="334" rx="334" ry="304" fill="url(#glow)"/>
    <ellipse cx="934" cy="531" rx="244" ry="28" fill="#1f55d9" opacity="0.11" filter="url(#softShadow)"/>
    <rect x="34" y="34" width="1132" height="562" rx="34" fill="none" stroke="#e3e8f2" stroke-width="2"/>

    <text x="70" y="208" fill="#09090b" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="62" font-weight="700" letter-spacing="-2.6">
      Your own team of
    </text>
    <text x="70" y="279" fill="#09090b" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="62" font-weight="700" letter-spacing="-2.6">
      AI bots, in a
    </text>
    <text x="70" y="350" fill="#09090b" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="62" font-weight="700" letter-spacing="-2.6">
      chat app.
    </text>

    <text x="72" y="411" fill="#64666c" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="24" font-weight="500">
      Local-first Quibt Bot. Bring your models
    </text>
    <text x="72" y="445" fill="#64666c" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="24" font-weight="500">
      and run them on your machine.
    </text>

    <rect x="70" y="486" width="136" height="36" rx="18" fill="#eaf1ff"/>
    <text x="91" y="510" fill="#2370ed" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="14" font-weight="700" letter-spacing="1.35">
      OPEN SOURCE
    </text>
    <text x="72" y="562" fill="#2370ed" font-family="Avenir Next, Helvetica Neue, Arial, sans-serif" font-size="21" font-weight="650">
      quibt.com.br
    </text>
  </svg>
`);

async function resizedAsset(relativePath, width) {
  return sharp(path.join(publicDirectory, relativePath))
    .resize({ width, withoutEnlargement: true })
    .png()
    .toBuffer();
}

const [logo, blue, yellow, cyan, pink] = await Promise.all([
  resizedAsset("quibt-logo.png", 170),
  resizedAsset("mascots/quib-blue.png", 390),
  resizedAsset("mascots/quib-yellow.png", 144),
  resizedAsset("mascots/quib-cyan.png", 126),
  resizedAsset("mascots/quib-pink.png", 215),
]);

await sharp(background)
  .composite([
    { input: logo, left: 70, top: 62 },
    { input: pink, left: 745, top: 142, blend: "over" },
    { input: cyan, left: 686, top: 432, blend: "over" },
    { input: blue, left: 770, top: 187, blend: "over" },
    { input: yellow, left: 1007, top: 67, blend: "over" },
  ])
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(outputPath);

const output = await readFile(outputPath);
await writeFile(path.join(publicDirectory, "og-image.png"), output);
const manifest = {
  schemaVersion: 1,
  asset: "public/social/quibt-open-source-v2.png",
  width: 1200,
  height: 630,
  mediaType: "image/png",
  compatibilityAssets: ["public/og-image.png"],
  bytes: output.length,
  sha256: createHash("sha256").update(output).digest("hex"),
  copy: {
    headline: "Your own team of AI bots, in a chat app.",
    description: "Local-first Quibt Bot. Bring your models and run them on your machine.",
    domain: "quibt.com.br",
  },
};

await writeFile(
  path.join(cardDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(manifest));
