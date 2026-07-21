import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Automation, AutomationRun } from "../shared/types.js";
import { HostError } from "../shared/errors.js";
import { desktopDir, ensureDesktopDirs } from "./paths.js";

interface AutoFile {
  version: number;
  automations: Automation[];
  runs: AutomationRun[];
}

/** Interval schedule strings like every_15_minutes */
export function isIntervalSchedule(schedule: string | undefined | null): boolean {
  return /^every_\d+_minutes?$/i.test(String(schedule ?? "").trim());
}

export class AutomationStore {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly home?: string) {
    ensureDesktopDirs(home);
  }

  private file(): string {
    return path.join(desktopDir(this.home), "automations", "automations.json");
  }

  private read(): AutoFile {
    const f = this.file();
    if (!fs.existsSync(f)) return { version: 1, automations: [], runs: [] };
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as AutoFile;
    } catch {
      return { version: 1, automations: [], runs: [] };
    }
  }

  private write(data: AutoFile): void {
    const dir = path.dirname(this.file());
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.file());
  }

  list(): Automation[] {
    return this.read().automations;
  }

  listRuns(automationId?: string): AutomationRun[] {
    const runs = this.read().runs;
    return automationId
      ? runs.filter((r) => r.automationId === automationId)
      : runs;
  }

  create(
    input: Omit<Automation, "id" | "createdAt" | "updatedAt" | "status"> & {
      status?: Automation["status"];
    },
  ): Automation {
    const now = new Date().toISOString();
    const schedule = String(input.schedule ?? "").trim();
    const isScheduled = isIntervalSchedule(schedule);
    // Explicit false default; interval jobs never store YOLO.
    const alwaysApprove = isScheduled ? false : input.alwaysApprove === true;
    const a: Automation = {
      ...input,
      schedule,
      alwaysApprove,
      id: `auto_${randomUUID()}`,
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    const data = this.read();
    data.automations.push(a);
    this.write(data);
    return a;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Automation,
        | "name"
        | "description"
        | "status"
        | "schedule"
        | "prompt"
        | "skillRef"
        | "worktreeMode"
        | "model"
        | "alwaysApprove"
        | "nextRunHint"
        | "lastRunAt"
      >
    >,
  ): Automation {
    const data = this.read();
    const a = data.automations.find((x) => x.id === id);
    if (!a) throw new HostError("INVALID_ARGUMENT", `Unknown automation: ${id}`);
    Object.assign(a, patch, { updatedAt: new Date().toISOString() });
    const schedule = String(a.schedule ?? "").trim();
    if (isIntervalSchedule(schedule)) {
      a.alwaysApprove = false;
    } else if (patch.alwaysApprove !== undefined) {
      a.alwaysApprove = patch.alwaysApprove === true;
    }
    this.write(data);
    return a;
  }

  delete(id: string): void {
    const data = this.read();
    data.automations = data.automations.filter((a) => a.id !== id);
    this.write(data);
    this.stopTimer(id);
  }

  pause(id: string): Automation {
    return this.update(id, { status: "paused" });
  }

  recordRun(run: Omit<AutomationRun, "id">): AutomationRun {
    const full: AutomationRun = { ...run, id: `run_${randomUUID()}` };
    const data = this.read();
    data.runs.unshift(full);
    if (data.runs.length > 200) data.runs = data.runs.slice(0, 200);
    this.write(data);
    return full;
  }

  finishRun(
    runId: string,
    patch: Partial<Pick<AutomationRun, "status" | "finishedAt" | "sessionId" | "summary" | "error">>,
  ): void {
    const data = this.read();
    const r = data.runs.find((x) => x.id === runId);
    if (!r) return;
    Object.assign(r, patch);
    this.write(data);
  }

  /**
   * Drop YOLO on interval jobs (legacy data may have alwaysApprove true).
   * Also normalize undefined alwaysApprove to false.
   */
  migrateSafeDefaults(): number {
    const data = this.read();
    let changed = 0;
    for (const a of data.automations) {
      const sched = String(a.schedule ?? "").trim();
      if (isIntervalSchedule(sched) && a.alwaysApprove !== false) {
        a.alwaysApprove = false;
        changed++;
      }
      if (a.alwaysApprove === undefined) {
        a.alwaysApprove = false;
        changed++;
      }
    }
    if (changed) this.write(data);
    return changed;
  }

  /** Simple interval scheduler: schedule string "every_N_minutes" or ignore. */
  startScheduler(
    onFire: (automation: Automation) => void | Promise<void>,
  ): void {
    this.migrateSafeDefaults();
    for (const a of this.list()) {
      if (a.status !== "active") continue;
      this.arm(a, onFire);
    }
  }

  stopAllTimers(): void {
    for (const id of [...this.timers.keys()]) this.stopTimer(id);
  }

  private arm(
    a: Automation,
    onFire: (automation: Automation) => void | Promise<void>,
  ): void {
    this.stopTimer(a.id);
    const m = /^every_(\d+)_minutes?$/i.exec(a.schedule.trim());
    const minutes = m ? Math.max(1, Number(m[1])) : 0;
    if (!minutes) return; // cron-like deferred; manual runNow still works
    const handle = setInterval(() => {
      void onFire(a);
    }, minutes * 60_000);
    this.timers.set(a.id, handle);
  }

  private stopTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
  }
}
