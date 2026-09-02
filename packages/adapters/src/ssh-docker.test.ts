import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSshDockerPort,
  portsPublishPublicHttp,
  portsPublishPublicSupervisor,
  probeSshDockerComputer,
  rewriteScreenUrlToLoopback,
  SSH_PUBLISHED_WEB_PORTS_MESSAGE,
  sshAliasMissingMessage,
  sshDockerUnreachableMessage,
  type ProcessRunner,
  type SshLocalForward,
} from "./ssh-docker.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function runner(
  script: (command: string, args: readonly string[]) => { status: number; stdout: string },
): ProcessRunner {
  return async (command, args) => {
    const result = script(command, args);
    return { status: result.status, stdout: result.stdout, stderr: "" };
  };
}

describe("portsPublishPublicHttp", () => {
  it("recusa 80 e 443 publicados no docker ps ou no inspect", () => {
    expect(portsPublishPublicHttp("0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp")).toBe(true);
    expect(portsPublishPublicHttp("[::]:443->443/tcp")).toBe(true);
    expect(portsPublishPublicHttp(`{"HostPort":"80"}`)).toBe(true);
    expect(portsPublishPublicHttp("0.0.0.0:6080->6080/tcp")).toBe(false);
    expect(portsPublishPublicHttp("127.0.0.1:18080->8080/tcp")).toBe(false);
  });

  it("recusa 7091 na internet pública e aceita só na bridge", () => {
    expect(portsPublishPublicSupervisor("0.0.0.0:7091->7091/tcp")).toBe(true);
    expect(portsPublishPublicSupervisor("172.18.0.2:7091")).toBe(false);
  });
});

describe("rewriteScreenUrlToLoopback", () => {
  it("leva path e fragmento do noVNC para 127.0.0.1", () => {
    expect(
      rewriteScreenUrlToLoopback(
        "http://172.18.0.4:6080/embed.html#password=secret",
        "http://127.0.0.1:19999",
      ),
    ).toBe("http://127.0.0.1:19999/embed.html#password=secret");
  });
});

describe("createSshDockerPort", () => {
  it("ssh -G diferente de zero falha em português, sem vazar stderr", async () => {
    const ssh = createSshDockerPort({
      run: async () => ({
        status: 255,
        stdout: "",
        stderr: "identityfile /home/op/.ssh/id_ed25519\n",
      }),
    });
    const resolved = await ssh.resolveAlias("sumido");
    expect(resolved).toEqual({ ok: false, message: sshAliasMissingMessage("sumido") });
    expect(JSON.stringify(resolved)).not.toMatch(/identityfile|id_ed25519/i);
  });

  it("recusa 80/443 publicados no docker da VPS", async () => {
    const ssh = createSshDockerPort({
      run: runner((command, args) => {
        if (command === "ssh") return { status: 0, stdout: "hostname vps\n" };
        if (command === "docker" && args.includes("ps")) {
          return { status: 0, stdout: "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n" };
        }
        return { status: 0, stdout: "" };
      }),
    });
    await expect(ssh.refusePublishedWebPorts("meu-vps")).rejects.toThrow(SSH_PUBLISHED_WEB_PORTS_MESSAGE);
  });

  it("docker -H ssh:// que não responde falha em português", async () => {
    const ssh = createSshDockerPort({
      run: runner((command) => {
        if (command === "ssh") return { status: 0, stdout: "hostname vps\n" };
        return { status: 1, stdout: "" };
      }),
    });
    await expect(ssh.refusePublishedWebPorts("meu-vps")).rejects.toThrow(
      sshDockerUnreachableMessage("meu-vps"),
    );
  });

  it("abre o túnel do supervisor no IP da bridge, sem publicar 7091", async () => {
    const forwards: Array<{ remoteHost: string; remotePort: number }> = [];
    const ssh = createSshDockerPort({
      run: runner((command, args) => {
        if (command === "ssh") return { status: 0, stdout: "hostname vps\n" };
        if (command === "docker" && args.includes("{{.Ports}}")) {
          return { status: 0, stdout: "6080/tcp\n" };
        }
        if (command === "docker" && args.includes("{{.ID}}\t{{.Names}}\t{{.Image}}")) {
          return { status: 0, stdout: "abc123\tcompose-supervisor-1\tquibt/supervisor:local\n" };
        }
        if (command === "docker" && args.includes("inspect")) {
          return { status: 0, stdout: "172.18.0.2\n" };
        }
        return { status: 0, stdout: "" };
      }),
      openForward: async ({ remoteHost, remotePort }) => {
        forwards.push({ remoteHost, remotePort });
        return {
          localPort: 18080,
          origin: "http://127.0.0.1:18080",
          close: async () => undefined,
        };
      },
    });
    await expect(ssh.supervisorOrigin("meu-vps")).resolves.toBe("http://127.0.0.1:18080");
    expect(forwards).toEqual([{ remoteHost: "172.18.0.2", remotePort: 7091 }]);
  });

  it("o túnel do noVNC aponta o host/porta da screenUrl remota", async () => {
    let seen: { remoteHost: string; remotePort: number } | undefined;
    const ssh = createSshDockerPort({
      openForward: async ({ remoteHost, remotePort }) => {
        seen = { remoteHost, remotePort };
        return { localPort: 19999, origin: "http://127.0.0.1:19999", close: async () => undefined };
      },
    });
    const tunnel = await ssh.openNovncTunnel("meu-vps", "http://172.18.0.4:6080/embed.html");
    expect(seen).toEqual({ remoteHost: "172.18.0.4", remotePort: 6080 });
    expect(tunnel.origin).toBe("http://127.0.0.1:19999");
  });
});

