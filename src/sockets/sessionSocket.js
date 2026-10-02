import {
  Sessions,
  createSession as createWaSession,
  destroySession,
} from "../whatsapp/sessionManager.js";
import { buildSessionId, traceId } from "../utils/helpers.js";
import logger from "../config/logger.js";

export function registerSessionHandlers(socket) {
  const user = socket.request.session.user;

  socket.emit("session-id", user.current_session);

  socket.on("createSession", async ({ id }, callback) => {
    const t = traceId();
    const sessionId = buildSessionId(user, id);

    if (Sessions[sessionId]) return callback?.({ status: "success" });

    try {
      await createWaSession(sessionId, {
        onQr: (qr) => socket.emit("qr", qr),
        onReady: () => {
          socket.request.session.user.current_session = sessionId;
          socket.request.session.save();
          socket.emit("ready", { id });
        },
      });
      callback?.({ status: "success" });
    } catch (err) {
      logger.error("createSession failed", { error: err.message, traceId: t });
      callback?.({ status: "error", message: err.message });
    }
  });

  socket.on("joinSession", async ({ sessionId }, callback) => {
    const t = traceId();
    const user = socket.request.session.user;
    try {
      if (!sessionId.startsWith(user.mobile + "-")) {
        logger.warn("Unauthorized session access", { user: user.mobile, sessionId, traceId: t });
        return callback?.({ status: "error", message: "unauthorized" });
      }

      const session = Sessions[sessionId];
      if (!session) {
        logger.warn("Session not found", { sessionId, traceId: t });
        return callback?.({ status: "not_found" });
      }

      socket.request.session.user.current_session = sessionId;
      await new Promise((resolve) => socket.request.session.save(resolve));

      logger.info("Session joined", { user: user.mobile, sessionId, traceId: t });

      if (session.ready) {
        return callback?.({ status: "ready", id: sessionId.split("-")[1] });
      }
      return callback?.({ status: "loading" });
    } catch (err) {
      logger.error("joinSession error", { error: err.message, traceId: t });
      return callback?.({ status: "error" });
    }
  });

  socket.on("deleteSession", async ({ sessionId }, callback) => {
    const t = traceId();
    const user = socket.request.session.user;

    try {
      if (!sessionId.startsWith(user.mobile + "-")) {
        return callback?.({ status: "unauthorized" });
      }
      if (!Sessions[sessionId]) {
        return callback?.({ status: "not_found" });
      }

      await destroySession(sessionId);

      if (socket.request.session.user.current_session === sessionId) {
        socket.request.session.user.current_session = null;
        await new Promise((r) => socket.request.session.save(r));
      }

      logger.info("Session deleted", { sessionId, traceId: t });
      return callback?.({ status: "deleted" });
    } catch (err) {
      logger.error("deleteSession error", { error: err.message, traceId: t });
      return callback?.({ status: "error" });
    }
  });
}
