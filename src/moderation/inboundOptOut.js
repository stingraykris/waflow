import { addToBlocklist } from "./blocklistStore.js";
import { extractText, extractNumber } from "./messageText.js";
import logger from "../config/logger.js";

// Listens for an inbound "STOP" and blocklists the sender for this
// session's owner, so future campaigns skip them automatically.
export function attachOptOutListener(sock, sessionId) {
  const ownerMobile = sessionId.split("-")[0];

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid || remoteJid.endsWith("@g.us")) continue;
        if (msg.key?.fromMe) continue;

        const text = extractText(msg.message);
        if (!text || text.trim().toUpperCase() !== "STOP") continue;

        const number = extractNumber(remoteJid, msg);
        await addToBlocklist(ownerMobile, number);
        logger.info("Number opted out via STOP", { sessionId, number });

        await sock
          .sendMessage(remoteJid, {
            text: "You have been unsubscribed and won't receive further messages.",
          })
          .catch(() => {});
      } catch (err) {
        logger.error("Opt-out handling failed", { sessionId, error: err.message });
      }
    }
  });
}
