/**
 * S17 本会话 prompt 历史（最新在前）。
 * 纯状态；↑↓ 召回 / 搜索 UI 仍由 main 接线。
 */

export const PROMPT_HISTORY_MAX_DEFAULT = 100;

export class PromptHistoryStore {
  private items: string[] = [];
  /** -1 = 未浏览；0 = 最新一条 */
  private index = -1;
  /** 进入 ↑ 浏览前保存的草稿 */
  private draft = "";

  constructor(private readonly max = PROMPT_HISTORY_MAX_DEFAULT) {}

  list(): readonly string[] {
    return this.items;
  }

  get length(): number {
    return this.items.length;
  }

  get browseIndex(): number {
    return this.index;
  }

  get isBrowsing(): boolean {
    return this.index >= 0;
  }

  resetBrowse(): void {
    this.index = -1;
    this.draft = "";
  }

  clear(): void {
    this.items = [];
    this.resetBrowse();
  }

  /** 记录一条用户发送文案（最新在前；连续重复去重） */
  record(text: string): void {
    const t = text.replace(/\r\n/g, "\n").trim();
    if (!t || t.length < 1) return;
    // 跳过纯 slash 命令
    if (/^\/\S*$/.test(t)) return;
    if (this.items[0] === t) {
      this.resetBrowse();
      return;
    }
    const prev = this.items.indexOf(t);
    if (prev >= 0) this.items.splice(prev, 1);
    this.items.unshift(t);
    if (this.items.length > this.max) {
      this.items.length = this.max;
    }
    this.resetBrowse();
  }

  /** 从磁盘 user 消息填充（打开会话时，texts 通常时间正序；最新在前） */
  seedFromUserTexts(texts: string[]): void {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = (texts[i] ?? "").replace(/\r\n/g, "\n").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= this.max) break;
    }
    this.items = out;
    this.resetBrowse();
  }

  filter(query: string): string[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...this.items];
    const tokens = q.split(/\s+/).filter(Boolean);
    return this.items.filter((line) => {
      const hay = line.toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }

  /**
   * ↑ 浏览：进入浏览或更旧一条。
   * @returns 应写入 composer 的文案；null 表示无可召回
   */
  browseUp(currentComposerValue: string): string | null {
    if (!this.items.length) return null;
    if (this.index < 0) {
      this.draft = currentComposerValue;
      this.index = 0;
    } else if (this.index < this.items.length - 1) {
      this.index += 1;
    }
    return this.items[this.index] ?? "";
  }

  /**
   * ↓ 浏览：更新或退出浏览回到草稿。
   * @returns 应写入 composer 的文案；null 表示未在浏览
   */
  browseDown(): string | null {
    if (this.index < 0) return null;
    if (this.index <= 0) {
      const d = this.draft;
      this.resetBrowse();
      return d;
    }
    this.index -= 1;
    return this.items[this.index] ?? "";
  }
}
