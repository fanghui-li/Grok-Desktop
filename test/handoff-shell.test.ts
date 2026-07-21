import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSingleInstance } from "../src/host/single-instance.js";
import { DesktopHost } from "../src/host/host.js";
import {
  computeTrayBadge,
  extractHandoffPayload,
  extractNavView,
  handoffFilePath,
  parseDeepLink,
  readAndClearHandoff,
  writeHandoff,
} from "../src/host/shell-state.js";
import {
  shellEventFromLegacyActivity,
  shellHandoffEvent,
  shellNavigateEvent,
  shellNoticeEvent,
} from "../src/shared/events.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("handoff / deep link shell fixes", () => {
  it("extractHandoffPayload and extractNavView parse activity field", () => {
    expect(extractHandoffPayload("handoff:grok://session/abc")).toBe(
      "grok://session/abc",
    );
    expect(extractHandoffPayload("nav:command")).toBeNull();
    expect(extractNavView("nav:inbox")).toBe("inbox");
    expect(extractNavView("handoff:x")).toBeNull();
  });

  it("parseDeepLink routes session/project/inbox/automation", () => {
    expect(parseDeepLink("grok://session/abc-123")).toMatchObject({
      kind: "session",
      id: "abc-123",
    });
    expect(parseDeepLink("grok://inbox/item1").kind).toBe("inbox");
    expect(parseDeepLink("grok://project/p1").kind).toBe("project");
    expect(parseDeepLink("grok://automation/a1").kind).toBe("automation");
  });

  it("shell event helpers and legacy activity mapping", () => {
    expect(shellHandoffEvent("grok://focus").type).toBe("shell.handoff");
    expect(shellNavigateEvent("command").view).toBe("command");
    expect(shellNoticeEvent("agent_missing").code).toBe("agent_missing");
    expect(shellEventFromLegacyActivity("nav:inbox")).toMatchObject({
      type: "shell.navigate",
      view: "inbox",
    });
    expect(shellEventFromLegacyActivity("handoff:grok://x")).toMatchObject({
      type: "shell.handoff",
      payload: "grok://x",
    });
    expect(shellEventFromLegacyActivity("system:agent_missing")?.type).toBe(
      "shell.notice",
    );
    expect(shellEventFromLegacyActivity("working")).toBeNull();
  });

  it("computeTrayBadge supports zh locale labels", () => {
    const en = computeTrayBadge(
      [
        {
          sessionId: "a",
          title: "t1",
          cwd: "/x",
          status: "needs_input",
          source: "live",
          updatedAt: new Date().toISOString(),
        },
      ],
      [],
      { locale: "en" },
    );
    expect(en.label).toContain("needs input");
    const zh = computeTrayBadge(
      [
        {
          sessionId: "a",
          title: "t1",
          cwd: "/x",
          status: "needs_input",
          source: "live",
          updatedAt: new Date().toISOString(),
        },
      ],
      [],
      { locale: "zh-CN" },
    );
    expect(zh.label).toContain("待输入");
  });

  it("handoffFilePath is under desktop dir", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-handoff-path-"));
    const f = handoffFilePath(home);
    expect(f.endsWith(`${path.sep}handoff.json`)).toBe(true);
    expect(f.includes("desktop")).toBe(true);
  });

  it("primary TCP server persists secondary payload via writeHandoff", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-handoff-tcp-"));
    const received: string[] = [];

    const primary = await acquireSingleInstance({
      home,
      onSecondaryPayload: (p) => received.push(p),
    });
    cleanups.push(() => primary.release());
    expect(primary.isPrimary).toBe(true);
    expect(primary.port).toBeTypeOf("number");

    const secondary = await acquireSingleInstance({ home });
    cleanups.push(() => secondary.release());
    expect(secondary.isPrimary).toBe(false);

    const ok = await secondary.notifyPrimary("grok://session/from-tcp");
    expect(ok).toBe(true);

    // Allow TCP end handler to flush
    await new Promise((r) => setTimeout(r, 200));

    // Callback and/or FS handoff must see payload
    const fromFs = readAndClearHandoff(home);
    const payload = received[0] ?? fromFs?.payload ?? null;
    expect(payload).toBe("grok://session/from-tcp");
    expect(extractHandoffPayload(`handoff:${payload}`)).toBe(
      "grok://session/from-tcp",
    );
  });

  it("writeHandoff + readAndClear is ordered for primary poll", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-handoff-fs-"));
    writeHandoff("grok://inbox/x", home);
    const h = readAndClearHandoff(home);
    expect(h?.payload).toBe("grok://inbox/x");
    expect(readAndClearHandoff(home)).toBeNull();
  });

  it("Host handoff consumer is woken by shellWriteHandoff", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-handoff-host-"));
    const host = new DesktopHost({ home, grokPath: null, bundledPath: null });
    cleanups.push(() => {
      void host.dispose();
    });
    let n = 0;
    host.shellSetHandoffConsumer(() => {
      n += 1;
    });
    host.shellWriteHandoff("grok://focus");
    await new Promise((r) => setTimeout(r, 80));
    expect(n).toBeGreaterThanOrEqual(1);
    const h = host.shellReadHandoff();
    expect(h?.payload).toBe("grok://focus");
    const watch = host.shellStartHandoffWatch();
    expect(watch.path).toBe(handoffFilePath(home));
    expect(["fs.watch", "poll"]).toContain(watch.mode);
    host.shellStopHandoffWatch();
    host.shellSetHandoffConsumer(null);
  });
});
