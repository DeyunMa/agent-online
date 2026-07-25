export const sandboxLeaseStatuses = ["stopped", "starting", "ready", "busy", "idle", "failed"] as const;

export type SandboxLeaseStatus = (typeof sandboxLeaseStatuses)[number];

const activeStatuses = new Set<SandboxLeaseStatus>(["starting", "ready", "busy", "idle"]);

export function isActiveSandboxLease(status: SandboxLeaseStatus) {
  return activeStatuses.has(status);
}

export function canStartSandboxLease(currentStatus: SandboxLeaseStatus | null) {
  return currentStatus === null || !isActiveSandboxLease(currentStatus);
}
