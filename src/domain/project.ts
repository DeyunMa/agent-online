import type { SandboxLeaseStatus } from "./sandbox-lease";

export type ProjectSummary = {
  defaultAgentRuntimeId: string;
  id: string;
  sandboxLeaseStatus: SandboxLeaseStatus | null;
  title: string;
  userId: string;
};

export function ownsProject(project: ProjectSummary, userId: string) {
  return project.userId === userId;
}
