import { describe, expect, it } from "vitest";
import {
  LOCAL_UNAVAILABLE_MESSAGE,
  planInitialNavigation,
  REMOTE_UNAVAILABLE_MESSAGE,
} from "./initial-page.js";

describe("planInitialNavigation", () => {
  it("opens setup when the local stack is down", async () => {
    const plan = await planInitialNavigation(
      "http://127.0.0.1:5173",
      async () => false,
      (url) => url.includes("127.0.0.1"),
    );
    expect(plan).toEqual({
      action: "setup",
      clearRemote: false,
      message: LOCAL_UNAVAILABLE_MESSAGE,
      autoStart: false,
    });
  });

  it("religa sozinho quando o stack local está instalado e só desligado", async () => {
    const plan = await planInitialNavigation(
      "http://127.0.0.1:5173",
      async () => false,
      (url) => url.includes("127.0.0.1"),
      () => true,
    );
    expect(plan).toEqual({
      action: "setup",
      clearRemote: false,
      message: LOCAL_UNAVAILABLE_MESSAGE,
      autoStart: true,
    });
  });

  it("um stack local no ar não consulta o estado da instalação", async () => {
    let asked = false;
    const plan = await planInitialNavigation(
      "http://127.0.0.1:5173",
      async () => true,
      () => true,
      () => {
        asked = true;
        return true;
      },
    );
    expect(plan).toEqual({ action: "navigate", url: "http://127.0.0.1:5173", remote: false });
    expect(asked).toBe(false);
  });

  it("clears remote and opens setup when a persisted remote url is unavailable", async () => {
    const plan = await planInitialNavigation(
      "https://remote.example.com",
      async () => false,
      () => false,
    );
    expect(plan).toEqual({
      action: "setup",
      clearRemote: true,
      message: REMOTE_UNAVAILABLE_MESSAGE,
    });
  });

  it("navigates to a reachable remote url", async () => {
    const plan = await planInitialNavigation(
      "https://remote.example.com",
      async () => true,
      () => false,
    );
    expect(plan).toEqual({
      action: "navigate",
      url: "https://remote.example.com",
      remote: true,
    });
  });
});
