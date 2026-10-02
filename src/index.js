import fs from "fs";
import express from "express";
import session from "express-session";
import http from "http";
import { Server } from "socket.io";
import ejs from "ejs";

import path from "path";
import env from "./config/env.js";
import logger from "./config/logger.js";
import { publicDir, rootDir, dataDir } from "./config/paths.js";
import { attachSocketHandlers } from "./sockets/index.js";
import { startWorker } from "./queue/worker.js";

import authRoutes from "./routes/auth.routes.js";
import sessionRoutes from "./routes/session.routes.js";
import queueRoutes from "./routes/queue.routes.js";
import sendRoutes from "./routes/send.routes.js";
import templateRoutes from "./routes/template.routes.js";
import verifyRoutes from "./routes/verify.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import blocklistRoutes from "./routes/blocklist.routes.js";
import flowRoutes from "./routes/flow.routes.js";
import safetyRoutes from "./routes/safety.routes.js";
import integrationsRoutes from "./routes/integrations.routes.js";
import { sweepExpiredStates } from "./flows/flowStateStore.js";

for (const dir of [
  path.join(publicDir, "uploads"),
  path.join(publicDir, "images"),
  path.join(rootDir, "logs"),
  path.join(dataDir, "flows"),
  path.join(dataDir, "flow-state"),
  path.join(dataDir, "flow-responses"),
  path.join(dataDir, "flow-media"),
  path.join(dataDir, "flow-media-uploads"),
  path.join(dataDir, "csv-library"),
  path.join(dataDir, "session-safety"),
  path.join(dataDir, "ai-settings"),
  path.join(dataDir, "webhooks"),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(publicDir));
app.engine("html", ejs.renderFile);
app.set("view engine", "html");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

const sessionMiddleware = session({
  secret: env.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Only require HTTPS in production (behind a TLS-terminating proxy);
    // plain http://localhost dev servers can't set/read secure cookies.
    secure: env.nodeEnv === "production",
    sameSite: "lax",
  },
});
app.use(sessionMiddleware);

app.use(authRoutes);
app.use(sessionRoutes);
app.use(queueRoutes);
app.use(sendRoutes);
app.use(templateRoutes);
app.use(verifyRoutes);
app.use(adminRoutes);
app.use(blocklistRoutes);
app.use(flowRoutes);
app.use(safetyRoutes);
app.use(integrationsRoutes);

attachSocketHandlers(io, sessionMiddleware);
startWorker();

// Stuck flow conversations (contact went silent mid-menu) age out after
// 24h; sweep for them periodically so that happens even without another
// inbound message to trigger the lazy-expiry check in flowStateStore.
const STATE_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 min
setInterval(sweepExpiredStates, STATE_SWEEP_INTERVAL_MS);
sweepExpiredStates();

process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT EXCEPTION", { error: err.stack });
});
process.on("unhandledRejection", (err) => {
  logger.error("UNHANDLED PROMISE", { error: err });
});

server.listen(env.port, "0.0.0.0", () => {
  logger.info("Server started", { port: env.port });
});
