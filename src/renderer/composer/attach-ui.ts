/**
 * Composer 附件 chips / 添加 / 预览接线（整段自 main 迁出）。
 * 纯策略见 composer/attachments；发送路径仍由 main 读 list。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  MAX_COMPOSER_ATTACHMENTS,
  MAX_COMPOSER_IMAGES,
  attachIcon,
  buildPromptWithAttachments,
  planAddAttachments,
  type ComposerAttachment,
} from "./attachments.js";
import type { OpenWorkspacePathOpts } from "../open-workspace-path.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type ComposerAttachUiDeps = {
  inv: Inv;
  esc: (s: string) => string;
  showToast: (text: string, kind?: "info" | "error") => void;
  getSessionId: () => string | null;
  getPickDefaultPath: () => string | undefined;
  openPathInWorkspace: (
    opts: OpenWorkspacePathOpts,
  ) => Promise<"lightbox" | "side-pane" | "system" | "noop">;
};

export class ComposerAttachUi {
  private attachments: ComposerAttachment[] = [];

  constructor(private readonly deps: ComposerAttachUiDeps) {}

  list(): readonly ComposerAttachment[] {
    return this.attachments;
  }

  /** 兼容旧调用：可变引用（dispatch 快照用） */
  mutableList(): ComposerAttachment[] {
    return this.attachments;
  }

  setAll(next: ComposerAttachment[]): void {
    this.attachments = next;
    this.renderChips();
  }

  add(
    paths: string[],
    opts?: {
      kind?: ComposerAttachment["kind"];
      previewMap?: Record<string, string>;
    },
  ): number {
    const plan = planAddAttachments(this.attachments, paths, opts);
    for (const a of plan.toAdd) this.attachments.push(a);
    if (plan.skippedCap > 0) {
      this.deps.showToast(
        tr("attach.maxReached", { max: String(MAX_COMPOSER_ATTACHMENTS) }),
        "error",
      );
    } else if (plan.skippedImageCap > 0) {
      this.deps.showToast(
        tr("attach.imageMaxReached", { max: String(MAX_COMPOSER_IMAGES) }),
        "error",
      );
    } else if (
      plan.skippedDup > 0 &&
      plan.toAdd.length === 0 &&
      paths.length > 0
    ) {
      this.deps.showToast(tr("attach.alreadyAdded"), "info");
    }
    this.renderChips();
    void this.loadMissingImagePreviews();
    return plan.toAdd.length;
  }

  remove(path: string): void {
    this.attachments = this.attachments.filter((a) => a.path !== path);
    this.renderChips();
  }

  clear(): void {
    this.attachments = [];
    this.renderChips();
  }

  buildPrompt(userText: string): { display: string; content: string } {
    return buildPromptWithAttachments(userText, this.attachments);
  }

  async pickAndAdd(): Promise<void> {
    const res = await this.deps.inv<{ paths: string[]; canceled?: boolean }>(
      "system.pickFiles",
      {
        title: tr("attach.pickTitle"),
        defaultPath: this.deps.getPickDefaultPath(),
        multi: true,
      },
    );
    if (!res.ok || res.data?.canceled || !res.data?.paths?.length) return;
    const added = this.add(res.data.paths);
    if (added > 0) {
      this.deps.showToast(tr("attach.addedN", { n: String(added) }));
    }
  }

  private async loadMissingImagePreviews(): Promise<void> {
    const need = this.attachments.filter(
      (a) => a.kind === "image" && !a.previewUrl && a.path,
    );
    if (!need.length) return;
    let changed = false;
    await Promise.all(
      need.map(async (a) => {
        const res = await this.deps.inv<{ dataUrl: string }>(
          "files.readDataUrl",
          {
            path: a.path,
            sessionId: this.deps.getSessionId() || undefined,
          },
        );
        if (res.ok && res.data?.dataUrl) {
          a.previewUrl = res.data.dataUrl;
          changed = true;
        }
      }),
    );
    if (changed) this.renderChips();
  }

  private openImagePreview(a: ComposerAttachment): void {
    void this.deps.openPathInWorkspace({
      path: a.path,
      kind: "image",
      previewUrl: a.previewUrl,
      name: a.name,
      sessionId: this.deps.getSessionId(),
    });
  }

  renderChips(): void {
    const { esc } = this.deps;
    for (const id of ["composer-attachments", "chat-attachments"] as const) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (!this.attachments.length) {
        el.classList.add("hidden");
        el.innerHTML = "";
        continue;
      }
      el.classList.remove("hidden");
      el.innerHTML = this.attachments
        .map((a) => {
          if (a.kind === "image") {
            const src = a.previewUrl
              ? a.previewUrl.replace(/"/g, "&quot;")
              : "";
            return `<button type="button" class="attach-thumb" data-path="${esc(a.path)}" title="${esc(a.name)} · 点击查看">
            ${
              src
                ? `<img class="attach-thumb-img" src="${src}" alt="${esc(a.name)}" draggable="false" />`
                : `<span class="attach-thumb-ph">${attachIcon("image")}</span>`
            }
            <span class="attach-chip-x" data-path="${esc(a.path)}" aria-label=tr("plug.remove")>×</span>
          </button>`;
          }
          return `<span class="attach-chip" data-path="${esc(a.path)}" title="${esc(a.path)}">
            <span class="attach-chip-ico">${attachIcon(a.kind)}</span>
            <span class="attach-chip-name">${esc(a.name)}</span>
            <button type="button" class="attach-chip-x" data-path="${esc(a.path)}" aria-label=tr("plug.remove")>×</button>
          </span>`;
        })
        .join("");

      for (const btn of Array.from(el.querySelectorAll(".attach-chip-x"))) {
        (btn as HTMLElement).onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.remove((btn as HTMLElement).dataset.path ?? "");
        };
      }
      for (const thumb of Array.from(el.querySelectorAll(".attach-thumb"))) {
        (thumb as HTMLElement).onclick = (e) => {
          if ((e.target as HTMLElement).closest(".attach-chip-x")) return;
          const p = (thumb as HTMLElement).dataset.path ?? "";
          const a = this.attachments.find((x) => x.path === p);
          if (a) this.openImagePreview(a);
        };
      }
    }
  }
}
