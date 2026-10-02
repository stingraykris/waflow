import { Worker } from "bullmq";
import redis from "../config/redis.js";
import env from "../config/env.js";
import logger from "../config/logger.js";
import { getSession, markBanned, destroySession, Sessions } from "../whatsapp/sessionManager.js";
import { sendViaSocket, isNumberRegistered } from "../whatsapp/sendMessage.js";
import { recordSent } from "../delivery/tracker.js";
import { isOptedOut } from "../moderation/blocklistStore.js";
import { getQueue } from "./queue.js";
import { checkAndReserve, isWithinBusinessHours, recordSentForHealth } from "../safety/safetyLimiter.js";

// Re-queues this job's data for a later time instead of sending now -
// used when a safety gate (business hours, hourly/daily cap) blocks the
// current attempt but the send is still meant to go out eventually.
async function deferJob(job, retryAt, reason) {
  const queue = getQueue();
  const delay = Math.max(0, retryAt - Date.now());
  await queue.add("send", job.data, {
    delay,
    attempts: job.opts.attempts,
    backoff: job.opts.backoff,
  });
  logger.info("Deferred send for safety gate", { sessionId: job.data.sessionId, reason, delay });
}

export function startWorker() {
  const worker = new Worker(
    env.queueName,
    async (job) => {
      const { sessionId, number, message, file, traceId } = job.data;

      if (job.attemptsMade >= 5) {
        logger.warn("Dropping job after retries", { sessionId, number, attempts: job.attemptsMade });
        return;
      }

      if (!Sessions[sessionId]) {
        logger.warn("Session deleted, dropping job", { sessionId });
        return;
      }

      const session = getSession(sessionId);

      if (!session || !session.ready) {
        // Session exists but is mid-reconnect (Baileys drops/restores the
        // socket routinely) - this is transient, not fatal. Dropping here
        // silently "completes" the job with nothing sent (a bare return is
        // success to BullMQ), which is how whole CSV batches used to vanish
        // during a reconnect blip. Defer instead, same as the other gates.
        await deferJob(job, Date.now() + 15000, "session_not_ready");
        return;
      }

      if (await isOptedOut(sessionId.split("-")[0], number)) {
        logger.info("Skipping opted-out number", { sessionId, number });
        return;
      }

      const ownerMobile = sessionId.split("-")[0];

      const hoursCheck = isWithinBusinessHours(ownerMobile, sessionId);
      if (!hoursCheck.allowed) {
        await deferJob(job, hoursCheck.retryAt, "outside_business_hours");
        return;
      }

      const capCheck = await checkAndReserve(ownerMobile, sessionId);
      if (!capCheck.allowed) {
        await deferJob(job, capCheck.retryAt, capCheck.reason);
        return;
      }

      try {
        // Numbers that aren't on WhatsApp (or that WhatsApp has only ever
        // seen as a @lid identity, a known Baileys gap - see
        // WhiskeySockets/Baileys#1522/#1832) can accept sendMessage() calls
        // locally and still never actually deliver. Catch that here instead
        // of finding out via a job that "completes" with nothing sent.
        const registered = await isNumberRegistered(session.sock, number);
        if (!registered) {
          logger.warn("Number not on WhatsApp, skipping", { sessionId, number, traceId });
          return;
        }
      } catch (err) {
        logger.warn("WhatsApp registration check failed, sending anyway", {
          sessionId,
          number,
          error: err.message,
        });
      }

      try {
        const messageId = await sendViaSocket(session.sock, number, message, file);
        await recordSent({ sessionId, jobId: job.id, number, messageId });
        await recordSentForHealth(sessionId);

        logger.info("Message sent", { number, traceId, messageId });
      } catch (err) {
        logger.error("Send failed", { error: err.message, traceId });

        const statusCode = err?.output?.statusCode;

        // connection-level failure -> tear down and let the user re-link
        if (statusCode === 428 || err.message?.includes("Connection Closed")) {
          logger.warn("WA connection lost -> destroying session", { sessionId });
          if (Sessions[sessionId]) Sessions[sessionId].ready = false;
          await destroySession(sessionId);
          return;
        }

        if (statusCode === 401 || err.message?.toLowerCase().includes("forbidden")) {
          markBanned(sessionId);
        }

        throw err;
      }
    },
    {
      connection: redis,
      concurrency: 2,
      limiter: {
        max: 5,
        duration: 60000,
      },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error("Job failed", { jobId: job?.id, error: err.message });
  });

  return worker;
}
