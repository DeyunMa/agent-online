import type { SandboxLeaseStatus } from "./sandbox-lease";

export type ProjectSummary = {
  activeSandboxLeaseStatus: SandboxLeaseStatus | null;
  id: string;
  latestRevisionId: string | null;
  title: string;
  userId: string;
};

export function ownsProject(project: ProjectSummary, userId: string) {
  return project.userId === userId;
}
