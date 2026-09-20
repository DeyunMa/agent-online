import { Template } from "e2b";

export const piRuntimeTemplate = Object.freeze({
  name: "agent-online-pi-runtime",
  nodeVersion: "24.16.0",
  piVersion: "0.82.0",
  pnpmVersion: "10.33.2",
  previewViteVersion: "8.1.5",
  tag: "v3",
});

export function createPiRuntimeTemplate() {
  const platformManifest = Buffer.from(
    JSON.stringify({
      agentRuntimes: {
        pi: piRuntimeTemplate.piVersion,
      },
      developerToolchains: ["node", "npm", "pnpm", "python3", "git", "build-essential"],
      node: piRuntimeTemplate.nodeVersion,
      platformCapabilities: {
        preview: {
          executable: "/opt/agent-online/preview/node_modules/.bin/vite",
          preset: "vite-v1",
          version: piRuntimeTemplate.previewViteVersion,
        },
      },
      schemaVersion: 1,
    }),
  ).toString("base64");

  return Template()
    .fromNodeImage(piRuntimeTemplate.nodeVersion)
    .runCmd(
      [
        "apt-get update",
        [
          "apt-get install --yes --no-install-recommends",
          "bash bzip2 build-essential ca-certificates coreutils curl file findutils git",
          "jq lsof pkg-config procps python3 python3-pip python3-venv ripgrep",
          "tar unzip xz-utils zip",
        ].join(" "),
        "rm -rf /var/lib/apt/lists/*",
      ].join(" && "),
      { user: "root" },
    )
    .runCmd(
      `npm install --global --ignore-scripts @earendil-works/pi-coding-agent@${piRuntimeTemplate.piVersion}`,
      { user: "root" },
    )
    .runCmd(`npm install --global pnpm@${piRuntimeTemplate.pnpmVersion}`, {
      user: "root",
    })
    .runCmd(
      [
        "mkdir -p /opt/agent-online/preview",
        `npm install --prefix /opt/agent-online/preview --no-audit --no-fund --no-save vite@${piRuntimeTemplate.previewViteVersion}`,
        "mkdir -p /opt/agent-online",
        `printf %s ${platformManifest} | base64 -d > /opt/agent-online/manifest.json`,
        "chown -R root:root /opt/agent-online",
        "chmod -R go-w /opt/agent-online",
      ].join(" && "),
      { user: "root" },
    )
    .makeDir("/workspace", { mode: 0o755, user: "root" })
    .runCmd("chown user:user /workspace", { user: "root" })
    .setUser("user")
    .setWorkdir("/workspace")
    .runCmd("test -r /opt/agent-online/manifest.json && test ! -w /opt/agent-online")
    .runCmd("node --version")
    .runCmd("npm --version")
    .runCmd("pnpm --version")
    .runCmd("/opt/agent-online/preview/node_modules/.bin/vite --version")
    .runCmd("python3 --version")
    .runCmd("python3 -m pip --version")
    .runCmd("rg --version | head -n 1")
    .runCmd("jq --version")
    .runCmd("cc --version | head -n 1")
    .runCmd("/usr/bin/git --version")
    .runCmd("/bin/bash --version | head -n 1")
    .runCmd("pi --version");
}
