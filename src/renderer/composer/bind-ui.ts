/**
 * Composer 粘贴图片 / 拖放附件绑定（自 main 迁出）。
 */
import type { HostIpcMethod } from "../../shared/host-api.js";
import { tr } from "../../shared/i18n/index.js";
import {
  MAX_PASTE_IMAGE_BYTES_UI,
  arrayBufferToBase64,
  type ComposerAttachment,
} from "./attachments.js";

type Inv = <T>(
  method: HostIpcMethod,
  params?: unknown,
) => Promise<{
  ok: boolean;
  data?: T;
  error?: { message?: string };
}>;

export type ComposerBindUiDeps = {
  inv: Inv;
  showToast: (text: string, kind?: "info" | "error") => void;
  resolveLocalFilePath: (file: File) => string;
  addAttachments: (
    paths: string[],
    opts?: {
      kind?: ComposerAttachment["kind"];
      previewMap?: Record<string, string>;
    },
  ) => number;
};

export class ComposerBindUi {
  constructor(private readonly deps: ComposerBindUiDeps) {}

  /**
   * 粘贴图片：
   * - 从资源管理器复制的文件可能带 path → 直接附件
   * - 截图 / 网页复制的图片通常只有内存 Blob、无 path → 落盘到 Desktop 临时目录再附件
   */
  bindImagePaste(): void {
    const { deps } = this;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items?.length && !e.clipboardData?.files?.length) return;

      const pathSet = new Set<string>();
      const blobs: File[] = [];
      const blobKeys = new Set<string>();

      const considerFile = (f: File | null) => {
        if (!f || !f.type.startsWith("image/")) return;
        const localPath = deps.resolveLocalFilePath(f);
        if (localPath) {
          pathSet.add(localPath);
          return;
        }
        if (f.size <= 0) return;
        const key = `${f.size}|${f.type}|${f.name || "image"}`;
        if (blobKeys.has(key)) return;
        blobKeys.add(key);
        blobs.push(f);
      };

      let fromItems = 0;
      for (const it of Array.from(items ?? [])) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          considerFile(it.getAsFile());
          fromItems++;
        }
      }
      if (fromItems === 0 && e.clipboardData?.files) {
        for (const f of Array.from(e.clipboardData.files)) {
          considerFile(f);
        }
      }

      if (!pathSet.size && !blobs.length) return;

      e.preventDefault();
      e.stopPropagation();

      void (async () => {
        const paths: string[] = [...pathSet];
        const previewMap: Record<string, string> = {};
        let tooLarge = 0;
        let writeFail = 0;
        for (const blob of blobs) {
          if (blob.size > MAX_PASTE_IMAGE_BYTES_UI) {
            tooLarge++;
            continue;
          }
          try {
            const buf = await blob.arrayBuffer();
            if (buf.byteLength > MAX_PASTE_IMAGE_BYTES_UI) {
              tooLarge++;
              continue;
            }
            const base64 = arrayBufferToBase64(buf);
            const mime = blob.type || "image/png";
            const res = await deps.inv<{ path: string; name: string }>(
              "files.writePasteImage",
              { base64, mime },
            );
            if (res.ok && res.data?.path) {
              if (!paths.includes(res.data.path)) {
                paths.push(res.data.path);
              }
              previewMap[res.data.path] = `data:${mime};base64,${base64}`;
            } else {
              writeFail++;
              deps.showToast(
                res.error?.message ?? tr("attach.pasteFail"),
                "error",
              );
            }
          } catch (err) {
            writeFail++;
            deps.showToast(String(err), "error");
          }
        }
        if (tooLarge > 0) {
          deps.showToast(tr("attach.imageTooLarge", { max: "20" }), "error");
        }
        if (!paths.length) {
          if (!tooLarge && !writeFail) {
            deps.showToast(tr("attach.pasteNone"), "error");
          }
          return;
        }
        const added = deps.addAttachments(paths, {
          kind: "image",
          previewMap,
        });
        if (added > 0) {
          deps.showToast(
            added === 1
              ? tr("attach.pastedOne")
              : tr("attach.pastedN", { n: String(added) }),
          );
        }
      })();
    };

    for (const id of [
      "composer-input",
      "chat-input",
      "focus-input",
      "btw-side-input",
    ] as const) {
      document
        .getElementById(id)
        ?.addEventListener("paste", onPaste as EventListener, true);
    }
  }

  /** 拖放文件/图片到主输入区 */
  bindComposerDrop(): void {
    const { deps } = this;
    const hosts = [
      document.getElementById("welcome"),
      document.getElementById("chat"),
    ].filter(Boolean) as HTMLElement[];

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      (e.currentTarget as HTMLElement).classList.add("is-drag-over");
    };
    const onDragLeave = (e: DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove("is-drag-over");
    };
    const onDrop = (e: DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove("is-drag-over");
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      e.preventDefault();
      e.stopPropagation();

      void (async () => {
        const paths: string[] = [];
        const previewMap: Record<string, string> = {};
        let tooLarge = 0;
        let skippedNoPath = 0;
        for (const f of Array.from(files)) {
          const localPath = deps.resolveLocalFilePath(f);
          if (localPath) {
            if (!paths.includes(localPath)) paths.push(localPath);
            continue;
          }
          if (!f.type.startsWith("image/") || f.size <= 0) {
            skippedNoPath++;
            continue;
          }
          if (f.size > MAX_PASTE_IMAGE_BYTES_UI) {
            tooLarge++;
            continue;
          }
          try {
            const buf = await f.arrayBuffer();
            const base64 = arrayBufferToBase64(buf);
            const mime = f.type || "image/png";
            const res = await deps.inv<{ path: string; name: string }>(
              "files.writePasteImage",
              { base64, mime },
            );
            if (res.ok && res.data?.path) {
              if (!paths.includes(res.data.path)) paths.push(res.data.path);
              previewMap[res.data.path] = `data:${mime};base64,${base64}`;
            } else {
              deps.showToast(
                res.error?.message ?? tr("attach.pasteFail"),
                "error",
              );
            }
          } catch (err) {
            deps.showToast(String(err), "error");
          }
        }
        if (tooLarge > 0) {
          deps.showToast(tr("attach.imageTooLarge", { max: "20" }), "error");
        }
        if (!paths.length) {
          deps.showToast(
            skippedNoPath > 0
              ? tr("attach.dropNoPath")
              : tr("attach.dropNone"),
            "error",
          );
          return;
        }
        const added = deps.addAttachments(paths, {
          previewMap: Object.keys(previewMap).length ? previewMap : undefined,
        });
        if (added > 0) {
          deps.showToast(tr("attach.addedN", { n: String(added) }));
        } else if (skippedNoPath > 0) {
          deps.showToast(
            tr("attach.dropPartialNoPath", { n: String(skippedNoPath) }),
            "info",
          );
        }
      })();
    };

    for (const host of hosts) {
      host.addEventListener("dragover", onDragOver);
      host.addEventListener("dragleave", onDragLeave);
      host.addEventListener("drop", onDrop);
    }
  }
}
