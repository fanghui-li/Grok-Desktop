import { afterEach, describe, expect, it } from "vitest";
import {
  applyGoalUpdated,
  clearSessionGoal,
  getSessionGoal,
  markGoalClearedLocal,
  parseGoalWireStatus,
  shouldDropGoalStatusDowngrade,
} from "../src/host/session-goal-store.js";

const SID = "sess-goal-test";

afterEach(() => {
  clearSessionGoal(SID);
});

describe("parseGoalWireStatus", () => {
  it("maps wire statuses", () => {
    expect(parseGoalWireStatus("active")).toBe("active");
    expect(parseGoalWireStatus("user_paused")).toBe("user_paused");
    expect(parseGoalWireStatus("paused")).toBe("user_paused");
    expect(parseGoalWireStatus("back_off_paused")).toBe("back_off_paused");
    expect(parseGoalWireStatus("complete")).toBe("complete");
    expect(parseGoalWireStatus("completed")).toBe("complete");
    expect(parseGoalWireStatus("cleared")).toBe("cleared");
    expect(parseGoalWireStatus("cancelled")).toBe("cleared");
  });

  it("fail-safe unknown to user_paused", () => {
    expect(parseGoalWireStatus("weird_future_status")).toBe("user_paused");
  });
});

describe("applyGoalUpdated", () => {
  it("creates projection from goal_updated", () => {
    const r = applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "ship feature",
      status: "active",
      elapsedMs: 1000,
    });
    expect(r.dropped).toBe(false);
    expect(r.projection?.goalId).toBe("g1");
    expect(r.projection?.objective).toBe("ship feature");
    expect(r.projection?.status).toBe("active");
    expect(getSessionGoal(SID)?.elapsedMs).toBe(1000);
  });

  it("clears and drops late same-id updates", () => {
    applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "x",
      status: "active",
    });
    const cleared = applyGoalUpdated({
      sessionId: SID,
      goalId: "",
      objective: "",
      status: "cleared",
    });
    expect(cleared.cleared).toBe(true);
    expect(getSessionGoal(SID)).toBeNull();

    const late = applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "x",
      status: "complete",
      elapsedMs: 5000,
    });
    expect(late.dropped).toBe(true);
    expect(getSessionGoal(SID)).toBeNull();
  });

  it("allows new goal id after clear", () => {
    applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "old",
      status: "active",
    });
    applyGoalUpdated({
      sessionId: SID,
      goalId: "",
      status: "cleared",
    });
    const r = applyGoalUpdated({
      sessionId: SID,
      goalId: "g2",
      objective: "new",
      status: "active",
      elapsedMs: 100,
    });
    expect(r.dropped).toBe(false);
    expect(getSessionGoal(SID)?.goalId).toBe("g2");
    expect(getSessionGoal(SID)?.elapsedFloorMs).toBe(100);
  });

  it("does not tick elapsed backward on same goal", () => {
    applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "x",
      status: "active",
      elapsedMs: 10_000,
    });
    const r = applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "x",
      status: "active",
      elapsedMs: 8_000,
    });
    expect(r.projection?.elapsedMs).toBe(8_000);
    expect(r.projection?.elapsedFloorMs).toBe(10_000);
  });

  it("markGoalClearedLocal blocks resurrection", () => {
    applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "x",
      status: "active",
    });
    markGoalClearedLocal(SID, "g1");
    expect(getSessionGoal(SID)).toBeNull();
    const late = applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "x",
      status: "active",
    });
    expect(late.dropped).toBe(true);
  });

  it("complete is sticky against late infra_paused (rate-limit after done)", () => {
    applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "min goal",
      status: "active",
      elapsedMs: 60_000,
    });
    applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "min goal",
      status: "complete",
      elapsedMs: 700_000,
    });
    expect(getSessionGoal(SID)?.status).toBe("complete");

    const latePause = applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "min goal",
      status: "infra_paused",
      message: "Turn failed: Rate limited",
      elapsedMs: 710_000,
    });
    expect(latePause.dropped).toBe(true);
    expect(getSessionGoal(SID)?.status).toBe("complete");

    // lagging active also dropped
    const lateActive = applyGoalUpdated({
      sessionId: SID,
      goalId: "g1",
      objective: "min goal",
      status: "active",
    });
    expect(lateActive.dropped).toBe(true);
    expect(getSessionGoal(SID)?.status).toBe("complete");
  });

  it("shouldDropGoalStatusDowngrade matrix", () => {
    expect(shouldDropGoalStatusDowngrade("complete", "infra_paused", true)).toBe(
      true,
    );
    expect(shouldDropGoalStatusDowngrade("complete", "active", true)).toBe(true);
    expect(shouldDropGoalStatusDowngrade("complete", "complete", true)).toBe(
      false,
    );
    expect(shouldDropGoalStatusDowngrade("complete", "cleared", true)).toBe(
      false,
    );
    expect(shouldDropGoalStatusDowngrade("active", "infra_paused", true)).toBe(
      false,
    );
    expect(
      shouldDropGoalStatusDowngrade("budget_limited", "user_paused", true),
    ).toBe(true);
  });
});
