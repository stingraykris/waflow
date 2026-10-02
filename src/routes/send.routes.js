import { Router } from "express";
import fs from "fs";
import fs1 from "fs/promises";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import csv from "csv-parser";
import { Sessions, isBanned } from "../whatsapp/sessionManager.js";
import { requireLogin, apiAuth, apiLimiter, ipAllowlist } from "../auth/middleware.js";
import { getQueue } from "../queue/queue.js";
import { buildJobOptions } from "../queue/schedule.js";
import { isOptedOut } from "../moderation/blocklistStore.js";
import { formatNumber, traceId } from "../utils/helpers.js";
import { publicDir } from "../config/paths.js";
import { listCsvFiles, getCsvFile, csvFilePath, saveCsvFile, deleteCsvFile } from "../csv/csvLibraryStore.js";
import logger from "../config/logger.js";

const upload = multer({ dest: path.join(publicDir, "uploads") });
const router = Router();

// Shared by both the live CSV-upload send and the "send a saved CSV"
// path: parses the CSV, applies {column} templating + opt-out filtering +
// ban checks, and queues one job per (row, phone column). Does NOT touch
// the CSV file itself - callers own its lifecycle (delete a one-shot
// upload, keep a library file around).
function queueCsvCampaign({ sessionId, ownerMobile, csvPath, msg, filePath, delay, scheduleAt, countryCode }) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const stream = fs.createReadStream(csvPath).pipe(csv());

    stream.on("data", (row) => rows.push(row));

    stream.on("end", async () => {
      try {
        if (rows.length > 200) {
          return reject(Object.assign(new Error("too_many_rows"), { code: "too_many_rows" }));
        }

        // Scopes the jobId dedup (below) to this one campaign run. Without
        // it, resending the same CSV + message text reproduces identical
        // jobIds - BullMQ then silently no-ops queue.add() for every row
        // (an existing jobId, even a completed one still in its retention
        // window, is never re-added), so the UI reports "queued" while
        // nothing new actually lands in the queue.
        const batchId = crypto.randomUUID();

        const queue = getQueue();
        let stopped = false;
        let jobIndex = 0;
        let total = 0;

        for (let index = 0; index < rows.length; index++) {
          if (stopped) break;
          const row = rows[index];
          await new Promise((r) => setTimeout(r, 50));
          try {
            const phoneKeys = Object.keys(row).filter((k) => k.toLowerCase().startsWith("phone"));

            for (const key of phoneKeys) {
              if (stopped) break;
              const raw = row[key];
              if (!raw || raw.toString().trim().length < 10) continue;

              const num = formatNumber(raw, countryCode);

              if (await isOptedOut(ownerMobile, num)) {
                continue;
              }

              const message = (msg || "").replace(/\{(.*?)\}/g, (_, k) => {
                if (!(k in row)) {
                  logger.warn("Missing CSV column", { sessionId, key: k });
                  return "";
                }
                return row[k];
              });

              const hash = crypto.createHash("md5").update(message).digest("hex");

              if (isBanned(sessionId)) {
                stopped = true;
                logger.warn("Blocked banned session", { sessionId, sent: index });
                break;
              }

              await queue.add(
                "send",
                {
                  sessionId,
                  number: num,
                  message,
                  file: filePath,
                  traceId: traceId(),
                  userId: sessionId.split("-")[0],
                },
                {
                  jobId: crypto
                    .createHash("md5")
                    .update(`${batchId}-${sessionId}-${num}-${hash}-${jobIndex}`)
                    .digest("hex"),
                  ...buildJobOptions(jobIndex++, Number(delay) || 4000, scheduleAt),
                },
              );

              total++;
            }
          } catch (err) {
            logger.error("CSV row failed", { error: err.message });
          }
        }

        resolve({ total, stopped, rowCount: rows.length });
      } catch (err) {
        reject(err);
      }
    });

    stream.on("error", reject);
  });
}

router.post(
  "/send-csv",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const user = req.session.user;
      const { msg, delay, sessionId, scheduleAt } = req.body;
      const csvFile = req.files["file"]?.[0];
      const imageFile = req.files["image"]?.[0];

      if (!user || !sessionId || (!msg && !imageFile)) {
        return res.status(400).json({ error: "missing fields" });
      }
      if (!sessionId.startsWith(user.mobile + "-")) {
        return res.status(403).json({ error: "unauthorized" });
      }
      const session = Sessions[sessionId];
      if (!session || !session.ready) {
        return res.status(400).json({ error: "session_not_ready" });
      }
      if (!csvFile) {
        return res.status(400).json({ error: "missing fields" });
      }

      let filePath = null;
      if (imageFile) {
        const ext = path.extname(imageFile.originalname);
        const newPath = path.join(publicDir, "images", crypto.randomUUID() + ext);
        await fs1.rename(imageFile.path, newPath);
        filePath = newPath;
      }

      try {
        const { total, stopped } = await queueCsvCampaign({
          sessionId,
          ownerMobile: user.mobile,
          csvPath: csvFile.path,
          msg,
          filePath,
          delay,
          scheduleAt,
          countryCode: user?.country || "92",
        });

        fs.unlink(csvFile.path, () => {});

        if (stopped) {
          return res.status(403).json({ error: "session_banned", count: total });
        }
        return res.json({ status: "queued", count: total });
      } catch (err) {
        fs.unlink(csvFile.path, () => {});
        if (err.code === "too_many_rows") {
          return res.status(400).json({ error: "too_many_rows" });
        }
        logger.error("CSV parse error", { error: err.message });
        return res.status(500).json({ error: "csv_failed" });
      }
    } catch (err) {
      logger.error("CSV API error", { error: err.message });
      return res.status(500).json({ error: "csv_failed" });
    }
  },
);

