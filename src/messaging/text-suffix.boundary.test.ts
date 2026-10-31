import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import type {
  OutboundTextSuffixRuntimeV1,
  CompatibleWeixinOutboundContext,
} from "./text-suffix.js";

const fixture = vi.hoisted(() => ({
  requests: [] as SendMessageReq[],
  quotePut: vi.fn(),
  sending: vi.fn(),
  payload: { text: "" } as { text: string; mediaUrl?: string },
  failureAt: 0,
  accepted: 0,
  hookOn: true,
  debug: false,
  onAccepted: undefined as (() => void) | undefined,
}));
vi.mock("../util/logger.js", () => {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withAccount: () => logger,
  };
  return { logger };
});
vi.mock("../api/api.js", () => ({
  sendTyping: vi.fn(),
  sendMessage: vi.fn(async ({ body }: { body: SendMessageReq }) => {
    fixture.requests.push(body);
    if (fixture.failureAt === fixture.requests.length)
      throw new Error("synthetic transport rejection");
    const message_id = `accepted-${++fixture.accepted}`;
    fixture.onAccepted?.();
    return { message_id };
  }),
}));
vi.mock("../auth/accounts.js", () => ({
  resolveWeixinAccount: (_cfg: unknown, accountId?: string) => ({
    accountId: accountId ?? "fixture-account",
    configured: true,
    baseUrl: "https://example.invalid",
    cdnBaseUrl: "https://cdn.example.invalid",
  }),
  listWeixinAccountIds: () => ["fixture-account"],
  loadWeixinAccount: () => undefined,
}));
vi.mock("../auth/pairing.js", () => ({ readFrameworkAllowFromList: () => [] }));
vi.mock("../api/session-guard.js", () => ({ assertSessionActive: vi.fn() }));
vi.mock("../cdn/upload.js", () => ({
  uploadFileToWeixin: vi.fn(async () => ({
    filekey: "synthetic-file",
    aeskey: new Uint8Array([1, 2]),
    fileSize: 4,
    fileSizeCiphertext: 16,
    downloadEncryptedQueryParam: "synthetic-cdn",
  })),
  downloadRemoteImageToTemp: vi.fn(async () => "/synthetic/image.png"),
}));
vi.mock("./quote-store.js", () => ({
  getQuoteStore: () => ({ put: fixture.quotePut }),
  getActiveQuoteMediaSubdir: () => "synthetic",
}));
vi.mock("./typing.js", () => ({ loadTypingCallbacksFactory: async () => () => ({}) }));
vi.mock("./debug-mode.js", () => ({ isDebugMode: () => fixture.debug }));
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) => name === "message_sending" && fixture.hookOn,
    runMessageSending: fixture.sending,
  }),
}));

import { createWeixinPlugin } from "../channel.js";
import { processOneMessage } from "./process-message.js";
import { sendImageMessageWeixin, sendMessageItemWeixin, sendMessageWeixin } from "./send.js";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import { downloadRemoteImageToTemp, uploadFileToWeixin } from "../cdn/upload.js";
import * as errorNotice from "./error-notice.js";

const hostRoot = process.env.OPENCLAW_SUFFIX_HOST_ROOT;
const accountId = "fixture-account";
const peer = "CasePeer@im.wechat";
const target = {
  channel: "openclaw-weixin",
  accountId,
  peer: { kind: "direct" as const, id: peer },
};
const config = {
  messages: {
    outboundTextSuffix: { enabled: true, text: "🌙", agentId: "main", targets: [target] },
  },
  channels: { "openclaw-weixin": { replyProgressMessages: false } },
};
let runtime: OutboundTextSuffixRuntimeV1;
let parse: (
  text: string,
  options: { includeStructure: true },
) => { structure?: { type?: string; value?: string; children?: Node[] } };
type Node = { type?: string; value?: string; children?: Node[] };
const textItems = () =>
  fixture.requests
    .flatMap((request) => request.msg?.item_list ?? [])
    .filter((item) => item.type === MessageItemType.TEXT)
    .map((item) => item.text_item?.text ?? "");
