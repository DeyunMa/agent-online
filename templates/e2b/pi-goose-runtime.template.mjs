import { Template } from "e2b";

export const piGooseRuntimeTemplate = Object.freeze({
  gooseVersion: "1.44.0",
  gooseArchive: "goose-x86_64-unknown-linux-gnu.tar.bz2",
  gooseSha256: "87883ab52e3748e49cf7b1ed08677337651c35d6f68f1ef9f74e8c58bcaecd73",
  name: "agent-online-pi-goose-runtime",
  nodeVersion: "24.16.0",
  piVersion: "0.82.0",
  pnpmVersion: "10.33.2",
  previewViteVersion: "8.1.5",
  tag: "v4",
});

export function createPiGooseRuntimeTemplate() {
  const gooseReleaseUrl =
    `https://github.com/aaif-goose/goose/releases/download/v${piGooseRuntimeTemplate.gooseVersion}` +
    `/${piGooseRuntimeTemplate.gooseArchive}`;

  const installGoose = [
    "set -eu",
    `archive=/tmp/${piGooseRuntimeTemplate.gooseArchive}`,
    `curl --fail --silent --show-error --location "${gooseReleaseUrl}" --output "$archive"`,
    `printf '%s  %s\\n' "${piGooseRuntimeTemplate.gooseSha256}" "$archive" | sha256sum --check --strict`,
    'tar --extract --bzip2 --file "$archive" --directory /usr/local/bin ./goose',
    "chmod 0755 /usr/local/bin/goose",
    'rm --force "$archive"',
  ].join("; ");
  const platformManifest = Buffer.from(
    JSON.stringify({
      agentRuntimes: {
        goose: piGooseRuntimeTemplate.gooseVersion,
        pi: piGooseRuntimeTemplate.piVersion,
      },
      developerToolchains: ["node", "npm", "pnpm", "python3", "git", "build-essential"],
      node: piGooseRuntimeTemplate.nodeVersion,
      platformCapabilities: {
        preview: {
          executable: "/opt/agent-online/preview/node_modules/.bin/vite",
          preset: "vite-v1",
          version: piGooseRuntimeTemplate.previewViteVersion,
        },
      },
      schemaVersion: 1,
    }),
  ).toString("base64");

  return Template()
    .fromNodeImage(piGooseRuntimeTemplate.nodeVersion)
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
      `npm install --global --ignore-scripts @earendil-works/pi-coding-agent@${piGooseRuntimeTemplate.piVersion}`,
      { user: "root" },
    )
    .runCmd(`npm install --global pnpm@${piGooseRuntimeTemplate.pnpmVersion}`, {
      user: "root",
    })
    .runCmd(installGoose, { user: "root" })
    .runCmd(
      [
        "mkdir -p /opt/agent-online/preview",
        `npm install --prefix /opt/agent-online/preview --no-audit --no-fund --no-save vite@${piGooseRuntimeTemplate.previewViteVersion}`,
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
    .runCmd("pi --version")
    .runCmd("goose --version");
}
