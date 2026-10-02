import logger from "../config/logger.js";
import { registerSessionHandlers } from "./sessionSocket.js";
import { registerSendHandlers } from "./sendSocket.js";
import { registerVerifyHandlers } from "./verifySocket.js";

export function attachSocketHandlers(io, sessionMiddleware) {
  io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

  io.use((socket, next) => {
    if (socket.request.session?.authenticated) return next();
    return next(new Error("unauthorized"));
  });

  io.on("connection", (socket) => {
    const user = socket.request.session.user;

    logger.info("Socket connected", { socketId: socket.id, user: user.mobile });

    registerSessionHandlers(socket);
    registerSendHandlers(socket);
    registerVerifyHandlers(socket);
  });
}
