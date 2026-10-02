import logger from "../config/logger.js";
import { getWebhookConfig } from "./webhookStore.js";

// Fire-and-forget POST to the user's configured webhook URL. Never throws
// into the caller - a broken/unreachable webhook must never affect the
// actual WhatsApp send/flow/delivery path it's reporting on.
export async function dispatch(mobile, eventType, payload) {
  try {
    const config = getWebhookConfig(mobile);
    if (!config.url || !config.events[eventType]) return;

    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: eventType, timestamp: Date.now(), ...payload }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      logger.warn("Webhook delivery failed", { mobile, eventType, status: res.status });
    }
  } catch (err) {
    logger.warn("Webhook dispatch error", { mobile, eventType, error: err.message });
  }
}