const filter = (text: string) => {
  const f = new StreamingMarkdownFilter();
  return f.feed(text) + f.flush();
};
const codeValues = (text: string) => {
  const result: string[] = [];
  const walk = (node?: Node) => {
    if (!node) return;
    if (node.type === "code" || node.type === "inlineCode") result.push(node.value ?? "");
    for (const child of node.children ?? []) walk(child);
  };
  walk(parse(text, { includeStructure: true }).structure);
  return result.join("");
};
const physicalProjection = (text: string) => {
  const values: string[] = [];
  const walk = (node?: Node) => {
    if (!node) return;
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code")
      values.push(node.value ?? "");
    for (const child of node.children ?? []) walk(child);
  };
  walk(parse(text, { includeStructure: true }).structure);
  return values.join("");
};

beforeAll(async () => {
  if (!hostRoot) return;
  // Resolve the real old-SDK receipt dependency before per-case capture/timing begins.
  await import("./send-receipts.js");
  // The acceptance lane explicitly supplies an isolated source checkout. Nothing is loaded
  // from the active installation or configuration, and this path is never production code.
  const source = pathToFileURL(hostRoot.endsWith("/") ? hostRoot : hostRoot + "/");
  runtime = (await import(new URL("src/infra/outbound/text-suffix.ts", source).href))
    .outboundTextSuffixRuntime;
  parse = (await import(new URL("packages/markdown-core/src/reasoning-tag-parser.ts", source).href))
    .parseMarkdownOwnership;
});
beforeEach(() => {
  fixture.requests.length = 0;
  fixture.failureAt = 0;
  fixture.accepted = 0;
  fixture.hookOn = true;
  fixture.debug = false;
  fixture.onAccepted = undefined;
  fixture.quotePut.mockReset();
  fixture.sending.mockReset().mockResolvedValue(undefined);
  vi.mocked(downloadRemoteImageToTemp).mockClear();
  vi.mocked(uploadFileToWeixin).mockClear();
});

