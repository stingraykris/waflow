import { Sessions, isBanned } from "../whatsapp/sessionManager.js";
import { getQueue } from "../queue/queue.js";
import { buildJobOptions } from "../queue/schedule.js";
import { formatNumber, traceId } from "../utils/helpers.js";
import { saveFile } from "../utils/saveFile.js";
import { filterOptedOut } from "../moderation/blocklistStore.js";
import logger from "../config/logger.js";

export function registerSendHandlers(socket) {
  socket.on("SendMsg", async (formData, callback) => {
    const t = traceId();
    const user = socket.request.session.user;
    const sessionId = formData.cid;

    if (!sessionId.startsWith(user.mobile + "-")) {
      return callback({ message: "unauthorized" });
    }
    const session = Sessions[sessionId];
    if (!session || !session.ready) {
      return callback?.({ status: "session_not_ready" });
    }

    try {
      const numbers = [...new Set(formData.phone.split(/\r?\n/).filter(Boolean))];
      if (numbers.length > 300) {
        return callback({ message: "too_many_numbers", max: 300 });
      }
      const filePath = await saveFile(formData);

      const CountryCode = user?.country || "92";
      const queue = getQueue();

      const formatted = numbers.map((n) => formatNumber(n, CountryCode));
      const { allowed, blocked } = await filterOptedOut(user.mobile, formatted);

      for (let i = 0; i < allowed.length; i++) {
        const num = allowed[i];
        if (isBanned(sessionId)) {
          logger.warn("Blocked banned session", { sessionId, traceId: t });
          return callback({ message: "banned" });
        }
        await queue.add(
          "send",
          {
            sessionId,
            number: num,
            message: formData.msg,
            file: filePath,
            traceId: t,
            userId: sessionId.split("-")[0],
          },
          buildJobOptions(i, Number(formData.delay) || 4000, formData.scheduleAt),
        );
      }

      logger.info("Messages queued", {
        count: allowed.length,
        skipped: blocked.length,
        sessionId,
        traceId: t,
      });
      callback({ message: "queued", traceId: t, count: allowed.length, skipped: blocked.length });
    } catch (err) {
      logger.error("Queue error", { error: err.message, traceId: t });
      callback({ message: "error" });
    }
  });
}
