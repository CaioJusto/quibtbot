import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * O caminho "supervisor noutra máquina" é uma promessa de documentação antes de ser código:
 * a porta 7091 manda no Docker do host, então ela só pode aparecer atrás de TLS e de um
 * profile que o operador liga na mão. Estes testes prendem o compose e a documentação ao
 * que o produto realmente faz.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");
const sourceCompose = read("infra/compose/docker-compose.yml");
const installCompose = read("infra/compose/docker-compose.desktop.yml");
const tlsOverlay = read("infra/compose/docker-compose.supervisor-tls.yml");
const supervisorSource = read("infra/sandboxes/supervisor/src/index.ts");
const computersDoc = read("docs/computers.md");
const selfHostDoc = read("docs/self-host.md");

/** O bloco de um serviço do compose, até o próximo serviço no mesmo recuo. */
function serviceBlock(compose: string, service: string): string {
  const start = compose.indexOf(`\n  ${service}:\n`);
  expect(start, `serviço ${service} não existe neste compose`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

describe("compose: a 7091 não sobe sozinha", () => {
  it("o supervisor não publica porta nenhuma no compose de fonte", () => {
    expect(serviceBlock(sourceCompose, "supervisor")).not.toMatch(/^\s+ports:/m);
  });

  it("o supervisor não publica porta nenhuma no compose de instalação", () => {
    expect(serviceBlock(installCompose, "supervisor")).not.toMatch(/^\s+ports:/m);
  });

  it("o TLS do supervisor é opt-in: arquivo à parte, e ainda dentro de um profile", () => {
    const tls = serviceBlock(tlsOverlay, "supervisor-tls");
    expect(tls).toContain('profiles: ["supervisor-tls"]');
    expect(tls).toContain("supervisor:7091");
    expect(tls).toContain('"443:443"');
    // Nada de publicar a porta crua junto: quem fala com o supervisor fala com o Caddy.
    expect(tls).not.toMatch(/"[\d.]*:?7091:7091"/);
  });

  it("o compose principal não cita a variável do TLS nem o serviço", () => {
    // `profiles:` não protege contra interpolação: uma variável obrigatória aqui quebraria
    // o `up` de quem nunca pediu TLS.
    for (const compose of [sourceCompose, installCompose]) {
      expect(compose).not.toContain("QUIBT_SUPERVISOR_PUBLIC_HOST");
      expect(compose).not.toMatch(/^ {2}supervisor-tls:/m);
    }
  });

  it("nenhum serviço fora do profile mapeia a 7091 para o host", () => {
    for (const compose of [sourceCompose, installCompose]) {
      for (const mapping of compose.match(/^\s+- "[^"]*7091[^"]*"$/gm) ?? []) {
        expect(mapping, "só o profile de TLS pode encostar na 7091").toBe("");
      }
    }
  });
});

describe("supervisor: a sonda do 'Testar máquina' exige token", () => {
  it("a rota de sonda mora debaixo do guarda de /computers", () => {
    const guard = supervisorSource.indexOf('app.use("/computers/*"');
    const probe = supervisorSource.indexOf('app.get("/computers/_probe"');
    expect(guard).toBeGreaterThan(-1);
    expect(probe, "a sonda autenticada não está registrada").toBeGreaterThan(guard);
    // …e antes de `/computers/:id`, senão o roteador entrega a sonda para o outro handler.
    expect(probe).toBeLessThan(supervisorSource.indexOf('app.get("/computers/:id"'));
  });
});

describe("docs: só prometem o que o código faz", () => {
  it("computers.md não manda mais colar a 7091 crua", () => {
    expect(computersDoc).not.toContain("https://sua-vps:7091");
    expect(computersDoc).toContain("supervisor-tls");
  });

  it("self-host.md não manda mais colar a 7091 crua e documenta o host da tela", () => {
    expect(selfHostDoc).not.toContain("https://your-vps:7091");
    expect(selfHostDoc).toContain("supervisor-tls");
    expect(selfHostDoc).toContain("SANDBOX_SCREEN_HOST");
    expect(selfHostDoc).toContain("SANDBOX_SCREEN_BIND_HOST");
  });

  it("as duas documentações descrevem a tela ao vivo por túnel SSH", () => {
    expect(computersDoc).toMatch(/túnel SSH|docker -H ssh:\/\//i);
    expect(computersDoc).toMatch(/127\.0\.0\.1/);
    expect(selfHostDoc).toMatch(/SSH tunnel|ssh:\/\//i);
    expect(computersDoc).not.toMatch(/A tela não atravessa um supervisor remoto/);
    expect(selfHostDoc).not.toMatch(/The screen does not cross a remote supervisor/);
  });
});

/**
 * O Compose interpola o arquivo INTEIRO ao carregar; `profiles:` só decide o que sobe.
 * Um `${QUIBT_SUPERVISOR_PUBLIC_HOST:?}` dentro do compose principal quebrava
 * `docker compose up` de toda instalação já existente — o `quibt.env` delas não tem essa
 * variável — mesmo com o profile desligado. Por isso o serviço mora num arquivo à parte, e
 * por isso estes testes chamam o docker de verdade em vez de olhar o texto.
 */
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["compose", "version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
})();

interface RenderedCompose {
  services: Record<string, { ports?: unknown[]; command?: string[] }>;
}

/** Um `quibt.env` de instalação, com tudo que o compose principal exige — e nada além. */
function installEnvFile(extra: string[] = []): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "quibt-tls-env-"));
  const file = path.join(dir, "quibt.env");
  writeFileSync(
    file,
    [
      "DATABASE_PASSWORD=test-password",
      `DATA_DIR=${dir}`,
      "QUIBT_STACK_VERSION=0.2.6",
      `INSTALL_ENV_FILE=${file}`,
      "BETTER_AUTH_SECRET=test-secret",
      "WEB_ORIGIN=http://127.0.0.1:5173",
      "BETTER_AUTH_URL=http://127.0.0.1:5173",
      ...extra,
    ].join("\n"),
  );
  return { dir, file };
}