type PathKind = "adapter-text" | "adapter-caption" | "dispatch-text" | "dispatch-caption";
type DispatchInfo = {
  kind: "final";
  onPlatformSendDispatch?: () => Promise<void>;
  assertPlatformSendAuthorized?: () => void;
};
async function sendPath(
  kind: PathKind,
  text: string,
  options: {
    cap?: number;
    enabled?: boolean;
    to?: string;
    prepared?: boolean;
    capability?: boolean;
    signal?: AbortSignal;
    onDeliveryResult?: CompatibleWeixinOutboundContext["onDeliveryResult"];
    notice?: "error" | "debug";
    agentId?: string;
    accountId?: string;
    assertCurrent?: () => void;
    onPlatformSendDispatch?: () => Promise<void>;
    runtime?: OutboundTextSuffixRuntimeV1;
    mediaUrl?: string;
  } = {},
) {
  const cfg = {
    ...config,
    messages: {
      outboundTextSuffix: {
        ...config.messages.outboundTextSuffix,
        enabled: options.enabled !== false,
      },
    },
  };
  const to = options.to ?? peer;
  const actualAccount = options.accountId ?? accountId;
  const authorAgentId = options.agentId ?? "main";
  const suffixRuntime = options.runtime ?? runtime;
  const preparation = {
    suffix: suffixRuntime.capture(cfg, { kind: "agent", agentId: authorAgentId }),
    modifiersPrepared: options.prepared === true,
    visibility: "visible" as const,
  };
  const textContext =
    options.capability === false
      ? {}
      : { textPreparation: preparation, outboundTextSuffix: suffixRuntime };
  if (kind.startsWith("adapter")) {
    const outbound = createWeixinPlugin(["outbound-text-suffix-v1"]).outbound;
    const ctx: CompatibleWeixinOutboundContext = {
      cfg,
      to,
      text,
      accountId: actualAccount,
      ...textContext,
      formatting: { textLimit: options.cap ?? 36, chunkMode: "length" },
      signal: options.signal,
      onDeliveryResult: options.onDeliveryResult,
      assertDirectAdapterHandoff: options.assertCurrent,
      onPlatformSendDispatch: options.onPlatformSendDispatch,
    };
    return kind === "adapter-caption"
      ? outbound?.sendMedia?.({ ...ctx, mediaUrl: options.mediaUrl ?? "/synthetic/image.png" })
      : outbound?.sendText?.(ctx);
  }
  fixture.payload = {
    text,
    ...(kind === "dispatch-caption"
      ? { mediaUrl: options.mediaUrl ?? "/synthetic/image.png" }
      : {}),
  };
  let deliver: ((payload: typeof fixture.payload, info: DispatchInfo) => Promise<void>) | undefined;
  let onError: ((error: unknown, info: DispatchInfo) => void) | undefined;
  fixture.debug = options.notice === "debug";
  const channelRuntime = {
    outboundTextSuffix: options.capability === false ? undefined : suffixRuntime,
    text: { resolveTextChunkLimit: () => options.cap ?? 36, resolveChunkMode: () => "length" },
    routing: {
      resolveAgentRoute: () => ({
        agentId: authorAgentId,
        sessionKey: "agent:main:weixin:fixture",
        mainSessionKey: "agent:main:main",
      }),
    },
    commands: { shouldComputeCommandAuthorized: () => false },
    session: { resolveStorePath: () => "/synthetic/session", recordInboundSession: async () => {} },
    reply: {
      finalizeInboundContext: (ctx: unknown) => ctx,
      resolveHumanDelayConfig: () => ({}),
      createReplyDispatcherWithTyping: (params: {
        deliver: typeof deliver;
        onError: typeof onError;
      }) => {
        deliver = params.deliver;
        onError = params.onError;
        return { dispatcher: {}, replyOptions: {}, markDispatchIdle: () => {} };
      },
      withReplyDispatcher: async (params: { run: () => Promise<void> }) => params.run(),
      dispatchReplyFromConfig: async () => {
        const info: DispatchInfo = {
          kind: "final",
          onPlatformSendDispatch: options.onPlatformSendDispatch,
          assertPlatformSendAuthorized: options.assertCurrent,
        };
        if (options.notice === "error") {
          onError?.(new Error("synthetic failure"), info);
          return;
        }
        try {
          await deliver?.(fixture.payload, info);
        } catch (error) {
          onError?.(error, info);
          throw error;
        }
      },
    },
    media: {},
  };
  await processOneMessage(
    {
      from_user_id: to,
      to_user_id: "synthetic-bot",
      context_token: "synthetic-context",
      item_list: [{ type: MessageItemType.TEXT, text_item: { text: "hello" } }],
    },
    {
      accountId: actualAccount,
      config: cfg,
      channelRuntime: channelRuntime as unknown as PluginRuntime["channel"],
      suffixHostReady: true,
      baseUrl: "https://example.invalid",
      cdnBaseUrl: "https://cdn.example.invalid",
      log: () => {},
      errLog: () => {},
      signal: options.signal,
    },
  );
}

