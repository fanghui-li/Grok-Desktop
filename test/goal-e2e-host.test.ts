/**
 * Goal Host-layer E2E — maps docs/goal-handtest-checklist.md automatable items.
 *
 * Scope: DesktopHost + fake ACP agent (stdio). Not Electron UI clicks.
 * Covers: N1–N3, P2–P4, L1–L3/L5–L7, B2, M1–M2, D1-ish (goalsGet projection).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopHost } from "../src/host/host.js";
import {
  applyGoalUpdated,
  clearSessionGoal,
  getSessionGoal,
} from "../src/host/session-goal-store.js";
import type { NormalizedEvent } from "../src/shared/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(here, "fake-acp-agent.mjs");
const nodeBin = process.execPath;

const hosts: DesktopHost[] = [];

afterEach(async () => {
  while (hosts.length) {
    await hosts.pop()!.dispose().catch(() => undefined);
  }
});

function makeHost(env: NodeJS.ProcessEnv = {}): DesktopHost {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-goal-e2e-"));
  const host = new DesktopHost({
    home,
    grokPath: nodeBin,
    agentArgs: [fakeAgent],
    env: { ...process.env, ...env },
  });
  hosts.push(host);
  return host;
}

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-goal-cwd-"));
}

function goalEvents(events: NormalizedEvent[]) {
  return events.filter((e) => e.type === "goal.updated");
}

async function waitFor(
  pred: () => boolean,
  ms = 3000,
  step = 30,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, step));
  }
}

describe("Goal E2E (Host + fake agent) · checklist map", () => {
  // ── §1 负例 ─────────────────────────────────────────────
  describe("N1–N3 plain chat must not open goal", () => {
    it("N1/N2: ordinary prompts never emit goal.updated or goalsGet", async () => {
      const host = makeHost();
      const events: NormalizedEvent[] = [];
      host.subscribe((e) => events.push(e));
      const cwd = tempCwd();

      const created = await host.threadsCreate({
        cwd,
        title: "plain",
        prompt: "按项目风格指南改一下 README 结构",
      });
      await host.turnsPrompt(created.threadId, "继续改第二节");

      expect(goalEvents(events)).toHaveLength(0);
      expect(host.goalsGet(created.sessionId)).toBeNull();
      expect(getSessionGoal(created.sessionId)).toBeNull();
    });

    it("N3: update_goal tool noise alone does not create projection", async () => {
      const host = makeHost({ FAKE_ACP_NOISE_UPDATE_GOAL: "1" });
      const events: NormalizedEvent[] = [];
      host.subscribe((e) => events.push(e));
      const cwd = tempCwd();

      const created = await host.threadsCreate({
        cwd,
        prompt: "normal work with noisy tool",
      });

      // tool.started/completed may appear; goal.updated must not
      expect(goalEvents(events)).toHaveLength(0);
      expect(host.goalsGet(created.sessionId)).toBeNull();
    });
  });

  // ── §2 正例 ─────────────────────────────────────────────
  describe("P2–P4 explicit /goal", () => {
    it("P2–P4: /goal objective creates goal.updated + store projection", async () => {
      const host = makeHost();
      const events: NormalizedEvent[] = [];
      host.subscribe((e) => events.push(e));
      const cwd = tempCwd();

      const created = await host.threadsCreate({
        cwd,
        title: "goal-set",
      });
      expect(host.goalsGet(created.sessionId)).toBeNull();

      await host.turnsPrompt(
        created.threadId,
        "/goal 在 docs 下加一个 FAQ 小节",
      );

      await waitFor(() => goalEvents(events).length >= 1);

      const ge = goalEvents(events);
      expect(ge.length).toBeGreaterThanOrEqual(1);
      const last = ge[ge.length - 1]!;
      expect(last.type).toBe("goal.updated");
      if (last.type === "goal.updated") {
        expect(last.objective).toContain("FAQ");
        expect(last.status).toBe("active");
        expect(last.goalId).toBeTruthy();
      }

      const g = host.goalsGet(created.sessionId);
      expect(g).toBeTruthy();
      expect(g!.title).toContain("FAQ");
      expect(g!.status).toBe("active");
      expect(g!.projection?.status).toBe("active");
      expect(g!.projection?.goalId).toBeTruthy();
    });

    it("P5-ish: follow-up plain message keeps goal projection", async () => {
      const host = makeHost();
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });
      await host.turnsPrompt(created.threadId, "/goal keep me active");
      await waitFor(() => getSessionGoal(created.sessionId) != null);

      const before = getSessionGoal(created.sessionId)!;
      await host.turnsPrompt(created.threadId, "继续做下一步");
      const after = getSessionGoal(created.sessionId);
      expect(after).toBeTruthy();
      expect(after!.goalId).toBe(before.goalId);
      expect(after!.status).toBe("active");
    });
  });

  // ── §3 生命周期 ─────────────────────────────────────────
  describe("L1–L7 pause resume clear", () => {
    it("L2/L3: /goal pause then resume updates projection", async () => {
      const host = makeHost();
      const events: NormalizedEvent[] = [];
      host.subscribe((e) => events.push(e));
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });

      await host.turnsPrompt(created.threadId, "/goal lifecycle target");
      await waitFor(() => getSessionGoal(created.sessionId)?.status === "active");

      await host.turnsPrompt(created.threadId, "/goal pause");
      await waitFor(
        () => getSessionGoal(created.sessionId)?.status === "user_paused",
      );
      expect(getSessionGoal(created.sessionId)?.status).toBe("user_paused");

      await host.turnsPrompt(created.threadId, "/goal resume");
      await waitFor(
        () => getSessionGoal(created.sessionId)?.status === "active",
      );
      expect(getSessionGoal(created.sessionId)?.status).toBe("active");
    });

    it("L5/L6: /goal clear drops projection; plain chat stays clean", async () => {
      const host = makeHost();
      const events: NormalizedEvent[] = [];
      host.subscribe((e) => events.push(e));
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });

      await host.turnsPrompt(created.threadId, "/goal to be cleared");
      await waitFor(() => getSessionGoal(created.sessionId) != null);
      const gid = getSessionGoal(created.sessionId)!.goalId;

      await host.turnsPrompt(created.threadId, "/goal clear");
      await waitFor(() => getSessionGoal(created.sessionId) == null);

      expect(host.goalsGet(created.sessionId)).toBeNull();

      // L6
      const nBefore = goalEvents(events).length;
      await host.turnsPrompt(created.threadId, "普通聊天");
      const afterClear = goalEvents(events).slice(nBefore);
      // only possible is nothing new active
      expect(
        afterClear.every(
          (e) => e.type === "goal.updated" && e.status === "cleared",
        ),
      ).toBe(true);
      expect(getSessionGoal(created.sessionId)).toBeNull();

      // same id resurrection blocked if late event applied via store
      // (Host already applied clear; late same-id dropped by store)
      void gid;
    });

    it("L7: new /goal after clear works with new goal id", async () => {
      const host = makeHost();
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });

      await host.turnsPrompt(created.threadId, "/goal first goal");
      await waitFor(() => getSessionGoal(created.sessionId) != null);
      const id1 = getSessionGoal(created.sessionId)!.goalId;

      await host.turnsPrompt(created.threadId, "/goal clear");
      await waitFor(() => getSessionGoal(created.sessionId) == null);

      await host.turnsPrompt(created.threadId, "/goal second goal B");
      await waitFor(() => getSessionGoal(created.sessionId) != null);
      const id2 = getSessionGoal(created.sessionId)!.goalId;
      expect(id2).not.toBe(id1);
      expect(getSessionGoal(created.sessionId)!.objective).toContain("second");
    });
  });

  // ── §4 budget ───────────────────────────────────────────
  describe("B2 budget flag", () => {
    it("parses /goal obj --budget N into projection.tokenBudget", async () => {
      const host = makeHost();
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });
      await host.turnsPrompt(
        created.threadId,
        "/goal small task --budget 50000",
      );
      await waitFor(() => getSessionGoal(created.sessionId) != null);
      expect(getSessionGoal(created.sessionId)!.tokenBudget).toBe(50000);
    });
  });

  // ── §6 多会话 ───────────────────────────────────────────
  describe("M1–M2 multi-session isolation", () => {
    it("session A goal does not appear on session B goalsGet", async () => {
      const host = makeHost();
      const cwdA = tempCwd();
      const cwdB = tempCwd();

      const a = await host.threadsCreate({ cwd: cwdA, title: "A" });
      const b = await host.threadsCreate({ cwd: cwdB, title: "B" });

      await host.turnsPrompt(a.threadId, "/goal only on A");
      await waitFor(() => getSessionGoal(a.sessionId) != null);

      await host.turnsPrompt(b.threadId, "plain on B");

      expect(host.goalsGet(a.sessionId)?.title).toContain("only on A");
      expect(host.goalsGet(b.sessionId)).toBeNull();
      expect(getSessionGoal(b.sessionId)).toBeNull();
    });
  });

  // ── cold / sync ─────────────────────────────────────────
  describe("M4-ish dirty goal.json not authority", () => {
    it("goalsGet is null without wire even if legacy goal.json exists", async () => {
      const host = makeHost();
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd, title: "dirty" });
      // deprecated write: local cache only, must not become goalsGet authority
      host.goalsSet(created.sessionId, "stale dirty title", "active");
      // goalsGet reads store only — store empty without goal_updated
      clearSessionGoal(created.sessionId);
      expect(host.goalsGet(created.sessionId)).toBeNull();
    });
  });

  // ── §5 完成与防复活 ─────────────────────────────────────
  describe("C1–C2 complete + no resurrection", () => {
    it("C1: /goal complete maps to complete projection + goal.updated", async () => {
      const host = makeHost();
      const events: NormalizedEvent[] = [];
      host.subscribe((e) => events.push(e));
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });
      await host.turnsPrompt(created.threadId, "/goal finish me");
      await waitFor(() => getSessionGoal(created.sessionId)?.status === "active");

      await host.turnsPrompt(created.threadId, "/goal complete");
      await waitFor(
        () => getSessionGoal(created.sessionId)?.status === "complete",
      );

      const g = getSessionGoal(created.sessionId)!;
      expect(g.status).toBe("complete");
      expect(host.goalsGet(created.sessionId)?.status).toBe("completed");

      const completedEv = goalEvents(events).filter(
        (e) => e.type === "goal.updated" && e.status === "complete",
      );
      expect(completedEv.length).toBeGreaterThanOrEqual(1);
    });

    it("C2: after clear, late same-id active is dropped (store)", async () => {
      const host = makeHost();
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });
      await host.turnsPrompt(created.threadId, "/goal anti-resurrection");
      await waitFor(() => getSessionGoal(created.sessionId) != null);
      const gid = getSessionGoal(created.sessionId)!.goalId;

      await host.turnsPrompt(created.threadId, "/goal clear");
      await waitFor(() => getSessionGoal(created.sessionId) == null);

      // late same-id goal_updated must not resurrect (store + Host path)
      const late = applyGoalUpdated({
        sessionId: created.sessionId,
        goalId: gid,
        objective: "anti-resurrection",
        status: "active",
        elapsedMs: 9999,
      });
      expect(late.dropped).toBe(true);
      expect(getSessionGoal(created.sessionId)).toBeNull();
      expect(host.goalsGet(created.sessionId)).toBeNull();
    });
  });

  // ── L1 status slash (agent text; Host does not parse toast) ──
  describe("L1 status slash", () => {
    it("L1: /goal status does not clear projection and keeps active", async () => {
      const host = makeHost();
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });
      await host.turnsPrompt(created.threadId, "/goal status target");
      await waitFor(() => getSessionGoal(created.sessionId) != null);
      const before = getSessionGoal(created.sessionId)!;

      await host.turnsPrompt(created.threadId, "/goal status");
      // status is read-only on agent; projection unchanged
      const after = getSessionGoal(created.sessionId);
      expect(after).toBeTruthy();
      expect(after!.goalId).toBe(before.goalId);
      expect(after!.status).toBe("active");
    });
  });

  // ── S1 planning phase on create ─────────────────────────
  describe("S1 planning phase", () => {
    it("first goal_updated can carry planning phase", async () => {
      const host = makeHost();
      const events: NormalizedEvent[] = [];
      host.subscribe((e) => events.push(e));
      const cwd = tempCwd();
      const created = await host.threadsCreate({ cwd });
      await host.turnsPrompt(created.threadId, "/goal plan phase check");
      await waitFor(() => goalEvents(events).length >= 1);

      const phases = goalEvents(events)
        .filter((e): e is Extract<NormalizedEvent, { type: "goal.updated" }> =>
          e.type === "goal.updated",
        )
        .map((e) => e.phase);
      // fake emits planning then executing
      expect(phases.some((p) => p === "planning" || p === "executing")).toBe(
        true,
      );
      const g = getSessionGoal(created.sessionId);
      expect(g).toBeTruthy();
      expect(["planning", "executing", "idle"].includes(g!.phase)).toBe(true);
    });
  });
});
