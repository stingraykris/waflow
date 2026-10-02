import { extractNumber } from "../moderation/messageText.js";
import { recordReplyForHealth } from "./safetyLimiter.js";
import logger from "../config/logger.js";

// Tracks distinct repliers per session (rolling 7-day window) as a rough
// proxy for WhatsApp's "unanswered message" ban signal - a low reply ratio
// is the strongest real-world risk indicator per the anti-ban research.
export function attachHealthTracker(sock, sessionId) {
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid || remoteJid.endsWith("@g.us")) continue;
        if (msg.key?.fromMe) continue;

        const number = extractNumber(remoteJid, msg);
        await recordReplyForHealth(sessionId, number);
      } catch (err) {
        logger.error("Health tracking failed", { sessionId, error: err.message });
      }
    }
  });
}
