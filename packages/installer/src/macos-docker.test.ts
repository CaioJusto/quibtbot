import { describe, expect, it } from "vitest";
import { resolveDockerInvocation } from "./docker-invocation.js";
import { ensureDocker } from "./docker-requirements.js";
import { dockerDesktopMacDownloadUrl, privilegedDockerInstallAppleScript } from "./macos-docker.js";
import type { ProcessRunner } from "./orchestrator.js";

const ok = { code: 0, stdout: "", stderr: "" };
const missing = { code: 1, stdout: "", stderr: "missing" };

describe("Docker discovery from a macOS desktop app", () => {
  it("finds Homebrew Docker even when Finder did not provide the shell PATH", async () => {
    const commands: string[] = [];
    const invocation = await resolveDockerInvocation(
      {
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          if (command === "/opt/homebrew/bin/docker") return ok;
          return missing;
        },
      },
      { platform: "darwin", homeDir: "/Users/tester" },
    );

    expect(invocation).toEqual({ command: "/opt/homebrew/bin/docker", prefixArgs: [] });
    expect(commands).toContain("/opt/homebrew/bin/docker info");
  });
});

describe("automatic Docker Desktop installation on macOS", () => {
  it("uses Docker's architecture-specific official downloads", () => {
    expect(dockerDesktopMacDownloadUrl("arm64")).toBe(
      "https://desktop.docker.com/mac/main/arm64/Docker.dmg",
    );
    expect(dockerDesktopMacDownloadUrl("x64")).toBe(
      "https://desktop.docker.com/mac/main/amd64/Docker.dmg",
    );
    expect(dockerDesktopMacDownloadUrl("riscv64")).toBeNull();
  });

  it("quotes the privileged installer command and explicitly accepts the Docker license", () => {
    const script = privilegedDockerInstallAppleScript(
      "/private/tmp/Quibt Test/Docker.app/Contents/MacOS/install",
      "test-user",
    );
    expect(script).toContain("--accept-license");
    expect(script).toContain("--user='test-user'");
    expect(script).toContain("with administrator privileges");
  });

  it("downloads, authenticates, installs, opens and waits for Docker", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const progress: string[] = [];
    let installed = false;
    let opened = false;
    const runner: ProcessRunner = {
      async run(command, args) {
        commands.push({ command, args });
        if (command === "/usr/bin/test") return missing;
        if (command === "/usr/bin/curl") return ok;
        if (command === "/usr/bin/hdiutil") return ok;
        if (command === "/usr/bin/codesign" && args[0] === "--verify") return ok;
        if (command === "/usr/bin/codesign" && args[0] === "-dv") {
          return {
            code: 0,
            stdout: "",
            stderr: "Identifier=com.docker.docker\nTeamIdentifier=9BNSXJN65R",
          };
        }
        if (command === "/usr/sbin/spctl") return ok;
        if (command === "/usr/bin/osascript") {
          installed = true;
          return ok;
        }
        if (command === "/usr/bin/open") {
          opened = true;
          return ok;
        }
        if (command === "/Applications/Docker.app/Contents/Resources/bin/docker") {
          if (args[0] === "info" && installed && opened) return ok;
          if (args[0] === "compose" && installed && opened) return ok;
        }
        return missing;
      },
    };

    const result = await ensureDocker({
      run: runner,
      platform: "darwin",
      arch: "arm64",
      username: "test-user",
      allowDesktopInstall: true,
      clock: { sleep: async () => undefined },
      onProgress: (message) => progress.push(message),
    });

    expect(result).toEqual({
      ok: true,
      invocation: {
        command: "/Applications/Docker.app/Contents/Resources/bin/docker",
        prefixArgs: [],
      },
    });
    expect(progress).toEqual([
      "Baixando o Docker Desktop oficial…",
      "Verificando a assinatura do Docker Desktop…",
      "Confirme a senha do Mac para concluir o Docker…",
      "Abrindo o Docker Desktop…",
      "Aguardando o Docker ficar pronto…",
    ]);
    expect(
      commands.some(
        ({ command, args }) =>
          command === "/usr/bin/curl" &&
          args.includes("https://desktop.docker.com/mac/main/arm64/Docker.dmg"),
      ),
    ).toBe(true);
    expect(commands.some(({ command }) => command === "/usr/bin/osascript")).toBe(true);
    expect(
      commands.some(({ command, args }) => command === "/usr/bin/hdiutil" && args[0] === "detach"),
    ).toBe(true);
  });

  it("refuses an unexpected signer before requesting administrator privileges", async () => {
    const commands: string[] = [];
    const result = await ensureDocker({
      platform: "darwin",
      arch: "arm64",
      username: "test-user",
      allowDesktopInstall: true,
      run: {
        async run(command, args) {
          commands.push(command);
          if (command === "/usr/bin/curl" || command === "/usr/bin/hdiutil") return ok;
          if (command === "/usr/bin/codesign" && args[0] === "--verify") return ok;
          if (command === "/usr/bin/codesign" && args[0] === "-dv") {
            return {
              code: 0,
              stdout: "",
              stderr: "Identifier=example.fake\nTeamIdentifier=NOTDOCKER",
            };
          }
          return missing;
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/não pertence à Docker/i);
    expect(commands).not.toContain("/usr/bin/osascript");
  });

  it("em --non-interactive não baixa nem pede senha: falha dizendo o que instalar", async () => {
    const commands: string[] = [];
    const result = await ensureDocker({
      platform: "darwin",
      arch: "arm64",
      username: "test-user",
      allowDesktopInstall: true,
      nonInteractive: true,
      run: {
        async run(command) {
          commands.push(command);
          return missing;
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("--non-interactive");
      expect(result.message).toContain("Instale o Docker Desktop");
    }
    expect(commands).not.toContain("/usr/bin/curl");
    expect(commands).not.toContain("/usr/bin/osascript");
  });

  it("em --non-interactive um Docker Desktop já instalado ainda é aberto e esperado", async () => {
    const commands: string[] = [];
    let opened = false;
    const result = await ensureDocker({
      platform: "darwin",
      allowDesktopInstall: true,
      nonInteractive: true,
      clock: { sleep: async () => undefined },
      run: {
        async run(command, args) {
          commands.push(command);
          if (command === "/usr/bin/test") return ok;
          if (command === "/usr/bin/open") {
            opened = true;
            return ok;
          }
          if (command === "/Applications/Docker.app/Contents/Resources/bin/docker" && opened) {
            if (args[0] === "info" || args[0] === "compose") return ok;
          }
          return missing;
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(commands).toContain("/usr/bin/open");
    expect(commands).not.toContain("/usr/bin/osascript");
  });
});
