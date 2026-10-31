import type { WeixinTextContext } from "./text-suffix.js";
import { logger } from "../util/logger.js";
import { sendMessageWeixin } from "./send.js";
import type { WeixinMessageSendOptions } from "./send.js";

/**
 * Send a plain-text error notice back to the user.
 * Fire-and-forget: errors are logged but never thrown, so callers stay unaffected.
 * No-op when contextToken is absent (we have no conversation reference to reply into).
 */
export async function sendWeixinErrorNotice(
  params: WeixinTextContext &
    Pick<WeixinMessageSendOptions, "onPlatformSendDispatch" | "assertDirectAdapterHandoff"> & {
      signal?: AbortSignal;
      to: string;
      contextToken: string | undefined;
      message: string;
      baseUrl: string;
      token?: string;
      runId?: string;
      accountId?: string;
      errLog: (m: string) => void;
    },
): Promise<void> {
  if (!params.contextToken) {
    logger.warn(
      `sendWeixinErrorNotice: no contextToken for to=${params.to}, sending without context`,
    );
  }
  try {
    await sendMessageWeixin({
      to: params.to,
      text: params.message,
      opts: {
        textPreparation: params.textPreparation,
        outboundTextSuffix: params.outboundTextSuffix,
        formatting: params.formatting,
        signal: params.signal,
        onPlatformSendDispatch: params.onPlatformSendDispatch,
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        baseUrl: params.baseUrl,
        token: params.token,
        contextToken: params.contextToken,
        accountId: params.accountId,
        ...(params.runId ? { runId: params.runId } : {}),
      },
    });
    logger.debug(`sendWeixinErrorNotice: sent to=${params.to}`);
  } catch (err) {
    params.errLog(`[weixin] sendWeixinErrorNotice failed to=${params.to}: ${String(err)}`);
  }
}
