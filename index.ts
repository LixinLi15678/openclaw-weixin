import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { createWeixinPlugin } from "./src/channel.js";
import { assertHostCompatibility } from "./src/compat.js";
import { WeixinConfigSchema } from "./src/config/config-schema.js";

export default {
  id: "openclaw-weixin",
  name: "Weixin",
  description: "Weixin channel (getUpdates long-poll + sendMessage)",
  configSchema: buildChannelConfigSchema(WeixinConfigSchema),
  register(api: OpenClawPluginApi) {
    // Fail-fast: reject incompatible host versions before any side-effects.
    if (api.registrationMode !== "cli-metadata" && api.registrationMode !== "setup-only") {
      assertHostCompatibility(api.runtime?.version);
    }

    const runtime: (typeof api.runtime & { capabilities?: readonly string[] }) | undefined =
      api.registrationMode === "cli-metadata" || api.registrationMode === "setup-only"
        ? undefined
        : api.runtime;
    api.registerChannel({ plugin: createWeixinPlugin(runtime?.capabilities) });
  },
};
