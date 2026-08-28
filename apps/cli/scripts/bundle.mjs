import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * O `bin` do pacote (`dist/main.js`) precisa ser JavaScript que anda sozinho.
 * `@quibt/installer` e `@quibt/core` publicam TypeScript fonte nos seus `exports`,
 * então um `tsc` simples emitia um `import "@quibt/installer"` que o Node só
 * carregaria apagando tipos — coisa que ele recusa dentro de node_modules e que já
 * quebrava aqui (parameter property em packages/installer/src/index.ts).
 *
 * O empacotamento é o mesmo que o binário de release usa
 * (scripts/build-cli-binary.mjs), só que em ESM: assim `import.meta.url` continua
 * valendo e o auto-arranque de `main.ts` (`isMainModule`) segue funcionando.
 */

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFile = path.join(cliRoot, "dist/main.js");

// `esbuild` é devDependency da RAIZ deste monorepo (junto de `scripts/build-cli-binary.mjs`),
// e é de lá que o Node o resolve. Sem ele a mensagem tem de dizer o que instalar.
let esbuild;
try {
  esbuild = await import("esbuild");
} catch (error) {
  console.error(
    `Não deu para carregar o esbuild: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error("Ele é devDependency da raiz do monorepo: rode `pnpm install` na raiz e repita.");
  process.exit(1);
}

await esbuild.build({
  entryPoints: [path.join(cliRoot, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  // O shebang já está na primeira linha de `src/main.ts`; o esbuild o preserva.
  outfile: outFile,
  logLevel: "info",
});

// O `bin` também é chamado direto (`./dist/main.js`), não só pelo shim do gestor.
if (process.platform !== "win32") chmodSync(outFile, 0o755);
