import { Router } from "express";
import { requireLogin } from "../auth/middleware.js";
import { listTemplates, createTemplate, deleteTemplate } from "../templates/templateStore.js";
import { viewsDir } from "../config/paths.js";

const router = Router();

router.get("/templates", requireLogin, (req, res) => {
  res.sendFile(`${viewsDir}/templates.html`);
});

router.get("/api/templates", requireLogin, async (req, res) => {
  const templates = await listTemplates(req.session.user.mobile);
  res.json(templates);
});

router.post("/api/templates", requireLogin, async (req, res) => {
  const { name, body } = req.body;
  if (!name || !body) return res.status(400).json({ error: "missing fields" });

  const template = await createTemplate(req.session.user.mobile, { name, body });
  res.json(template);
});

router.delete("/api/templates/:id", requireLogin, async (req, res) => {
  await deleteTemplate(req.session.user.mobile, req.params.id);
  res.json({ status: "deleted" });
});

export default router;
