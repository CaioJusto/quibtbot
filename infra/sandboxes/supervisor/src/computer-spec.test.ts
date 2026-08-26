import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_IMAGE,
  containerCreateOptions,
  containerNameFor,
  containerNameForWorkspace,
  screenUrlFor,
  sessionPorts,
  WORKSPACE_RESTART_POLICY,
  xdotoolCommand,
} from "./computer-spec.js";

describe("graphical computer spec", () => {
  it("creates a VNC desktop, not an alpine sleep fallback", () => {
    const options = containerCreateOptions({
      name: "quibt-ws-ws",
      image: COMPUTER_IMAGE,
      workspaceId: "ws",
      homePath: "/var/quibt/workspaces/ws/home",
      desktopPath: "/var/quibt/workspaces/ws/desktops",
      networkMode: "quibt_default",
    });
    expect(options.Image).toBe("quibt/computer:local");
    expect(options.Image).not.toMatch(/alpine/);
    expect(options).not.toHaveProperty("Entrypoint");
    expect(JSON.stringify(options)).not.toMatch(/sleep/);
    expect(options.HostConfig.Binds).toEqual([
      "/var/quibt/workspaces/ws/home:/home/quibt",
      "/var/quibt/workspaces/ws/home:/workspace",
      "/var/quibt/workspaces/ws/desktops:/quibt-desktops",
    ]);
    expect(options.Env).toContain(
      "PATH=/home/quibt/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(options.Env).toContain("NPM_CONFIG_PREFIX=/home/quibt/.local");
    expect(options.Env).not.toContain("DISPLAY=:1");
    expect(options.Labels["quibt.kind"]).toBe("workspace");
    expect(options.Labels["quibt.workspaceId"]).toBe("ws");
    expect(options.Labels).not.toHaveProperty("quibt.botId");
    expect(options.ExposedPorts["6080/tcp"]).toEqual({});
    expect(options.ExposedPorts["6081/tcp"]).toEqual({});
    expect(options.HostConfig.PortBindings["6080/tcp"]?.[0]?.HostIp).toBe("127.0.0.1");
    expect(options.HostConfig.ShmSize).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(options.HostConfig.Memory).toBe(2 * 1024 * 1024 * 1024);
    expect(options.HostConfig.MemorySwap).toBe(options.HostConfig.Memory);
    expect(options.HostConfig.NanoCpus).toBe(2_000_000_000);
    expect(options.HostConfig.PidsLimit).toBe(512);
    // Um core dump do Chromium enche a casa do workspace e derruba o computador.
    expect(options.HostConfig.Ulimits).toContainEqual({ Name: "core", Soft: 0, Hard: 0 });
    // nproc é por UID no host; junto com PidsLimit fazia o exec falhar com EAGAIN.
    expect(options.HostConfig.Ulimits.some((limit) => limit.Name === "nproc")).toBe(false);
    expect(options.HostConfig.CapDrop).toContain("ALL");
    expect(options.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
    expect(options.HostConfig.ReadonlyRootfs).toBe(true);
    expect(options.HostConfig.ReadonlyPaths).toContain("/usr/share/novnc");
    expect(options.HostConfig.NetworkMode).toBe("quibt_default");
  });

  it("volta sozinho depois de reiniciar a máquina ou o Docker", () => {
    // Sem política de reinício o container ficava `Exited` após um reboot: todo comando
    // falhava, a tela dizia "ligado" e só `docker start` na mão resolvia.
    const options = containerCreateOptions({
      name: "quibt-ws-ws",
      image: COMPUTER_IMAGE,
      workspaceId: "ws",
      homePath: "/var/quibt/workspaces/ws/home",
      desktopPath: "/var/quibt/workspaces/ws/desktops",
    });
    expect(options.HostConfig.RestartPolicy).toEqual({ Name: WORKSPACE_RESTART_POLICY });
    expect(WORKSPACE_RESTART_POLICY).toBe("unless-stopped");
    // `--rm` e política de reinício não convivem no Docker.
    expect(options.HostConfig.AutoRemove).toBe(false);
  });

  it("ships a browser desktop, not a fullscreen terminal", () => {
    const root = path.resolve(import.meta.dirname, "../../computer");
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    const start = readFileSync(path.join(root, "start.sh"), "utf8");
    const session = readFileSync(path.join(root, "quibt-session"), "utf8");
    const browser = readFileSync(path.join(root, "quibt-browser"), "utf8");
    const boxChrome = readFileSync(path.join(root, "box-chrome"), "utf8");
    expect(dockerfile).toMatch(/chromium/);
    expect(start).toMatch(/quibt-session/);
    expect(start).not.toMatch(/windowsize 1280 800/);
    expect(dockerfile).toMatch(/xfwm4/);
    expect(dockerfile).toMatch(/picom/);
    expect(session).toMatch(/XDG_RUNTIME_DIR/);
    expect(session).toMatch(/box-chrome seed-chrome-session/);
    expect(session).toMatch(/box-chrome save-chrome-session/);
    expect(session).toMatch(/ensure_novnc/);
    expect(session).toMatch(/watch_novnc/);
    expect(session).toMatch(/already-running/);
    expect(session).toMatch(/quibt-session start\|stop\|status\|repair/);
    expect(browser).not.toMatch(/remote-debugging-port/);
    expect(session).toMatch(/-auth "\$XAUTHORITY"/);
    expect(session).toMatch(/-rfbauth "\$vnc_auth"/);
    expect(session).not.toMatch(/-nopw/);
    expect(boxChrome).toMatch(/Default\/Cookies/);
    expect(boxChrome).toMatch(/seed-chrome-session/);
    expect(boxChrome).not.toMatch(/"Local State"/);
    expect(boxChrome).not.toMatch(/SingletonLock/);
    expect(boxChrome).not.toMatch(/ln -s/);
  });

  it("keeps container names stable so a workspace can resume", () => {
    expect(containerNameForWorkspace("ws_1")).toBe("quibt-ws-ws_1");
    expect(containerNameFor("ws_1")).toBe(containerNameForWorkspace("ws_1"));
    expect(containerNameFor("ws_1")).toBe(containerNameFor("ws_1"));
  });

  it("gives each bot session its own ports", () => {
    expect(sessionPorts(1)).toEqual({ display: 1, vnc: 5900, novnc: 6080 });
    expect(sessionPorts(2)).toEqual({ display: 2, vnc: 5901, novnc: 6081 });
  });

  it("points the screen at the chrome-less noVNC embed", () => {
    expect(screenUrlFor("16080")).toBe("http://127.0.0.1:16080/embed.html");
    expect(screenUrlFor("16080", "127.0.0.1", "secret_1")).toBe(
      "http://127.0.0.1:16080/embed.html?password=secret_1",
    );
  });

  it("turns takeover input into xdotool", () => {
    expect(xdotoolCommand({ kind: "key", key: "Enter" })).toEqual([
      "xdotool",
      "key",
      "--clearmodifiers",
      "Return",
    ]);
    expect(xdotoolCommand({ kind: "pointer", x: 10, y: 20, type: "click" })).toEqual([
      "xdotool",
      "mousemove",
      "--",
      "10",
      "20",
      "click",
      "1",
    ]);
  });
});

describe("xdotoolCommand — trackpad", () => {
  it("moveRelative desloca pelo delta (mousemove_relative), não teleporta", () => {
    expect(xdotoolCommand({ kind: "pointer", type: "moveRelative", x: 12, y: -7 })).toEqual([
      "xdotool",
      "mousemove_relative",
      "--",
      "12",
      "-7",
    ]);
  });

  it("tap clica onde o cursor está, sem mover", () => {
    expect(xdotoolCommand({ kind: "pointer", type: "tap", x: 0, y: 0, button: "left" })).toEqual([
      "xdotool",
      "click",
      "1",
    ]);
    // move continua absoluto, para o toque direto na tela.
    expect(xdotoolCommand({ kind: "pointer", type: "move", x: 300, y: 200 })).toEqual([
      "xdotool",
      "mousemove",
      "--",
      "300",
      "200",
    ]);
  });
});
