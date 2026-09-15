import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { ensureSessionGoalStatusSchema } from "./session-goal-schema.js";

it("migrates legacy goals atomically, preserving usage, links and cascading deletion", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE sessions(session_key TEXT PRIMARY KEY);
      INSERT INTO sessions VALUES ('fixture');
      CREATE TABLE session_goals (
        session_key TEXT PRIMARY KEY REFERENCES sessions(session_key) ON DELETE CASCADE,
        goal_id TEXT, objective TEXT, status TEXT CHECK(status IN ('active','paused','blocked','budget_limited','complete')),
        token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER,
        task_id TEXT, project_id TEXT, blocked_reason TEXT, created_at INTEGER, updated_at INTEGER
      );
      INSERT INTO session_goals VALUES ('fixture','goal_fixture','Finish fixture','blocked',100,12,3,'task_fixture','project_fixture','Waiting',1000,2000);
    `);
    const before = db.query("SELECT * FROM session_goals").get();
    ensureSessionGoalStatusSchema(db);
    ensureSessionGoalStatusSchema(db);
    expect(db.query("SELECT * FROM session_goals").get()).toEqual(before);
    db.exec("UPDATE session_goals SET status='usage_limited'");
    expect(db.query("SELECT status FROM session_goals").get()).toEqual({ status: "usage_limited" });
    db.exec("DELETE FROM sessions");
    expect(db.query("SELECT * FROM session_goals").get()).toBeNull();
  } finally {
    db.close();
  }
});