describe("probeSshDockerComputer", () => {
  it("alias ausente falha o Testar em português", async () => {
    const result = await probeSshDockerComputer({
      alias: "ghost-host",
      ssh: createSshDockerPort({
        run: async () => ({ status: 255, stdout: "", stderr: "Permission denied" }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(sshAliasMissingMessage("ghost-host"));
    expect(result.message).not.toMatch(/Permission denied|identityfile/i);
  });

  it("portas 80/443 publicadas reprovam o Testar", async () => {
    const result = await probeSshDockerComputer({
      alias: "meu-vps",
      ssh: {
        resolveAlias: async () => ({ ok: true }),
        refusePublishedWebPorts: async () => {
          throw new Error(SSH_PUBLISHED_WEB_PORTS_MESSAGE);
        },
        supervisorOrigin: async () => {
          throw new Error("não deveria");
        },
        openNovncTunnel: async () => {
          throw new Error("não deveria");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(SSH_PUBLISHED_WEB_PORTS_MESSAGE);
  });

  it("alias e Docker ok, sem pedir token", async () => {
    const result = await probeSshDockerComputer({
      alias: "meu-vps",
      ssh: {
        resolveAlias: async () => ({ ok: true }),
        refusePublishedWebPorts: async () => undefined,
        supervisorOrigin: async () => "http://127.0.0.1:1",
        openNovncTunnel: async () => {
          throw new Error("não deveria");
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      message: "Docker ok em ssh://meu-vps. A tela chega por túnel até 127.0.0.1.",
    });
  });
});

describe("túnel fake serve PNG no loopback", () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const server of servers) server.close();
    servers.length = 0;
  });

  it("abre o túnel e o preview PNG sai de 127.0.0.1", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG_MAGIC);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    let opened = false;
    const tunnel: SshLocalForward = {
      localPort: port,
      origin: `http://127.0.0.1:${port}`,
      close: async () => undefined,
    };
    const ssh = createSshDockerPort({
      openForward: async () => {
        opened = true;
        return tunnel;
      },
    });
    const openedTunnel = await ssh.openNovncTunnel("meu-vps", "http://172.18.0.4:6080/");
    expect(opened).toBe(true);
    expect(openedTunnel.origin).toBe(`http://127.0.0.1:${port}`);

    const res = await fetch(`${openedTunnel.origin}/`);
    expect(res.headers.get("content-type")).toMatch(/png/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(PNG_MAGIC)).toBe(true);
  });
});
