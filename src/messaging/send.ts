import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import {
  prepareWeixinText,
  type PreparedWeixinText,
  type WeixinTextContext,
} from "./text-suffix.js";

import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";
import { getMediaLabel } from "./inbound.js";
import { getQuoteStore } from "./quote-store.js";

export { StreamingMarkdownFilter } from "./markdown-filter.js";

export type WeixinMessageSendOptions = WeixinApiOptions &
  WeixinTextContext & {
    preparedText?: PreparedWeixinText;
    signal?: AbortSignal;
    assertDirectAdapterHandoff?: () => void;
    onPlatformSendDispatch?: () => Promise<void>;
    onDeliveryResult?: (result: {
      channel: string;
      messageId: string;
      receipt?: MessageReceipt;
    }) => Promise<void> | void;
    contextToken?: string;
    runId?: string;
    accountId?: string;
  };

export type WeixinSendResult = {
  messageId: string;
  serverMessageId?: string;
  receipt?: MessageReceipt;
};

async function cacheOutboundMessage(params: {
  opts: WeixinMessageSendOptions;
  to: string;
  serverMessageId?: string;
  body: string;
  sourceMediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
}): Promise<void> {
  if (!params.opts.accountId || !params.serverMessageId) return;
  try {
    await getQuoteStore()?.put({
      accountId: params.opts.accountId,
      conversationId: params.to,
      messageId: params.serverMessageId,
      direction: "outbound",
      body: params.body,
      ...(params.sourceMediaPath ? { sourceMediaPath: params.sourceMediaPath } : {}),
      ...(params.mediaMime ? { mediaMime: params.mediaMime } : {}),
      ...(params.mediaName ? { mediaName: params.mediaName } : {}),
      createdAt: Date.now(),
    });
  } catch (err) {
    logger.warn(
      `quote cache: failed to save outbound message id=${params.serverMessageId}: ${String(err)}`,
    );
  }
}

function generateClientId(): string {
  return generateId("openclaw-weixin");
}

type PhysicalWeixinItem = {
  item?: MessageItem;
  clientId?: string;
  body: string;
  sourceMediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
};

async function plannedTexts(
  to: string,
  text: string,
  opts: WeixinMessageSendOptions,
): Promise<readonly string[]> {
  const prepared =
    opts.preparedText ??
    (await prepareWeixinText({ ...opts, to, text, accountId: opts.accountId }));
  if (prepared && (prepared.to !== to || prepared.accountId !== opts.accountId)) {
    throw new Error("Prepared text belongs to another outbound route");
  }
  return prepared?.texts ?? [text];
}

/** Seal all physical requests before dispatch; retain every acceptance before observers. */
async function dispatchWeixinItems(params: {
  to: string;
  items: readonly PhysicalWeixinItem[];
  opts: WeixinMessageSendOptions;
}): Promise<WeixinSendResult> {
  const { to, opts } = params;
  const planned = params.items.map((entry) => ({
    ...entry,
    clientId: entry.clientId ?? generateClientId(),
  }));
  const accepted: WeixinSendResult[] = [];
  // Receipt/failure helpers are not part of plugin registration or a legacy atomic send.
  const receiptRuntime =
    planned.length > 1 || opts.onDeliveryResult ? await import("./send-receipts.js") : undefined;
  const sourceResults = () =>
    accepted.map((result) => ({
      channel: "openclaw-weixin",
      messageId: result.serverMessageId ?? result.messageId,
    }));
  try {
    for (const entry of planned) {
      const req: SendMessageReq = {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: entry.clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: entry.item ? [entry.item] : undefined,
          context_token: opts.contextToken ?? undefined,
          run_id: opts.runId,
        },
      };
      opts.signal?.throwIfAborted();
      await opts.onPlatformSendDispatch?.();
      opts.signal?.throwIfAborted();
      opts.assertDirectAdapterHandoff?.();
      const response = await sendMessageApi({
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
      });
      const serverMessageId = response?.message_id;
      const result: WeixinSendResult = {
        messageId: entry.clientId,
        ...(serverMessageId ? { serverMessageId } : {}),
      };
      accepted.push(result);
      await cacheOutboundMessage({
        opts,
        to,
        serverMessageId,
        body: entry.body,
        sourceMediaPath: entry.sourceMediaPath,
        mediaMime: entry.mediaMime,
        mediaName: entry.mediaName,
      });
      await opts.onDeliveryResult?.({
        channel: "openclaw-weixin",
        ...result,
        receipt: receiptRuntime?.createMessageReceiptFromOutboundResults({
          results: [sourceResults().at(-1) ?? { messageId: result.messageId }],
        }),
      });
    }
  } catch (error) {
    if (accepted.length) {
      const runtime = receiptRuntime ?? (await import("./send-receipts.js"));
      throw runtime.createChannelPartialDeliveryError(error, {
        visibleReplySent: true,
        messageIds: sourceResults().map((result) => result.messageId),
        receipt: runtime.createMessageReceiptFromOutboundResults({ results: sourceResults() }),
      });
    }
    throw error;
  }
  const last = accepted.at(-1) ?? { messageId: "" };
  return accepted.length > 1
    ? {
        ...last,
        receipt: receiptRuntime?.createMessageReceiptFromOutboundResults({
          results: sourceResults(),
        }),
      }
    : last;
}

