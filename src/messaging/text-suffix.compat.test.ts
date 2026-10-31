import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { suffixCapability, prepareWeixinText } from "./text-suffix.js";

vi.mock("../util/logger.js", () => ({ logger: { warn: vi.fn() } }));

describe("old-host optional suffix compatibility", () => {
  it("keeps an omitted host capability unavailable and never plans legacy text", async () => {
    // Only the optional structural lookup is exercised; no runtime methods are invoked.
    const channel = {} as PluginRuntime["channel"];
    expect(suffixCapability(channel, false)).toBeUndefined();
    expect(suffixCapability(channel, true)).toBeUndefined();
    await expect(
      prepareWeixinText({
        to: "CasePeer@im.wechat",
        accountId: "fixture-account",
        text: "**hello 🌙**",
      }),
    ).resolves.toBeUndefined();
  });
});