// This suite deliberately runs only in the documented old/new-host fixture matrix; ordinary
// old-host unit runs cannot substitute a copied suffix implementation for the real host owner.
describe.runIf(Boolean(hostRoot))("four physical Weixin text/caption boundaries", () => {
  it("finalizes the routed publishing author's error notice", async () => {
    const sendNotice = vi.spyOn(errorNotice, "sendWeixinErrorNotice");
    try {
      await sendPath("dispatch-text", "unused", { cap: 4_000, notice: "error" });
      expect(sendNotice).toHaveBeenCalledTimes(1);
      await sendNotice.mock.results[0]?.value;
      expect(textItems()).toEqual(["⚠️ 消息发送失败：synthetic failure 🌙"]);
    } finally {
      sendNotice.mockRestore();
    }
  });
  it("finalizes the routed publishing author's debug timing notice", async () => {
    await sendPath("dispatch-text", "hello", { cap: 4_000, notice: "debug" });
    expect(textItems()[0]).toBe("hello 🌙");
    expect(textItems()).toHaveLength(2);
    expect(textItems()[1]).toMatch(/^⏱ Debug 全链路\n/u);
    expect(textItems()[1]?.endsWith("🌙")).toBe(true);
  });

  const paths: PathKind[] = [
    "adapter-text",
    "adapter-caption",
    "dispatch-text",
    "dispatch-caption",
  ];
  for (const kind of paths) {
    describe(kind, () => {
      it.each([
        ["closed LF", "```js\na🌙\n```", "```js\na🌙\n```\n🌙"],
        ["open LF", "```js\na🌙", "```js\na🌙\n```\n🌙"],
        ["closed CRLF", "```js\r\na🌙\r\n```", "```js\r\na🌙\r\n```\n🌙"],
        ["open CRLF", "```js\r\na🌙", "```js\r\na🌙\r\n```\n🌙"],
        ["closed CR", "```js\ra🌙\r```", "```js\ra🌙\r```\n🌙"],
        ["open CR", "```js\ra🌙", "```js\ra🌙\r```\n🌙"],
      ])("preserves the %s fence and external signature", async (_name, text, expected) => {
        await sendPath(kind, text, { cap: 4_000 });
        expect(textItems()).toEqual([expected]);
        expect(codeValues(textItems()[0] ?? "")).toBe("a🌙");
      });
      it("rechecks live authority after awaited planning before any media or send I/O", async () => {
        let current = true;
        const deferredRuntime: OutboundTextSuffixRuntimeV1 = {
          ...runtime,
          async planPreservedMarkdownText(params) {
            const units = await runtime.planPreservedMarkdownText(params);
            current = false;
            return units;
          },
        };
        await expect(
          sendPath(kind, "hello", {
            runtime: deferredRuntime,
            mediaUrl: "https://example.invalid/synthetic.png",
            assertCurrent: () => {
              if (!current) {
                throw Object.assign(new Error("fixture dispatch authority closed"), {
                  code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
                });
              }
            },
          }),
        ).rejects.toThrow("fixture dispatch authority closed");
        expect(downloadRemoteImageToTemp).not.toHaveBeenCalled();
        expect(uploadFileToWeixin).not.toHaveBeenCalled();
        expect(fixture.requests).toEqual([]);
      });
      it("retains the first acceptance and rechecks existing dispatch authority per physical request", async () => {
        let current = true;
        fixture.onAccepted = () => {
          current = false;
        };
        await expect(
          sendPath(kind, kind.endsWith("caption") ? "hello" : "hello world", {
            cap: 8,
            onPlatformSendDispatch: async () => {
              await Promise.resolve();
            },
            assertCurrent: () => {
              if (!current) {
                throw new Error("fixture dispatch authority closed");
              }
            },
          }),
        ).rejects.toMatchObject({
          code: "CHANNEL_PARTIAL_DELIVERY",
          deliveryResult: { messageIds: ["accepted-1"] },
        });
        expect(textItems()).toEqual(["hello 🌙"]);
        expect(fixture.requests).toHaveLength(1);
      });
      it.each([
        ["hello", "hello 🌙"],
        ["**hello 🌙**", "**hello** 🌙"],
        ["***hello 🌙️🌙︎***", "***hello*** 🌙"],
        ["~~hello 🌙~~", "~~hello~~ 🌙"],
        ["`data🌙`", "`data🌙` 🌙"],
        ["```js\ndata🌙\n```", "```js\ndata🌙\n```\n🌙"],
        ["```js\ndata🌙", "```js\ndata🌙\n```\n🌙"],
      ])("captures independent expected wire text for %s", async (text, expected) => {
        await sendPath(kind, text, { cap: 100 });
        expect(textItems()).toEqual([expected]);
        expect(fixture.sending).toHaveBeenCalledTimes(1);
        expect(fixture.requests.every((request) => request.msg?.item_list?.length === 1)).toBe(
          true,
        );
        if (kind.endsWith("caption"))
          expect(fixture.requests.at(-1)?.msg?.item_list?.[0]?.type).toBe(MessageItemType.IMAGE);
        expect(
          fixture.quotePut.mock.calls.some(
            ([entry]) => entry.direction === "outbound" && entry.body === expected,
          ),
        ).toBe(true);
      });
      it.each([
        "**" + "abc🌙 xyz ".repeat(12).trim() + "**",
        "***" + "abc def ".repeat(10).trim() + "***",
        "~~" + "abc def ".repeat(10).trim() + "~~",
        "```js\n" + "code🌙 `  ".repeat(12) + "\n```",
        "`` " + "x`🌙 y ".repeat(12) + " ``",
      ])("budgets closures/reopens and preserves original data: %s", async (text) => {
        await sendPath(kind, text);
        const captured = textItems();
        expect(captured.length).toBeGreaterThan(1);
        const filtered = kind === "adapter-caption" ? text : filter(text);
        for (const unit of captured) {
          expect(unit.length).toBeLessThanOrEqual(36);
          expect(unit.endsWith("🌙")).toBe(true);
          const final = parse(unit, { includeStructure: true })
            .structure?.children?.at(-1)
            ?.children?.at(-1);
          expect(final?.type).toBe("text");
          expect(final?.value?.endsWith("🌙")).toBe(true);
          expect(unit.replace(/\s*🌙$/u, "").trim()).not.toBe("");
        }
        if (codeValues(filtered))
          expect(captured.map(codeValues).join("")).toBe(codeValues(filtered));
        else
          expect(
            captured
              .map((unit) => physicalProjection(unit.slice(0, -3)))
              .join("")
              .replace(/\s/gu, ""),
          ).toBe(physicalProjection(filtered).replace(/\s/gu, ""));
      });
      it("parses actual post-hook syntax once and preserves cancellation/fail-open hooks", async () => {
        fixture.sending.mockResolvedValueOnce({ content: "**hook 🌙🌙️**" });
        await sendPath(kind, "original");
        expect(textItems()).toEqual(["**hook** 🌙"]);
        fixture.requests.length = 0;
        fixture.sending.mockResolvedValueOnce({ cancel: true });
        await sendPath(kind, "original");
        expect(fixture.requests).toEqual([]);
        fixture.sending.mockRejectedValueOnce(new Error("synthetic hook failure"));
        await sendPath(kind, "original");
        expect(textItems()).toEqual(["original 🌙"]);
      });
      it("keeps disabled, unmatched and missing-capability physical content equivalent", async () => {
        const text = "**hello 🌙**";
        for (const options of [
          { enabled: false },
          { to: "casepeer@im.wechat" },
          { capability: false },
          { agentId: "other" },
          { accountId: "other-fixture-account" },
        ]) {
          fixture.requests.length = 0;
          await sendPath(kind, text, options);
          expect(textItems()).toEqual([kind === "adapter-caption" ? text : filter(text)]);
        }
      });
      it("keeps blank bodies absent and normalizes an intentional signature-only body", async () => {
        await sendPath(kind, " \n\t");
        expect(textItems()).toEqual([]);
        fixture.requests.length = 0;
        await sendPath(kind, "🌙︎ 🌙️");
        expect(textItems()).toEqual(["🌙"]);
      });
      it.each([
        ["****", "****\n\n🌙"],
        [
          "[label][id]\n\n[id]: https://example.invalid",
          "[label][id]\n\n[id]: https://example.invalid\n\n🌙",
        ],
      ])("keeps the signature outside fitting block source: %s", async (text, expected) => {
        await sendPath(kind, text, { cap: 4_000 });
        expect(textItems()).toEqual([expected]);
        const last = parse(textItems()[0] ?? "", {
          includeStructure: true,
        }).structure?.children?.at(-1);
        expect(last?.type).toBe("paragraph");
        expect(last?.children?.at(-1)?.value).toBe("🌙");
      });
      it("handles exact/over caps, interior moons, and rejects indivisible input before dispatch", async () => {
        await sendPath(kind, "a".repeat(33), { cap: 36 });
        expect(textItems()).toEqual(["a".repeat(33) + " 🌙"]);
        fixture.requests.length = 0;
        await sendPath(kind, "a".repeat(34), { cap: 36 });
        expect(textItems().length).toBe(2);
        fixture.requests.length = 0;
        await sendPath(kind, "body🌙 NEXT", { cap: 10 });
        expect(textItems()).toEqual(["body🌙 🌙", " NEXT 🌙"]);
        fixture.requests.length = 0;
        await expect(
          sendPath(kind, "[x](https://example.invalid/" + "x".repeat(100) + ")", { cap: 20 }),
        ).rejects.toThrow();
        expect(fixture.requests).toEqual([]);
      });
    });
  }
  it("preserves unclassified standalone controls and treats admitted structured text literally", async () => {
    const preparation = {
      suffix: runtime.capture(config, { kind: "agent", agentId: "main" }),
      modifiersPrepared: false,
    };
    for (const marker of ["NO_REPLY", "HEARTBEAT_OK"]) {
      fixture.requests.length = 0;
      await sendMessageWeixin({
        to: peer,
        text: marker,
        opts: {
          baseUrl: "https://example.invalid",
          accountId,
          textPreparation: preparation,
          outboundTextSuffix: runtime,
        },
      });
      expect(textItems()).toEqual([marker]);
    }
    fixture.requests.length = 0;
    await sendMessageWeixin({
      to: peer,
      text: "NO_REPLY",
      opts: {
        baseUrl: "https://example.invalid",
        accountId,
        textPreparation: { ...preparation, visibility: "visible" },
        outboundTextSuffix: runtime,
      },
    });
    // Literal delimiter-bearing source receives the planner's protective paragraph boundary.
    expect(textItems()).toEqual(["NO_REPLY\n\n🌙"]);
  });
  it("skips only the matched host-prepared adapter's duplicate mutable hook", async () => {
    await sendPath("adapter-text", "**hello 🌙**", { prepared: true });
    expect(fixture.sending).not.toHaveBeenCalled();
    expect(textItems()).toEqual(["**hello** 🌙"]);
    await sendPath("adapter-text", "hello", { prepared: true, to: "other@im.wechat" });
    expect(fixture.sending).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "retains accepted captions after media failure (observer=%s)",
    async (observer) => {
      fixture.failureAt = 2;
      const onDeliveryResult = observer ? vi.fn() : undefined;
      await expect(
        sendPath("adapter-caption", "caption", { onDeliveryResult }),
      ).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: { visibleReplySent: true, messageIds: ["accepted-1"] },
      });
      expect(textItems()).toEqual(["caption 🌙"]);
      if (onDeliveryResult) expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    },
  );
  it("retains acceptance on observer failure and checks live cancellation before the next request", async () => {
    const controller = new AbortController();
    await expect(
      sendPath("adapter-text", "abc def ".repeat(10), {
        onDeliveryResult: () => {
          throw new Error("observer failed");
        },
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { messageIds: ["accepted-1"] },
    });
    expect(fixture.requests.length).toBe(1);
    fixture.requests.length = 0;
    fixture.accepted = 0;
    await expect(
      sendPath("adapter-text", "abc def ".repeat(10), {
        signal: controller.signal,
        onDeliveryResult: () => controller.abort(),
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { messageIds: ["accepted-1"] },
    });
    expect(fixture.requests.length).toBe(1);
  });
  it("keeps structured non-TEXT tool items unchanged and never creates media-only captions", async () => {
    const ctx = {
      textPreparation: {
        suffix: runtime.capture(config, { kind: "agent", agentId: "main" }),
        modifiersPrepared: true,
      },
      outboundTextSuffix: runtime,
    };
    const item: MessageItem = {
      type: MessageItemType.TOOL_CALL_RESULT,
      tool_call_result_item: { tool_call_id: "synthetic-tool", status: "literal 🌙" },
    };
    await sendMessageItemWeixin({
      to: peer,
      item,
      opts: { baseUrl: "https://example.invalid", accountId, ...ctx },
    });
    expect(fixture.requests[0]?.msg?.item_list).toEqual([item]);
    fixture.requests.length = 0;
    await sendImageMessageWeixin({
      to: peer,
      text: "",
      uploaded: {
        filekey: "fake",
        aeskey: new Uint8Array(),
        fileSize: 0,
        fileSizeCiphertext: 0,
        downloadEncryptedQueryParam: "fake",
      },
      opts: { baseUrl: "https://example.invalid", accountId, ...ctx },
    });
    expect(textItems()).toEqual([]);
  });
});
