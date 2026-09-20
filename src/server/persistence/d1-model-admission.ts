import type { ModelAdmission } from "../../application/model-admission";
import { isResourceAdmissionError } from "./resource-admission-error";

export class D1ModelAdmission implements ModelAdmission {
  constructor(private readonly db: D1Database) {}

  async acquire(runId: string): Promise<boolean> {
    try {
      const result = await this.db
        .prepare(`UPDATE agent_runs
        SET model_admission_count = model_admission_count + 1, model_request_active = 1
        WHERE id = ? AND status IN ('starting', 'running')
          AND model_request_active = 0 AND model_admission_count < 64
          AND total_tokens < 500000 RETURNING id`)
        .bind(runId)
        .first<{ id: string }>();
      return result !== null;
    } catch (error) {
      if (isResourceAdmissionError(error)) return false;
      throw error;
    }
  }

  async release(runId: string): Promise<void> {
    await this.db
      .prepare("UPDATE agent_runs SET model_request_active = 0 WHERE id = ?")
      .bind(runId)
      .run();
  }
}
