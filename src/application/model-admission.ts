/** A request allowance is consumed before forwarding, independently of measured usage. */
export interface ModelAdmission {
  acquire(runId: string): Promise<boolean>;
  release(runId: string): Promise<void>;
}