// ================= CSV LIBRARY =================
// Save an uploaded CSV for reuse instead of sending it immediately.
router.post("/api/csv-library", requireLogin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing file" });
  const { name } = req.body;

  try {
    const content = await fs1.readFile(req.file.path, "utf8");
    const rowCount = Math.max(0, content.trim().split("\n").length - 1);

    const meta = await saveCsvFile(req.session.user.mobile, {
      name: name || req.file.originalname,
      originalFilename: req.file.originalname,
      tmpPath: req.file.path,
      rowCount,
    });
    res.json(meta);
  } catch (err) {
    logger.error("CSV library save failed", { error: err.message });
    res.status(500).json({ error: "save_failed" });
  }
});

router.get("/api/csv-library", requireLogin, async (req, res) => {
  const files = await listCsvFiles(req.session.user.mobile);
  res.json(files);
});

router.delete("/api/csv-library/:id", requireLogin, async (req, res) => {
  await deleteCsvFile(req.session.user.mobile, req.params.id);
  res.json({ status: "deleted" });
});

router.post("/api/csv-library/:id/send", requireLogin, async (req, res) => {
  const user = req.session.user;
  const { sessionId, msg, delay, scheduleAt } = req.body;

  if (!sessionId || !msg) {
    return res.status(400).json({ error: "missing fields" });
  }
  if (!sessionId.startsWith(user.mobile + "-")) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const session = Sessions[sessionId];
  if (!session || !session.ready) {
    return res.status(400).json({ error: "session_not_ready" });
  }

  const meta = await getCsvFile(user.mobile, req.params.id);
  if (!meta) return res.status(404).json({ error: "csv not found" });

  try {
    const { total, stopped } = await queueCsvCampaign({
      sessionId,
      ownerMobile: user.mobile,
      csvPath: csvFilePath(user.mobile, req.params.id),
      msg,
      filePath: null,
      delay,
      scheduleAt,
      countryCode: user?.country || "92",
    });

    if (stopped) {
      return res.status(403).json({ error: "session_banned", count: total });
    }
    return res.json({ status: "queued", count: total });
  } catch (err) {
    if (err.code === "too_many_rows") {
      return res.status(400).json({ error: "too_many_rows" });
    }
    logger.error("CSV library send failed", { error: err.message });
    return res.status(500).json({ error: "csv_failed" });
  }
});

router.use("/send-message", apiLimiter);
router.post("/send-message", apiAuth, ipAllowlist, async (req, res) => {
  const user = req.apiUser;

  try {
    const input = req.method === "GET" ? req.query : req.body;
    const phone = input.phone;
    const msg = input.msg;
    const delay = input.delay;
    const scheduleAt = input.scheduleAt;
    const sessionId = input.sessionId || input.id;

    if (!phone || !msg || !sessionId) {
      return res.status(400).json({ error: "missing fields" });
    }
    if (!sessionId.startsWith(user.mobile + "-")) {
      return res.status(403).json({ error: "unauthorized session" });
    }

    const session = Sessions[sessionId];
    if (!session || !session.ready) {
      return res.status(400).json({ error: "session_not_ready" });
    }
    if (Array.isArray(phone)) {
      return res.status(400).json({ error: "multiple_numbers_not_allowed" });
    }

    const clean = phone.toString().replace(/\D/g, "");
    if (clean.length < 10 || clean.length > 15) {
      return res.status(400).json({ error: "invalid_number" });
    }

    const queue = getQueue();
    const CountryCode = user?.country || "92";
    const finalNumber = formatNumber(clean.toString(), CountryCode);

    if (isBanned(sessionId)) {
      logger.warn("Blocked banned session", { sessionId });
      return res.status(403).json({ error: "session_banned" });
    }

    if (await isOptedOut(user.mobile, finalNumber)) {
      return res.status(403).json({ error: "number_opted_out" });
    }

    await queue.add(
      "send",
      {
        sessionId,
        number: finalNumber,
        message: msg,
        file: null,
        traceId: traceId(),
        userId: sessionId.split("-")[0],
      },
      buildJobOptions(1, Number(delay) || 4000, scheduleAt),
    );

    return res.status(200).send("done");
  } catch (err) {
    logger.error("API send error", { error: err.message });
    return res.status(500).json({ error: "failed" });
  }
});

export default router;
