import { Template } from "e2b";

export const piRuntimeTemplate = Object.freeze({
  name: "agent-online-pi-runtime",
  nodeVersion: "24.16.0",
  piVersion: "0.82.0",
  tag: "v2",
});

export function createPiRuntimeTemplate() {
  return Template()
    .fromNodeImage(piRuntimeTemplate.nodeVersion)
    .runCmd(
      `npm install --global --ignore-scripts @earendil-works/pi-coding-agent@${piRuntimeTemplate.piVersion}`,
      { user: "root" },
    )
    .makeDir("/workspace", { mode: 0o755, user: "root" })
    .runCmd("chown user:user /workspace", { user: "root" })
    .setUser("user")
    .setWorkdir("/workspace")
    .runCmd("node --version")
    .runCmd("pi --version");
}