/** Send text through the one prepared-TEXT owner; legacy empty sends remain unchanged. */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinMessageSendOptions;
}): Promise<WeixinSendResult> {
  const texts = await plannedTexts(params.to, params.text, params.opts);
  return dispatchWeixinItems({
    ...params,
    items: texts.map((text) => ({
      item: text ? { type: MessageItemType.TEXT, text_item: { text } } : undefined,
      body: text,
    })),
  });
}

/** Non-TEXT structured items (including tool progress/results) never enter text planning. */
export async function sendMessageItemWeixin(params: {
  to: string;
  item: MessageItem;
  opts: WeixinMessageSendOptions;
  clientId?: string;
  label?: string;
}): Promise<WeixinSendResult> {
  if (params.item.type !== MessageItemType.TEXT) {
    return dispatchWeixinItems({
      ...params,
      items: [{ item: params.item, body: "", clientId: params.clientId }],
    });
  }
  const texts = await plannedTexts(params.to, params.item.text_item?.text ?? "", params.opts);
  return dispatchWeixinItems({
    ...params,
    items: texts.map((text, index) => ({
      item: { ...params.item, text_item: { ...params.item.text_item, text } },
      body: text,
      ...(index === 0 && params.clientId ? { clientId: params.clientId } : {}),
    })),
  });
}

/** Captions remain separate TEXT requests, all before the unchanged binary item. */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinMessageSendOptions;
  label: string;
  sourceMediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
}): Promise<WeixinSendResult> {
  const texts = params.text ? await plannedTexts(params.to, params.text, params.opts) : [];
  return dispatchWeixinItems({
    ...params,
    items: [
      ...texts.map((text) => ({
        item: { type: MessageItemType.TEXT, text_item: { text } },
        body: text,
      })),
      {
        item: params.mediaItem,
        body: getMediaLabel(params.mediaItem.type),
        sourceMediaPath: params.sourceMediaPath,
        mediaMime: params.mediaMime,
        mediaName: params.mediaName,
      },
    ],
  });
}

/**
 * Send an image message downstream using a previously uploaded file.
 * Optionally include a text caption as a separate TEXT item before the image.
 *
 * ImageItem fields:
 *   - media.encrypt_query_param: CDN download param
 *   - media.aes_key: AES key, base64-encoded
 *   - mid_size: original ciphertext file size
 */
export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
  filePath?: string;
  mediaMime?: string;
}): Promise<WeixinSendResult> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(
      `sendImageMessageWeixin: contextToken missing for to=${to}, sending without context`,
    );
  }
  logger.info(
    `sendImageMessageWeixin: to=${to} filekey=${uploaded.filekey} fileSize=${uploaded.fileSize} aeskey=present`,
  );

  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({
    to,
    text,
    mediaItem: imageItem,
    opts,
    label: "sendImageMessageWeixin",
    sourceMediaPath: params.filePath,
    mediaMime: params.mediaMime,
    mediaName: params.filePath?.split(/[\\/]/).pop(),
  });
}

/**
 * Send a video message downstream using a previously uploaded file.
 * VideoItem: media (CDN ref), video_size (ciphertext bytes).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
  filePath?: string;
  mediaMime?: string;
}): Promise<WeixinSendResult> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(
      `sendVideoMessageWeixin: contextToken missing for to=${to}, sending without context`,
    );
  }

  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({
    to,
    text,
    mediaItem: videoItem,
    opts,
    label: "sendVideoMessageWeixin",
    sourceMediaPath: params.filePath,
    mediaMime: params.mediaMime,
    mediaName: params.filePath?.split(/[\\/]/).pop(),
  });
}

/**
 * Send a file attachment downstream using a previously uploaded file.
 * FileItem: media (CDN ref), file_name, len (plaintext bytes as string).
 * Includes an optional text caption sent as a separate TEXT item first.
 */
export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
  filePath?: string;
  mediaMime?: string;
}): Promise<WeixinSendResult> {
  const { to, text, fileName, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(
      `sendFileMessageWeixin: contextToken missing for to=${to}, sending without context`,
    );
  }
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItems({
    to,
    text,
    mediaItem: fileItem,
    opts,
    label: "sendFileMessageWeixin",
    sourceMediaPath: params.filePath,
    mediaMime: params.mediaMime,
    mediaName: fileName,
  });
}
