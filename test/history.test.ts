import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanUserText,
  extractText,
  loadChatHistory,
  mapHistoryLine,
  readHistoryText,
} from "../src/host/history.js";

describe("chat history parsing (UI transcript)", () => {
  it("extractText never returns [object Object] for content arrays", () => {
    expect(
      extractText([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello\nworld");
    expect(extractText({ foo: 1 })).toBe("");
    expect(extractText("plain")).toBe("plain");
  });

  it("pending tool_call without result is incomplete not done", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-hist-inc-"));
    const cwdEnc = encodeURIComponent("D:\\tmp\\inc");
    const sessionId = "sess_tool_inc";
    const dir = path.join(home, ".grok-desktop", "sessions", cwdEnc, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "chat_history.jsonl"),
      [
        JSON.stringify({
          type: "user",
          content: [{ type: "text", text: "<user_query>\nhi\n</user_query>" }],
        }),
        JSON.stringify({
          type: "assistant",
          content: "",
          tool_calls: [{ id: "tc1", name: "read_file" }],
        }),
        // no tool_result
      ].join("\n"),
      "utf8",
    );
    const page = loadChatHistory(sessionId, home);
    const tools = page.entries.filter((e) => e.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolStatus).toBe("incomplete");
    expect(tools[0]?.toolName).toBe("read_file");
  });

  it("skips system / synthetic; maps reasoning to thought; tool_result alone is tool", () => {
    expect(
      mapHistoryLine({
        type: "system",
        content: "You are Grok 4.5 released by xAI...",
      }),
    ).toBeNull();
    // S15：reasoning 并入时间线
    expect(
      mapHistoryLine({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "thinking" }],
      }),
    ).toEqual({ role: "thought", text: "thinking" });
    // 无 pending tool_call 时仍落一条 tool（有输出）
    expect(
      mapHistoryLine({
        type: "tool_result",
        content: "- D:\\spiderMonkey\\test/\n",
      }),
    ).toMatchObject({ role: "tool" });
    expect(
      mapHistoryLine({
        type: "user",
        content: [{ type: "text", text: "<system-reminder>skills...</system-reminder>" }],
        synthetic_reason: "system_reminder",
      }),
    ).toBeNull();
  });

  it("maps user_query to clean user text and assistant content", () => {
    const u = mapHistoryLine({
      type: "user",
      content: [{ type: "text", text: "<user_query>\n你说？\n</user_query>" }],
      prompt_index: 0,
    });
    expect(u).toEqual({ role: "user", text: "你说？" });

    const a = mapHistoryLine({
      type: "assistant",
      content: "你好，工作区是空的。",
    });
    expect(a).toEqual({ role: "assistant", text: "你好，工作区是空的。" });
  });

  it("cleanUserText extracts user_query body", () => {
    expect(cleanUserText("<user_query>\nhello\n</user_query>")).toBe("hello");
  });

  it("loadChatHistory from real-shaped chat_history.jsonl", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-hist-"));
    const cwdEnc = encodeURIComponent("D:\\spiderMonkey\\test");
    const sessionId = "sess_hist_demo";
    const dir = path.join(home, ".grok-desktop", "sessions", cwdEnc, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "system",
        content: "You are Grok 4.5... huge prompt",
      }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_info>\nOS...\n</user_info>" }],
        synthetic_reason: "project_instructions",
      }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_query>\n你说？\n</user_query>" }],
        prompt_index: 0,
      }),
      JSON.stringify({
        type: "assistant",
        content: "看起来像是在接上一段对话。",
        tool_calls: [{ id: "1", name: "list_dir" }],
      }),
      JSON.stringify({
        type: "tool_result",
        tool_call_id: "1",
        content: "[object Object]",
      }),
      JSON.stringify({
        type: "assistant",
        content: "你好。当前工作区是空的。",
      }),
    ];
    fs.writeFileSync(path.join(dir, "chat_history.jsonl"), lines.join("\n"), "utf8");

    const page = loadChatHistory(sessionId, home);
    // S15：user → assistant → tool → assistant
    expect(page.entries.map((e) => e.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(page.entries[0].text).toBe("你说？");
    expect(page.entries[1].text).toContain("接上一段对话");
    expect(page.entries[2].toolName).toBe("list_dir");
    expect(page.entries[3].text).toContain("工作区是空的");
    // Must not dump system prompt
    expect(page.entries.every((e) => !e.text.includes("You are Grok 4.5"))).toBe(
      true,
    );
    expect(page.entries.every((e) => !e.text.includes("[object Object]"))).toBe(
      true,
    );
  });

  it("loadChatHistory respects maxEntries and marks truncated", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-hist-cap-"));
    const cwdEnc = encodeURIComponent("D:\\tmp\\cap");
    const sessionId = "sess_hist_cap";
    const dir = path.join(home, ".grok-desktop", "sessions", cwdEnc, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          content: [{ type: "text", text: `<user_query>\nmsg-${i}\n</user_query>` }],
        }),
      );
      lines.push(
        JSON.stringify({
          type: "assistant",
          content: `reply-${i}`,
        }),
      );
    }
    fs.writeFileSync(path.join(dir, "chat_history.jsonl"), lines.join("\n"), "utf8");
    const page = loadChatHistory(sessionId, home, { maxEntries: 10 });
    expect(page.entries.length).toBe(10);
    expect(page.truncated).toBe(true);
    // 保留较新部分
    expect(page.entries[page.entries.length - 1]?.text).toContain("reply-19");
  });

  it("readHistoryText truncates large files from the end", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-hist-bytes-"));
    const file = path.join(home, "big.jsonl");
    const pad = "x".repeat(2000);
    const lines = [
      JSON.stringify({ type: "user", content: `old-${pad}` }),
      JSON.stringify({ type: "user", content: "tail-line-only" }),
    ];
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    const r = readHistoryText(file, 800);
    expect(r.truncatedBytes).toBe(true);
    expect(r.text).toContain("tail-line-only");
  });
});
