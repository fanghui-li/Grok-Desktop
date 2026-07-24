import { describe, expect, it } from "vitest";
import { enrichAcpErrorMessage } from "../src/shared/enrich-acp-error.js";
import {
  displayProviderErrorBody,
  formatFriendlyErrorLabelTitle,
  matchFriendlyError,
  matchFriendlyErrorTitleKey,
} from "../src/shared/friendly-error-title.js";

const tEn = (key: string) => {
  const map: Record<string, string> = {
    "err.domain.upstream": "Upstream",
    "err.domain.config": "Account & config",
    "err.domain.local": "Local session",
    "err.domain.app": "App",
    "err.rateLimited": "Too many requests",
    "err.providerUnavailable": "Provider temporarily unavailable",
    "err.modelNotFound": "Model unavailable",
    "err.sessionDisconnected": "Session disconnected",
    "err.internal": "Internal error",
    "err.apiKeyInvalid": "Invalid API key",
  };
  return map[key] ?? key;
};

describe("enrichAcpErrorMessage", () => {
  it("surfaces CLI btw plain-string error.data (429 rate limit)", () => {
    const data =
      "side question model call failed: API error (status 429 Too Many Requests): rate_limit_error: Upstream rate limit exceeded, please retry later\n\nRequest URL: https://example.com/v1/chat/completions";
    const rich = enrichAcpErrorMessage("Internal error", data);
    expect(rich).toContain("429");
    expect(rich).toContain("rate_limit");
    expect(rich).not.toMatch(/^Internal error$/i);
    expect(matchFriendlyErrorTitleKey(rich)).toBe("err.rateLimited");
  });

  it("keeps nested JSON message when data is object shell", () => {
    const rich = enrichAcpErrorMessage("Internal error", {
      message: "model not found: foo",
    });
    expect(rich).toContain("model not found");
  });

  it("unwraps Host details { code, message, data: string }", () => {
    const rich = enrichAcpErrorMessage("Internal error", {
      code: -32603,
      message: "Internal error",
      data: "side question model call failed: API error (status 429 Too Many Requests): rate_limit_error",
    });
    expect(rich).toContain("429");
    expect(matchFriendlyErrorTitleKey(rich)).toBe("err.rateLimited");
  });

  it("does not invent detail when data empty", () => {
    expect(enrichAcpErrorMessage("Internal error", undefined)).toBe(
      "Internal error",
    );
  });
});

describe("matchFriendlyError domain + label·raw for provider", () => {
  it("maps rate_limit to upstream and keeps original body in label", () => {
    const raw =
      "API error (status 429): rate_limit_error: Upstream rate limit exceeded";
    const m = matchFriendlyError(raw);
    expect(m?.domain).toBe("upstream");
    expect(m?.titleKey).toBe("err.rateLimited");
    expect(formatFriendlyErrorLabelTitle(raw, tEn)).toBe(
      `Upstream · ${displayProviderErrorBody(raw)}`,
    );
    expect(formatFriendlyErrorLabelTitle(raw, tEn)).toContain("429");
    expect(formatFriendlyErrorLabelTitle(raw, tEn)).not.toContain(
      "Too many requests",
    );
  });

  it("maps 424 No healthy Grok OAuth to upstream · raw", () => {
    const raw =
      "API error (status 424 Failed Dependency): upstream_error: No healthy Grok OAuth account is currently available\n\nRequest URL: https://newapi.example.com/v1/chat/completions";
    const m = matchFriendlyError(raw);
    expect(m?.domain).toBe("upstream");
    expect(m?.titleKey).toBe("err.providerUnavailable");
    const labeled = formatFriendlyErrorLabelTitle(raw, tEn)!;
    expect(labeled.startsWith("Upstream · ")).toBe(true);
    expect(labeled).toContain("424");
    expect(labeled).toContain("No healthy Grok OAuth");
    expect(labeled).toContain("newapi.example.com");
    expect(labeled).not.toContain("Provider temporarily unavailable");
  });

  it("maps no available channel to upstream · raw", () => {
    const raw =
      "new_api_error: No available channel for model grok-build under group default";
    const m = matchFriendlyError(raw);
    expect(m?.domain).toBe("upstream");
    expect(m?.titleKey).toBe("err.providerUnavailable");
    expect(formatFriendlyErrorLabelTitle(raw, tEn)).toContain(
      "No available channel",
    );
  });

  it("maps invalid api key to config · raw", () => {
    const m = matchFriendlyError("invalid_api_key");
    expect(m?.domain).toBe("config");
    expect(m?.titleKey).toBe("err.apiKeyInvalid");
    expect(formatFriendlyErrorLabelTitle("invalid_api_key", tEn)).toBe(
      "Account & config · invalid_api_key",
    );
  });

  it("maps agent crash to local · short title", () => {
    const m = matchFriendlyError("Agent process error: spawn ENOENT");
    expect(m?.domain).toBe("local");
    expect(m?.titleKey).toBe("err.sessionDisconnected");
    expect(
      formatFriendlyErrorLabelTitle("Agent process error: spawn ENOENT", tEn),
    ).toBe("Local session · Session disconnected");
  });

  it("maps bare Internal error to app · short title", () => {
    const m = matchFriendlyError("Internal error");
    expect(m?.domain).toBe("app");
    expect(m?.titleKey).toBe("err.internal");
    expect(formatFriendlyErrorLabelTitle("Internal error", tEn)).toBe(
      "App · Internal error",
    );
  });

  it("strips side-question prefix from provider body", () => {
    const raw =
      "side question model call failed: API error (status 429 Too Many Requests): rate_limit_error";
    const labeled = formatFriendlyErrorLabelTitle(raw, tEn)!;
    expect(labeled).toMatch(/^Upstream · /);
    expect(labeled).not.toMatch(/side question/i);
    expect(labeled).toContain("429");
  });
});
