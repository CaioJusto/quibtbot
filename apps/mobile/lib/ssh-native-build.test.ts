import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const patch = readFileSync(
  path.join(root, "patches/@dylankenneally__react-native-ssh-sftp@1.11.0.patch"),
  "utf8",
);
const mobilePackage = JSON.parse(
  readFileSync(path.join(root, "apps/mobile/package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const easPreinstall = readFileSync(
  path.join(root, "apps/mobile/scripts/eas-build-pre-install.sh"),
  "utf8",
);

describe("native SSH release build", () => {
  it("implements the mwiede JSch 0.2.x HostKeyRepository contract", () => {
    expect(patch).toContain("HostKeyRepository.NOT_INCLUDED");
    expect(patch).toContain("HostKeyRepository.CHANGED");
    expect(patch).not.toContain("HostKeyRepository.NOT_MATCH");
    expect(patch.match(/public HostKey\[\] getHostKey\(\)/g)).toHaveLength(2);
    expect(patch.match(/public HostKey\[\] getHostKey\(String host, String type\)/g)).toHaveLength(
      2,
    );
  });

  it("builds the modern iOS libssh2 before EAS runs prebuild and CocoaPods", () => {
    expect(mobilePackage.scripts?.["eas-build-pre-install"]).toBe(
      "./scripts/eas-build-pre-install.sh",
    );
    expect(easPreinstall).toMatch(/EAS_BUILD_PLATFORM:-.*== "ios"/);
    expect(easPreinstall).toContain('build-ios-libssh2.sh" iphoneos');
  });
});
