import path from "path";
import dotenv from "dotenv";
import { rootDir } from "./paths.js";

// Explicit path so .env is found regardless of the process's cwd (e.g. if
// launched as `node waflow/src/index.js` from one directory up).
dotenv.config({ path: path.join(rootDir, ".env") });

export default {
  port: Number(process.env.PORT) || 3001,
  sessionSecret: process.env.SESSION_SECRET || "change-me-in-production",
  redisHost: process.env.REDIS_HOST || "127.0.0.1",
  redisPort: Number(process.env.REDIS_PORT) || 6379,
  queueName: process.env.QUEUE_NAME || "node-wa-flow-baileys",
  logLevel: process.env.LOG_LEVEL || "debug",
  nodeEnv: process.env.NODE_ENV || "development",
};
