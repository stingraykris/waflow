import { Router } from "express";
import { Sessions } from "../whatsapp/sessionManager.js";
import { findByMobile, resetApiKey } from "../auth/users.js";
import { requireLogin, apiLimiter } from "../auth/middleware.js";
import { viewsDir } from "../config/paths.js";
import logger from "../config/logger.js";

const router = Router();

router.get("/", (req, res) => {
  if (!req.session.authenticated) return res.sendFile(`${viewsDir}/login.html`);

  if (req.session.user.current_session) {
    return res.sendFile(`${viewsDir}/home.html`);
  }

  const sessions = Object.entries(Sessions)
    .filter(([key]) => key.startsWith(req.session.user.mobile + "-"))
    .map(([key, value]) => ({
      id: key.replace(req.session.user.mobile + "-", ""),
      sessionId: key,
      ready: value.ready,
    }));

  res.render(`${viewsDir}/session.html`, { session_list: sessions });
});

router.get("/api/me", requireLogin, (req, res) => {
  const fullUser = findByMobile(req.session.user.mobile);
  if (!fullUser) return res.status(404).json({ error: "user not found" });

  res.json({
    mobile: fullUser.mobile,
    name: fullUser.name,
    isAdmin: !!fullUser.isAdmin,
  });
});

router.get("/api-settings", requireLogin, (req, res) => {
  const fullUser = findByMobile(req.session.user.mobile);
  if (!fullUser) return res.redirect("/");

  res.render(`${viewsDir}/api-settings.html`, {
    apiKey: fullUser.apiKey,
    mobile: fullUser.mobile,
    name: fullUser.name,
    host: req.protocol + "://" + req.get("host"),
  });
});

router.post("/reset-api-key", requireLogin, apiLimiter, (req, res) => {
  const user = req.session.user;

  try {
    const newKey = resetApiKey(user.mobile);
    logger.info("API key reset", { user: user.mobile });
    return res.json({ status: "success", apiKey: newKey });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

export default router;
