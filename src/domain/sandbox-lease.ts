import type { SandboxLeaseStatus } from "../shared/protocol";

export { sandboxLeaseStatuses } from "../shared/protocol";
export type { SandboxLeaseStatus } from "../shared/protocol";

const activeStatuses = new Set<SandboxLeaseStatus>(["starting", "ready", "busy", "idle"]);

export function isActiveSandboxLease(status: SandboxLeaseStatus) {
  return activeStatuses.has(status);
}

export function canStartSandboxLease(currentStatus: SandboxLeaseStatus | null) {
  return currentStatus === null || !isActiveSandboxLease(currentStatus);
}
