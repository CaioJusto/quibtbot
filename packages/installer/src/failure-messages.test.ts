import { describe, expect, it } from "vitest";
import {
  explainDockerFailure,
  explainInstallLock,
  explainUpdateRequired,
} from "./failure-messages.js";

describe("explainDockerFailure", () => {
  it("Docker Desktop fechado vira 'abra a baleia'", () => {
    expect(
      explainDockerFailure(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe("O Docker não está respondendo. Abra o Docker Desktop (a baleia) e tente de novo.");
  });

  it("porta ocupada diz qual porta e o que fechar", () => {
    expect(
      explainDockerFailure(
        "Error response from daemon: driver failed programming external connectivity on endpoint quibt-desktop-web-1: Bind for 127.0.0.1:5173 failed: port is already allocated",
      ),
    ).toContain("A porta 5173 já está em uso");
    expect(explainDockerFailure("listen tcp 0.0.0.0:3100: bind: address already in use")).toContain(
      "A porta 3100 já está em uso",
    );
  });

  it("disco cheio, internet e registro têm frases próprias", () => {
    expect(explainDockerFailure("write /var/lib/docker/tmp: no space left on device")).toContain(
      "O disco encheu",
    );
    expect(
      explainDockerFailure("Get https://ghcr.io/v2/: net/http: TLS handshake timeout"),
    ).toContain("A internet falhou no meio do download");
    expect(explainDockerFailure("dial tcp: lookup ghcr.io: no such host")).toContain(
      "A internet falhou",
    );
    expect(explainDockerFailure("Error response from daemon: unauthorized")).toContain("ghcr.io");
  });

  it("no `up`, 'denied' é a pasta de dados — não o registro de imagens", () => {
    const denied = explainDockerFailure(
      "Error response from daemon: Mounts denied: The path /Users/ana/Library/Application Support/Quibt is not shared from the host and is not known to Docker.",
      { phase: "up" },
    );
    expect(denied).toContain(
      "O Docker não conseguiu acessar a pasta de dados /Users/ana/Library/Application Support/Quibt",
    );
    expect(denied).toContain("Settings → Resources → File sharing");
    expect(denied).not.toContain("ghcr.io");

    // No Linux o volume só diz "permission denied"; a pasta vem de quem chamou.
    expect(
      explainDockerFailure("error while creating mount source path: permission denied", {
        phase: "up",
        dataDir: "/home/ana/.local/share/quibt",
      }),
    ).toContain("a pasta de dados /home/ana/.local/share/quibt");

    // O socket é outro problema, e a rede não é culpa do `up`.
    expect(
      explainDockerFailure(
        "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
        { phase: "up" },
      ),
    ).toBeNull();
    expect(
      explainDockerFailure("dial tcp 10.0.0.1:5432: connect: connection refused", { phase: "up" }),
    ).toBeNull();
  });

  it("no download, só o que o registro diz mesmo vira 'ghcr.io recusou'", () => {
    expect(
      explainDockerFailure("Error response from daemon: pull access denied for ghcr.io/quibt/x", {
        phase: "pull",
      }),
    ).toContain("ghcr.io");
    expect(explainDockerFailure("manifest unknown", { phase: "pull" })).toContain("ghcr.io");
    // "denied" solto (um bind mount) não é o registro recusando nada.
    expect(explainDockerFailure("Mounts denied: something", { phase: "pull" })).toBeNull();
  });

  it("o que não reconhece fica para os detalhes técnicos", () => {
    expect(explainDockerFailure("")).toBeNull();
    expect(explainDockerFailure("something odd happened")).toBeNull();
  });
});

describe("mensagens do lock e da versão", () => {
  it("outra instalação em andamento, com o processo quando houver", () => {
    expect(explainInstallLock("Another install or update is already running (pid 4242).")).toBe(
      "Outra instalação ou atualização do Quibt já está em andamento (processo 4242). Espere ela terminar ou feche o outro instalador e tente de novo.",
    );
    expect(explainInstallLock("lock directory is busy")).toContain(
      "Outra instalação ou atualização",
    );
  });

  it("versão diferente manda atualizar em vez de instalar", () => {
    const message = explainUpdateRequired("0.2.10", "0.2.11");
    expect(message).toContain("0.2.10");
    expect(message).toContain("0.2.11");
    expect(message).toContain("quibtbot update");
  });
});