function composeConfig(input: { files: string[]; envFile: string; profile?: string }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const args = ["compose"];
  for (const file of input.files) args.push("-f", path.join(repoRoot, file));
  args.push("--env-file", input.envFile);
  if (input.profile) args.push("--profile", input.profile);
  args.push("config", "--format", "json");
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe.skipIf(!dockerAvailable)("docker compose config (docker de verdade)", () => {
  it("um quibt.env antigo, sem QUIBT_SUPERVISOR_PUBLIC_HOST, ainda sobe o stack", () => {
    const env = installEnvFile();
    try {
      const result = composeConfig({
        files: ["infra/compose/docker-compose.desktop.yml"],
        envFile: env.file,
      });
      expect(result.status, result.stderr).toBe(0);
      const rendered = JSON.parse(result.stdout) as RenderedCompose;
      expect(Object.keys(rendered.services)).not.toContain("supervisor-tls");
      expect(rendered.services.supervisor?.ports ?? []).toEqual([]);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("com o overlay e a variável, o Caddy do supervisor aparece", () => {
    const env = installEnvFile(["QUIBT_SUPERVISOR_PUBLIC_HOST=quibt-test.203.0.113.9.sslip.io"]);
    try {
      const result = composeConfig({
        files: [
          "infra/compose/docker-compose.desktop.yml",
          "infra/compose/docker-compose.supervisor-tls.yml",
        ],
        envFile: env.file,
        profile: "supervisor-tls",
      });
      expect(result.status, result.stderr).toBe(0);
      const rendered = JSON.parse(result.stdout) as RenderedCompose;
      const command = rendered.services["supervisor-tls"]?.command ?? [];
      expect(command).toContain("quibt-test.203.0.113.9.sslip.io");
      expect(command).toContain("supervisor:7091");
      // O supervisor continua sem porta publicada: quem encara a internet é o Caddy.
      expect(rendered.services.supervisor?.ports ?? []).toEqual([]);
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });

  it("o overlay sem a variável falha, e falha só para quem o carregou", () => {
    const env = installEnvFile();
    try {
      const result = composeConfig({
        files: [
          "infra/compose/docker-compose.desktop.yml",
          "infra/compose/docker-compose.supervisor-tls.yml",
        ],
        envFile: env.file,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("QUIBT_SUPERVISOR_PUBLIC_HOST");
    } finally {
      rmSync(env.dir, { recursive: true, force: true });
    }
  });
});
