import path from "path";
import { dataDir } from "../config/paths.js";
import { readJson, writeJsonAtomic } from "../flows/fileStore.js";

const settingsPath = (mobile) => path.join(dataDir, "webhooks", `${mobile}.json`);

const DEFAULTS = {
  url: null,
  events: { messageReceived: false, flowCompleted: false, deliveryStatus: false },
};

export function getWebhookConfig(mobile) {
  return readJson(settingsPath(mobile)) || { ...DEFAULTS, events: { ...DEFAULTS.events } };
}

export function saveWebhookConfig(mobile, { url, events }) {
  const config = {
    url: url || null,
    events: {
      messageReceived: !!events?.messageReceived,
      flowCompleted: !!events?.flowCompleted,
      deliveryStatus: !!events?.deliveryStatus,
    },
  };
  writeJsonAtomic(settingsPath(mobile), config);
  return config;
}
