import redis from "../config/redis.js";
import logger from "../config/logger.js";
import { dispatch } from "../webhooks/dispatcher.js";

// Baileys' proto.WebMessageInfo.Status enum values.
const STATUS_LABELS = {
  0: "error",
  1: "pending",
  2: "sent", // SERVER_ACK
  3: "delivered", // DELIVERY_ACK
  4: "read",
  5: "played",
};

const jobKey = (sessionId, jobId) => `delivery:job:${sessionId}:${jobId}`;
const msgKey = (messageId) => `delivery:msg:${messageId}`;

// Called right after a message is successfully handed to WhatsApp so later
// receipts (delivered/read) can be matched back to the originating job.
export async function recordSent({ sessionId, jobId, number, messageId }) {
  if (!messageId) return;
  const key = jobKey(sessionId, jobId);
  await redis.hset(key, {
    number,
    messageId,
    status: "sent",
    updatedAt: Date.now(),
  });
  await redis.expire(key, 60 * 60 * 24 * 7); // keep 7 days
  await redis.set(msgKey(messageId), `${sessionId}:${jobId}`, "EX", 60 * 60 * 24 * 7);
}

export async function getJobDelivery(sessionId, jobId) {
  const data = await redis.hgetall(jobKey(sessionId, jobId));
  return Object.keys(data).length ? data : null;
}

// Attaches a `messages.update` listener to a live Baileys socket so delivery
// receipts (sent -> delivered -> read) get persisted as they arrive.
export function attachDeliveryTracking(sock, sessionId) {
  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      try {
        const messageId = update.key?.id;
        const statusCode = update.update?.status;
        if (!update.key?.fromMe || !messageId || statusCode === undefined) continue;

        const label = STATUS_LABELS[statusCode];
        if (!label) continue;

        const ref = await redis.get(msgKey(messageId));
        if (!ref) continue;

        const key = jobKey(...ref.split(":"));
        await redis.hset(key, {
          status: label,
          updatedAt: Date.now(),
        });

        const number = await redis.hget(key, "number");
        dispatch(sessionId.split("-")[0], "deliveryStatus", { sessionId, number, status: label });
      } catch (err) {
        logger.error("Delivery tracking update failed", { error: err.message, sessionId });
      }
    }
  });
}
