import { Router } from "express";
import { Sessions } from "../whatsapp/sessionManager.js";
import { viewsDir } from "../config/paths.js";

const router = Router();

router.get("/number-verify", (req, res) => {
  if (!req.session.authenticated) return res.redirect("/");

  const sessionId = req.session.user?.current_session;
  if (!sessionId) return res.redirect("/");

  const session = Sessions[sessionId];
  if (!session) {
    req.session.user.current_session = null;
    return res.redirect("/");
  }
  if (!session.ready) return res.send("<h3>Session not ready. Please wait...</h3>");

  res.sendFile(`${viewsDir}/verify.html`);
});

export default router;
