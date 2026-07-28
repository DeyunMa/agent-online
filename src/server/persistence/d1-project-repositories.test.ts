import { describe, expect, it } from "vitest";

import { D1MessageRepository, D1ProjectRepository } from "./d1-repositories";
import { TestD1Database } from "./d1-test-database";

describe("D1 Project and Message repositories", () => {
  it("maps owned Project rows from snake_case", async () => {
    const db = new TestD1Database();
    db.firstRows.push({
      created_at: "2026-07-25T00:00:00.000Z",
      default_agent_runtime_id: "pi",
      id: "project-1",
      title: "Example",
      updated_at: "2026-07-25T00:01:00.000Z",
      user_id: "user-1",
    });

    const project = await new D1ProjectRepository(db.asBinding()).findOwnedById(
      "project-1",
      "user-1",
    );

    expect(project).toEqual({
      createdAt: "2026-07-25T00:00:00.000Z",
      defaultAgentRuntimeId: "pi",
      id: "project-1",
      title: "Example",
      updatedAt: "2026-07-25T00:01:00.000Z",
      userId: "user-1",
    });
  });

  it("renames and deletes only through the owned Project key", async () => {
    const db = new TestD1Database();
    db.firstRows.push({
      created_at: "2026-07-25T00:00:00.000Z",
      default_agent_runtime_id: "pi",
      id: "project-1",
      title: "Renamed",
      updated_at: "2026-07-25T01:00:00.000Z",
      user_id: "user-1",
    });
    const repository = new D1ProjectRepository(db.asBinding());

    const renamed = await repository.renameOwned({
      projectId: "project-1",
      title: "Renamed",
      updatedAt: "2026-07-25T01:00:00.000Z",
      userId: "user-1",
    });
    const deleted = await repository.deleteOwned("project-1", "user-1");

    expect(renamed).toMatchObject({
      id: "project-1",
      title: "Renamed",
      updatedAt: "2026-07-25T01:00:00.000Z",
    });
    expect(deleted).toBe(true);
    expect(db.prepared[0]?.query).toContain("WHERE id = ? AND user_id = ?");
    expect(db.prepared[0]?.bindings).toEqual([
      "Renamed",
      "2026-07-25T01:00:00.000Z",
      "project-1",
      "user-1",
    ]);
    expect(db.prepared[2]?.query).toContain("DELETE FROM projects WHERE id = ? AND user_id = ?");
    expect(db.prepared[2]?.bindings).toEqual(["project-1", "user-1"]);
  });

  it("lists visible messages by Project in sequence order", async () => {
    const db = new TestD1Database();
    db.allRows.push([
      {
        agent_run_id: null,
        content: "First message",
        created_at: "2026-07-25T00:00:00.000Z",
        id: "message-1",
        project_id: "project-1",
        role: "user",
        sequence: 0,
      },
      {
        agent_run_id: "run-1",
        content: "Final answer",
        created_at: "2026-07-25T00:01:00.000Z",
        id: "message-2",
        project_id: "project-1",
        role: "assistant",
        sequence: 1,
      },
    ]);

    const messages = await new D1MessageRepository(db.asBinding()).listByProjectId("project-1");

    expect(messages).toEqual([
      {
        agentRunId: null,
        content: "First message",
        createdAt: "2026-07-25T00:00:00.000Z",
        id: "message-1",
        projectId: "project-1",
        role: "user",
        sequence: 0,
      },
      {
        agentRunId: "run-1",
        content: "Final answer",
        createdAt: "2026-07-25T00:01:00.000Z",
        id: "message-2",
        projectId: "project-1",
        role: "assistant",
        sequence: 1,
      },
    ]);
    expect(db.prepared[0]?.query).toContain("ORDER BY sequence ASC");
    expect(db.prepared[0]?.bindings).toEqual(["project-1"]);
  });

  it("finds an input message only inside its Project boundary", async () => {
    const db = new TestD1Database();
    db.firstRows.push({
      agent_run_id: null,
      content: "Inspect the project",
      created_at: "2026-07-25T00:00:00.000Z",
      id: "message-1",
      project_id: "project-1",
      role: "user",
      sequence: 0,
    });

    const message = await new D1MessageRepository(db.asBinding()).findById(
      "message-1",
      "project-1",
    );

    expect(message).toMatchObject({ id: "message-1", projectId: "project-1", role: "user" });
    expect(db.prepared[0]?.query).toContain("WHERE id = ? AND project_id = ?");
    expect(db.prepared[0]?.bindings).toEqual(["message-1", "project-1"]);
  });
});
