import { describe, expect, it, vi } from "vitest";
import { fetchTrustedClientMetadata, getCimdPlugin, isAllowedMetadataUrl } from "./cimd";

describe("CIMD network boundary", () => {
  it("isolates cached discovery persistence by database and issuer", () => {
    const first = {} as D1Database;
    const second = {} as D1Database;
    const plugin = getCimdPlugin(first, "https://first.test");
    expect(getCimdPlugin(first, "https://first.test")).toBe(plugin);
    expect(getCimdPlugin(second, "https://first.test")).not.toBe(plugin);
    expect(getCimdPlugin(first, "https://second.test")).not.toBe(plugin);
  });
  it("rejects attacker-controlled, private, encoded and credential-bearing URLs before fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      for (const url of [
        "http://chatgpt.com/oauth/client.json",
        "https://127.0.0.1/oauth/client.json",
        "https://chatgpt.com.evil.test/oauth/client.json",
        "https://user:pass@chatgpt.com/oauth/client.json",
        "https://chatgpt.com/oauth/client.json?next=https://evil.test",
        "https://chatgpt.com/oauth/client.json#x",
        "https://chatgpt.com/redirect",
        "https://[::1]/oauth/client.json",
      ]) {
        expect(isAllowedMetadataUrl(url)).toBe(false);
        await expect(fetchTrustedClientMetadata(url)).rejects.toThrow();
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
  it("only sends safe conditional headers and refuses redirects", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    try {
      await fetchTrustedClientMetadata("https://chatgpt.com/oauth/codex/example/client.json", {
        headers: { Authorization: "Bearer test-only", Cookie: "test-only", "If-None-Match": "v1" },
      });
      const init = spy.mock.calls[0]?.[1];
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      expect(headers.get("if-none-match")).toBe("v1");
      spy.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
      );
      await expect(
        fetchTrustedClientMetadata("https://chatgpt.com/oauth/client.json"),
      ).rejects.toThrow("redirects");
    } finally {
      spy.mockRestore();
    }
  });
});
