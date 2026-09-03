import { describe, expect, it } from "vitest";
import { sandboxOptionsFromSettings } from "./sandbox-options.js";

describe("sandboxOptionsFromSettings", () => {
  it("maps a saved Quibt Cloud session and optional API URL", () => {
    const options = sandboxOptionsFromSettings(
      {
        sandboxProvider: "quibt-cloud",
        sandboxEndpoint: "https://cloud.example.test",
        sandboxCredentialCipher: "enc:cloud_sess",
      },
      {
        load: (ciphertext) => ciphertext.replace(/^enc:/, ""),
      },
      {},
    );
    expect(options).toMatchObject({
      quibtCloudSessionToken: "cloud_sess",
      quibtCloudApiUrl: "https://cloud.example.test",
    });
  });

  it("maps a saved Daytona key while preserving process-level client settings", () => {
    const options = sandboxOptionsFromSettings(
      {
        sandboxProvider: "daytona",
        sandboxCredentialCipher: "enc:daytona_saved",
      },
      {
        load: (ciphertext) => ciphertext.replace(/^enc:/, ""),
      },
      {
        daytonaApiUrl: "https://daytona.example.test",
        daytonaTarget: "eu",
      },
    );

    expect(options).toMatchObject({
      daytonaApiKey: "daytona_saved",
      daytonaApiUrl: "https://daytona.example.test",
      daytonaTarget: "eu",
    });
  });
});
