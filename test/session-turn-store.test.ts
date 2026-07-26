import { describe, expect, it, beforeEach } from "vitest";
import {
  appendBackgroundAssistantDelta,
  clearSessionTurn,
  getSessionTurn,
  idleProjection,
  patchSessionTurn,
  setSessionTurn,
  shouldRehydrateBusy,
} from "../src/renderer/session/turn-store.js";

describe("session-turn-store (方案 B)", () => {
  beforeEach(() => {
    clearSessionTurn("s1");
    clearSessionTurn("s2");
  });

  it("snapshots and restores per session independently", () => {
    setSessionTurn("s1", {
      ...idleProjection(),
      turnActive: true,
      turnUiPhase: "working",
      turnStartedAt: 1000,
      currentTurnId: 3,
    });
    setSessionTurn("s2", {
      ...idleProjection(),
      turnActive: false,
      turnUiPhase: "idle",
    });
    expect(getSessionTurn("s1")?.turnActive).toBe(true);
    expect(getSessionTurn("s2")?.turnActive).toBe(false);
  });

  it("background deltas accumulate pending text and mark active", () => {
    appendBackgroundAssistantDelta("s1", "hello ");
    appendBackgroundAssistantDelta("s1", "world");
    const p = getSessionTurn("s1")!;
    expect(p.turnActive).toBe(true);
    expect(p.pendingAssistantText).toBe("hello world");
  });

  it("shouldRehydrateBusy prefers Host promptInFlight over stale projection", () => {
    expect(
      shouldRehydrateBusy({
        projection: { ...idleProjection(), turnActive: true },
        sidebarWorking: true,
        promptInFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldRehydrateBusy({
        projection: idleProjection(),
        sidebarWorking: false,
        promptInFlight: true,
      }),
    ).toBe(true);
    expect(
      shouldRehydrateBusy({
        projection: null,
        sidebarWorking: true,
      }),
    ).toBe(true);
    expect(
      shouldRehydrateBusy({
        projection: { ...idleProjection(), turnActive: true },
        sidebarWorking: false,
      }),
    ).toBe(true);
    expect(
      shouldRehydrateBusy({
        projection: idleProjection(),
        sidebarWorking: false,
        threadStatus: "idle",
      }),
    ).toBe(false);
    expect(
      shouldRehydrateBusy({
        projection: null,
        sidebarWorking: false,
        threadStatus: "working",
      }),
    ).toBe(true);
  });

  it("patchSessionTurn merges", () => {
    setSessionTurn("s1", { ...idleProjection(), turnActive: true });
    patchSessionTurn("s1", { turnActive: false, turnUiPhase: "idle" });
    expect(getSessionTurn("s1")?.turnActive).toBe(false);
    expect(getSessionTurn("s1")?.turnUiPhase).toBe("idle");
  });
});
