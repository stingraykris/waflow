import { Sessions } from "../whatsapp/sessionManager.js";
import { isNumberRegistered } from "../whatsapp/sendMessage.js";
import { formatNumber, traceId } from "../utils/helpers.js";
import logger from "../config/logger.js";

export function registerVerifyHandlers(socket) {
  socket.on("verify", async (formData, callback) => {
    const t = traceId();
    const user = socket.request.session.user;
    const sessionId = formData.cid;
    if (!sessionId.startsWith(user.mobile + "-")) {
      return callback({ message: "unauthorized" });
    }

    try {
      const numbers = [...new Set(formData.phone.split(/\r?\n/).filter(Boolean))];
      const CountryCode = user?.country || "92";
      const session = Sessions[sessionId];

      if (!session || !session.ready) {
        return callback?.({ status: "session_not_ready" });
      }

      for (let i = 0; i < numbers.length; i++) {
        const finalNumber = formatNumber(numbers[i].toString(), CountryCode);

        try {
          const isRegistered = await isNumberRegistered(session.sock, finalNumber);
          socket.emit("verifyStatus", { number: finalNumber, status: isRegistered });
          await new Promise((r) => setTimeout(r, 150));
        } catch (err) {
          logger.error("Verify failed", { error: err.message, number: finalNumber, traceId: t });
          socket.emit("verifyStatus", { number: finalNumber, status: false });
        }
      }

      callback?.({ status: "done" });
    } catch (err) {
      logger.error("Verify error", { error: err.message, traceId: t });
      callback?.({ status: "error" });
    }
  });
}
