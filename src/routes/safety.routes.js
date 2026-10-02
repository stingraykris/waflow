import { Router } from "express";
import { Sessions } from "../whatsapp/sessionManager.js";
import { requireLogin } from "../auth/middleware.js";
import { getStatus, updateSettings } from "../safety/safetyLimiter.js";
import { viewsDir } from "../config/paths.js";

function ownsSession(req, sessionId) {
  return sessionId.startsWith(req.session.user.mobile + "-");
}

const router = Router();

router.get("/safety", requireLogin, (req, res) => {
  res.sendFile(`${viewsDir}/safety.html`);
});

router.get("/api/safety", requireLogin, async (req, res) => {
  const mobile = req.session.user.mobile;
  const sessionIds = Object.keys(Sessions).filter((id) => id.startsWith(mobile + "-"));
  const statuses = await Promise.all(sessionIds.map((id) => getStatus(mobile, id)));
  res.json(statuses);
});

router.get("/api/safety/:sessionId", requireLogin, async (req, res) => {
  if (!ownsSession(req, req.params.sessionId)) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const status = await getStatus(req.session.user.mobile, req.params.sessionId);
  res.json(status);
});

router.post("/api/safety/:sessionId", requireLogin, async (req, res) => {
  if (!ownsSession(req, req.params.sessionId)) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const { dailyCapOverride, hourlyCapOverride, businessHours } = req.body;
  const settings = updateSettings(req.session.user.mobile, req.params.sessionId, {
    dailyCapOverride,
    hourlyCapOverride,
    businessHours,
  });
  res.json(settings);
});

export default router;
