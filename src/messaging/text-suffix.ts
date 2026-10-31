import { logger } from "../util/logger.js";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";

// Local structural view of the documented optional V1 addition. No new-SDK import is
// required during the plugin's shipped old-host compatibility window.
export type DirectTextRoute = Readonly<{
  channel: string;
  accountId: string;
  peer: Readonly<{ kind: "direct"; id: string }>;
}>;
export type CapturedTextSuffix =
  | Readonly<{ version: 1; decision: "none" }>
  | Readonly<{
      version: 1;
      decision: "scoped";
      authorAgentId: string;
      text: string;
      targets: readonly DirectTextRoute[];
      algorithm: "literal-suffix-v1";
      plannerVersion: 1;
    }>;
export type OutboundTextPreparation = Readonly<{
  suffix: CapturedTextSuffix;
  modifiersPrepared: boolean;
  visibility?: "visible";
}>;
export type BoundTextSuffix = Readonly<{
  text: string;
  algorithm: "literal-suffix-v1";
  utf16Units: number;
  utf8Bytes: number;
}>;
export type FinalizedVisibleText = Readonly<{
  state: "finalized";
  text: string;
  suffixText: string;
  algorithm: "literal-suffix-v1";
}>;
export type OutboundTextSuffixRuntimeV1 = Readonly<{
  version: 1;
  capture: (
    cfg: OpenClawConfig,
    author?: { kind: "agent"; agentId: string } | { kind: "system" },
  ) => CapturedTextSuffix;
  bind: (
    snapshot: CapturedTextSuffix | undefined,
    route?: DirectTextRoute,
  ) => BoundTextSuffix | undefined;
  normalizeTerminalSignature: (
    tail: string,
    suffix: BoundTextSuffix,
  ) => Readonly<{ keepEnd: number; hadSignature: boolean }>;
  finalize: (
    unit:
      | Readonly<{ state: "body"; text: string; separator: "space" | "newline" | "blank-line" }>
      | Readonly<{ state: "signature-only" }>
      | FinalizedVisibleText,
    suffix: BoundTextSuffix,
  ) => FinalizedVisibleText;
  planPreservedMarkdownText: (params: {
    text: string;
    boundSuffix: BoundTextSuffix;
    effectiveLimit: number;
    chunkMode: "length" | "newline";
    planner: "source-markdown-v1";
  }) => Promise<readonly FinalizedVisibleText[]>;
}>;
export type WeixinTextContext = {
  textPreparation?: OutboundTextPreparation;
  outboundTextSuffix?: OutboundTextSuffixRuntimeV1;
  formatting?: { textLimit?: number; chunkMode?: "length" | "newline" };
  textFormatting?: { textLimit?: number; chunkMode?: "length" | "newline" };
};
/** Optional existing dispatcher fences, supplied by their host owner rather than V1 policy. */
export type WeixinReplyDeliveryAuthority = {
  onPlatformSendDispatch?: () => Promise<void>;
  assertPlatformSendAuthorized?: () => void;
};
export type CompatibleWeixinOutboundContext = ChannelOutboundContext &
  WeixinTextContext & {
    signal?: AbortSignal;
    assertDirectAdapterHandoff?: () => void;
    onPlatformSendDispatch?: () => Promise<void>;
  };

export function suffixCapability(runtime: PluginRuntime["channel"], hostReady: boolean) {
  const compatible: PluginRuntime["channel"] & {
    outboundTextSuffix?: OutboundTextSuffixRuntimeV1;
  } = runtime;
  const capability = hostReady ? validSuffixCapability(compatible.outboundTextSuffix) : undefined;
  if (hostReady && !capability) {
    logger.warn("outbound-text-suffix: capability_unavailable");
  }
  return capability;
}
export function validSuffixCapability(runtime: OutboundTextSuffixRuntimeV1 | undefined) {
  return runtime?.version === 1 &&
    typeof runtime.capture === "function" &&
    typeof runtime.bind === "function" &&
    typeof runtime.normalizeTerminalSignature === "function" &&
    typeof runtime.finalize === "function" &&
    typeof runtime.planPreservedMarkdownText === "function"
    ? runtime
    : undefined;
}
export function bindWeixinTextSuffix(context: WeixinTextContext, to: string, accountId?: string) {
  const runtime = validSuffixCapability(context.outboundTextSuffix);
  // The declared direct-only protocol plus exact peer syntax establishes this route kind.
  if (!runtime) return undefined;
  if (!accountId || !/^[^\s@]+@im\.wechat$/u.test(to))
    return runtime.bind(context.textPreparation?.suffix);
  return runtime.bind(context.textPreparation?.suffix, {
    channel: "openclaw-weixin",
    accountId,
    peer: { kind: "direct", id: to },
  });
}
export type PreparedWeixinText = Readonly<{
  to: string;
  accountId?: string;
  texts: readonly string[];
}>;

export async function prepareWeixinText(
  params: WeixinTextContext & {
    to: string;
    text: string;
    accountId?: string;
  },
): Promise<PreparedWeixinText | undefined> {
  const suffix = bindWeixinTextSuffix(params, params.to, params.accountId);
  const runtime = validSuffixCapability(params.outboundTextSuffix);
  if (
    !suffix ||
    !runtime ||
    (params.textPreparation?.visibility !== "visible" &&
      /^(?:NO_REPLY|HEARTBEAT_OK)$/u.test(params.text.trim()))
  )
    return undefined;
  const formatting = params.textFormatting ?? params.formatting;
  const requested = formatting?.textLimit;
  const effectiveLimit = Math.min(
    requested && requested > 0 ? Math.floor(requested) : 4_000,
    4_000,
  );
  const units = await runtime.planPreservedMarkdownText({
    text: params.text,
    boundSuffix: suffix,
    effectiveLimit,
    chunkMode: formatting?.chunkMode ?? "length",
    planner: "source-markdown-v1",
  });
  if (units.some((unit) => !unit.text.trim() || unit.text.length > effectiveLimit)) {
    throw new Error("Invalid V1 outbound text plan: local text limit exceeded");
  }
  return Object.freeze({
    to: params.to,
    accountId: params.accountId,
    texts: Object.freeze(units.map((unit) => unit.text)),
  });
}
