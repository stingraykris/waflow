import { Router } from "express";
import { findByMobile, verifyPassword } from "../auth/users.js";
import { traceId } from "../utils/helpers.js";
import logger from "../config/logger.js";

const router = Router();

router.post("/login", (req, res) => {
  const t = traceId();
  const user = findByMobile(req.body.mobile);

  if (user && verifyPassword(user, req.body.pass)) {
    req.session.authenticated = true;
    req.session.user = {
      mobile: user.mobile,
      name: user.name,
      country: user.country || "92",
      isAdmin: !!user.isAdmin,
      current_session: null,
    };
    req.session.save();

    logger.info("Login success", { user: user.mobile, traceId: t });
  } else {
    logger.warn("Login failed", { mobile: req.body.mobile, traceId: t });
  }

  res.redirect("/");
});

router.get("/logout", (req, res) => {
  const user = req.session?.user;

  req.session.destroy(() => {
    logger.info("Logout", { user: user?.mobile });
    res.redirect("/");
  });
});

export default router;
