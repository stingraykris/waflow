import { Router } from "express";
import { Sessions } from "../whatsapp/sessionManager.js";
import { getQueue } from "../queue/queue.js";
import { getJobDelivery } from "../delivery/tracker.js";
import { requireLogin } from "../auth/middleware.js";
import { viewsDir } from "../config/paths.js";
import logger from "../config/logger.js";

function ownsSession(req, sessionId) {
  return sessionId.startsWith(req.session.user.mobile + "-");
}

const router = Router();

router.get("/queue", (req, res) => {
  if (!req.session.authenticated) return res.redirect("/");

  const sessionId = req.session.user?.current_session;
  if (!sessionId) return res.redirect("/");

  const session = Sessions[sessionId];
  if (!session) {
    req.session.user.current_session = null;
    return res.redirect("/");
  }
  if (!session.ready) return res.send("<h3>Session not ready. Please wait...</h3>");

  res.sendFile(`${viewsDir}/history.html`);
});

router.get("/queue-status/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const queue = getQueue();

    const countFor = async (state) => {
      const jobs = await queue.getJobs([state], 0, 2000, true);
      return jobs.filter((j) => j.data.sessionId === sessionId).length;
    };

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      countFor("waiting"),
      countFor("active"),
      countFor("completed"),
      countFor("failed"),
      countFor("delayed"),
    ]);

    res.json({ waiting, active, completed, failed, delayed });
  } catch (err) {
    logger.error("Queue status error", { error: err.message });
    res.status(500).json({ error: "failed" });
  }
});

router.get("/queue-jobs/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const queue = getQueue();

    const page = Math.max(0, Number(req.query.page) || 0);
    const pageSize = Math.min(2000, Math.max(1, Number(req.query.pageSize) || 20));
    const start = page * pageSize;
    const end = start + pageSize - 1;

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getJobs(["waiting"], 0, 2000, true),
      queue.getJobs(["active"], 0, 2000, true),
      queue.getJobs(["completed"], 0, 2000, true),
      queue.getJobs(["failed"], 0, 2000, true),
      queue.getJobs(["delayed"], 0, 2000, true),
    ]);

    const filterJobs = (jobs) => jobs.filter((j) => j.data.sessionId === sessionId);
    const pageOf = (jobs) => jobs.slice(start, end + 1);

    const format = async (jobs, status) =>
      Promise.all(
        jobs.map(async (job) => {
          const delivery = await getJobDelivery(sessionId, job.id);
          return {
            id: job.id,
            number: job.data.number,
            message: job.data.message,
            file: job.data.file,
            attemptsMade: job.attemptsMade,
            status,
            timestamp: job.timestamp,
            failedReason: job.failedReason || null,
            deliveryStatus: delivery?.status || null,
          };
        }),
      );

    const buckets = {
      waiting: filterJobs(waiting),
      delayed: filterJobs(delayed),
      active: filterJobs(active),
      completed: filterJobs(completed),
      failed: filterJobs(failed),
    };

    const totals = Object.fromEntries(
      Object.entries(buckets).map(([status, jobs]) => [status, jobs.length]),
    );

    res.json({
      page,
      pageSize,
      totals,
      waiting: await format(pageOf(buckets.waiting), "waiting"),
      delayed: await format(pageOf(buckets.delayed), "delayed"),
      active: await format(pageOf(buckets.active), "active"),
      completed: await format(pageOf(buckets.completed), "completed"),
      failed: await format(pageOf(buckets.failed), "failed"),
    });
  } catch (err) {
    logger.error("Queue jobs fetch error", { error: err.message });
    res.status(500).json({ error: "failed" });
  }
});

router.post("/queue-jobs/:sessionId/:jobId/retry", requireLogin, async (req, res) => {
  const { sessionId, jobId } = req.params;
  if (!ownsSession(req, sessionId)) {
    return res.status(403).json({ error: "unauthorized" });
  }

  try {
    const queue = getQueue();
    const job = await queue.getJob(jobId);
    if (!job || job.data.sessionId !== sessionId) {
      return res.status(404).json({ error: "job not found" });
    }

    await job.retry();
    res.json({ status: "retried" });
  } catch (err) {
    logger.error("Job retry failed", { error: err.message, jobId });
    res.status(500).json({ error: "retry_failed" });
  }
});

router.post("/queue-jobs/:sessionId/retry-failed", requireLogin, async (req, res) => {
  const { sessionId } = req.params;
  if (!ownsSession(req, sessionId)) {
    return res.status(403).json({ error: "unauthorized" });
  }

  try {
    const queue = getQueue();
    const failed = await queue.getJobs(["failed"], 0, 2000, true);
    const mine = failed.filter((j) => j.data.sessionId === sessionId);

    let retried = 0;
    for (const job of mine) {
      await job.retry().catch(() => {});
      retried++;
    }

    res.json({ retried });
  } catch (err) {
    logger.error("Retry-all failed", { error: err.message, sessionId });
    res.status(500).json({ error: "retry_failed" });
  }
});

export default router;
