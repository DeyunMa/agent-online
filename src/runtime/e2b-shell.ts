import type { SandboxCommand } from "./contract";

export function toShellCommand(command: Pick<SandboxCommand, "args" | "command">) {
  return [command.command, ...command.args].map(quoteShellArgument).join(" ");
}

function quoteShellArgument(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
