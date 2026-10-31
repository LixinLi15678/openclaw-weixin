// Compile only against a staged new SDK; excluded from the normal old-SDK build.
import type {
  OutboundTextSuffixRuntimeV1 as HostRuntime,
  OutboundTextPreparation as HostPreparation,
  ChannelOutboundContext as HostContext,
} from "openclaw/plugin-sdk/channel-contract";
import type {
  OutboundTextSuffixRuntimeV1 as CompatibleRuntime,
  OutboundTextPreparation as CompatiblePreparation,
  CompatibleWeixinOutboundContext,
} from "../../src/messaging/text-suffix.js";

declare const hostRuntime: HostRuntime;
declare const compatibleRuntime: CompatibleRuntime;
declare const hostPreparation: HostPreparation;
declare const compatiblePreparation: CompatiblePreparation;
declare const hostContext: HostContext;
declare const compatibleContext: CompatibleWeixinOutboundContext;

const fromHost: CompatibleRuntime = hostRuntime;
const toHost: HostRuntime = compatibleRuntime;
const preparationFromHost: CompatiblePreparation = hostPreparation;
const preparationToHost: HostPreparation = compatiblePreparation;
const contextFromHost: CompatibleWeixinOutboundContext = hostContext;
const contextToHost: HostContext = compatibleContext;
void [fromHost, toHost, preparationFromHost, preparationToHost, contextFromHost, contextToHost];
