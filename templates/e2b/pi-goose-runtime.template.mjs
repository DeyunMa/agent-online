import { Template } from "e2b";

export const piGooseRuntimeTemplate = Object.freeze({
  name: "agent-online-pi-goose-runtime",
  nodeVersion: "24.16.0",
  piVersion: "0.82.0",
  gooseVersion: "1.44.0",
  gooseArchive: "goose-x86_64-unknown-linux-gnu.tar.bz2",
  gooseSha256: "87883ab52e3748e49cf7b1ed08677337651c35d6f68f1ef9f74e8c58bcaecd73",
  tag: "v3",
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

  return Template()
    .fromNodeImage(piGooseRuntimeTemplate.nodeVersion)
    .runCmd(
      "apt-get update && apt-get install --yes --no-install-recommends bash bzip2 ca-certificates coreutils curl git && rm -rf /var/lib/apt/lists/*",
      { user: "root" },
    )
    .runCmd(
      `npm install --global --ignore-scripts @earendil-works/pi-coding-agent@${piGooseRuntimeTemplate.piVersion}`,
      { user: "root" },
    )
    .runCmd(installGoose, { user: "root" })
    .makeDir("/workspace", { mode: 0o755, user: "root" })
    .runCmd("chown user:user /workspace", { user: "root" })
    .setUser("user")
    .setWorkdir("/workspace")
    .runCmd("node --version")
    .runCmd("/usr/bin/git --version")
    .runCmd("/bin/bash --version | head -n 1")
    .runCmd("pi --version")
    .runCmd("goose --version");
}
