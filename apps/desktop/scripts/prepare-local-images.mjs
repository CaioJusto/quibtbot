import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopPackage = JSON.parse(
  readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"),
);
const release = desktopPackage.version;

const builds = [
  {
    name: "quibt-computer",
    context: "infra/sandboxes/computer",
    sourceTag: "quibt/computer:local",
  },
  {
    name: "quibt-supervisor",
    context: ".",
    file: "infra/sandboxes/supervisor/Dockerfile",
  },
  {
    name: "quibt-stack",
    context: ".",
    file: "infra/compose/Dockerfile",
  },
];

for (const build of builds) {
  const tag = `ghcr.io/quibt/${build.name}:${release}`;
  const prepared = spawnSync("docker", ["image", "inspect", tag], {
    cwd: root,
    stdio: "ignore",
    shell: false,
  });
  if (prepared.status === 0 && process.env.QUIBT_REBUILD_LOCAL_IMAGES !== "1") {
    console.log(`Using prepared local installer image ${tag}`);
    continue;
  }
  if (build.sourceTag) {
    const inspected = spawnSync("docker", ["image", "inspect", build.sourceTag], {
      cwd: root,
      stdio: "ignore",
      shell: false,
    });
    if (inspected.status === 0) {
      console.log(`Reusing ${build.sourceTag} as ${tag}`);
      const tagged = spawnSync("docker", ["tag", build.sourceTag, tag], {
        cwd: root,
        stdio: "inherit",
        shell: false,
      });
      if (tagged.error) throw tagged.error;
      if (tagged.status !== 0) process.exit(tagged.status ?? 1);
      continue;
    }
  }
  const args = ["build", "--build-arg", `RELEASE_VERSION=${release}`, "--tag", tag];
  if (build.file) args.push("--file", build.file);
  args.push(build.context);

  console.log(`Preparing local installer image ${tag}`);
  const result = spawnSync("docker", args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
