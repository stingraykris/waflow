import { Router } from "express";
import { getUsers, createUser, deleteUser, resetApiKey } from "../auth/users.js";
import { requireAdmin } from "../auth/middleware.js";
import { viewsDir } from "../config/paths.js";
import logger from "../config/logger.js";

const router = Router();

router.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(`${viewsDir}/admin.html`);
});

router.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = getUsers().map(({ passHash, ...rest }) => rest);
  res.json(users);
});

router.post("/api/admin/users", requireAdmin, (req, res) => {
  const { name, mobile, pass, country, isAdmin } = req.body;
  if (!name || !mobile || !pass) {
    return res.status(400).json({ error: "missing fields" });
  }

  try {
    const user = createUser({ name, mobile, pass, country, isAdmin });
    logger.info("Admin created user", { by: req.session.user.mobile, mobile });
    const { passHash, ...rest } = user;
    res.json(rest);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/api/admin/users/:mobile", requireAdmin, (req, res) => {
  if (req.params.mobile === req.session.user.mobile) {
    return res.status(400).json({ error: "cannot delete your own account" });
  }

  try {
    deleteUser(req.params.mobile);
    logger.info("Admin deleted user", { by: req.session.user.mobile, mobile: req.params.mobile });
    res.json({ status: "deleted" });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/api/admin/users/:mobile/reset-api-key", requireAdmin, (req, res) => {
  try {
    const newKey = resetApiKey(req.params.mobile);
    res.json({ status: "success", apiKey: newKey });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

export default router;
