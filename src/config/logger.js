import fs from "fs";
import path from "path";
import winston from "winston";
import "winston-daily-rotate-file";
import env from "./env.js";
import { rootDir } from "./paths.js";

// Anchored to the project root (not process.cwd()) so logs always land in
// waflow/logs/ regardless of which directory the process was
// launched from (e.g. `node waflow/src/index.js` from one level up).
const logsDir = path.join(rootDir, "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logger = winston.createLogger({
  level: env.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({
      filename: path.join(logsDir, "app-%DATE%.log"),
      datePattern: "YYYY-MM",
      maxSize: "10m",
      maxFiles: "7d",
    }),
    new winston.transports.DailyRotateFile({
      filename: path.join(logsDir, "error-%DATE%.log"),
      level: "error",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "30d",
    }),
  ],
});

export default logger;
