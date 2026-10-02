import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import multer from "multer";
import { requireLogin } from "../auth/middleware.js";
import {
  listFlows,
  getFlow,
  createFlow,
  updateFlow,
  deleteFlow,
  activateFlow,
  deactivateFlow,
} from "../flows/flowStore.js";
import { listResponses } from "../flows/flowResponseStore.js";
import { dataDir, viewsDir } from "../config/paths.js";
import logger from "../config/logger.js";

const upload = multer({ dest: path.join(dataDir, "flow-media-uploads") });
const router = Router();

router.get("/flows", requireLogin, (req, res) => {
  res.sendFile(`${viewsDir}/flows.html`);
});

router.get("/api/flows", requireLogin, async (req, res) => {
  const flows = await listFlows(req.session.user.mobile);
  res.json(flows);
});

router.get("/api/flows/:id", requireLogin, async (req, res) => {
  const flow = await getFlow(req.session.user.mobile, req.params.id);
  if (!flow) return res.status(404).json({ error: "flow not found" });
  res.json(flow);
});

router.post("/api/flows", requireLogin, async (req, res) => {
  const { name, triggerKeywords, startNodeId, nodes } = req.body;
  if (!name || !startNodeId || !nodes || typeof nodes !== "object") {
    return res.status(400).json({ error: "missing fields" });
  }

  const flow = await createFlow(req.session.user.mobile, {
    name,
    triggerKeywords,
    startNodeId,
    nodes,
  });
  res.json(flow);
});

router.put("/api/flows/:id", requireLogin, async (req, res) => {
  const { name, triggerKeywords, startNodeId, nodes } = req.body;
  if (!name || !startNodeId || !nodes || typeof nodes !== "object") {
    return res.status(400).json({ error: "missing fields" });
  }

  try {
    const flow = await updateFlow(req.session.user.mobile, req.params.id, {
      name,
      triggerKeywords,
      startNodeId,
      nodes,
    });
    res.json(flow);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.delete("/api/flows/:id", requireLogin, async (req, res) => {
  await deleteFlow(req.session.user.mobile, req.params.id);
  res.json({ status: "deleted" });
});

router.post("/api/flows/:id/activate", requireLogin, async (req, res) => {
  try {
    const flow = await activateFlow(req.session.user.mobile, req.params.id);
    res.json(flow);
  } catch (err) {
    res.status(err.conflict ? 400 : 404).json({ error: err.message });
  }
});

router.post("/api/flows/:id/deactivate", requireLogin, async (req, res) => {
  try {
    const flow = await deactivateFlow(req.session.user.mobile, req.params.id);
    res.json(flow);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Uploads media for a flow node (sent immediately from the builder's node
// modal, independent of when/whether the flow itself gets saved).
router.post("/api/flows/media", requireLogin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing file" });

  const ext = path.extname(req.file.originalname);
  const destDir = path.join(dataDir, "flow-media", req.session.user.mobile, "sent");
  const destPath = path.join(destDir, `${crypto.randomUUID()}${ext}`);

  await fs.mkdir(destDir, { recursive: true });
  await fs.rename(req.file.path, destPath);

  res.json({ path: destPath, filename: req.file.originalname });
});

router.post("/api/flows/reset-states", requireLogin, async (req, res) => {
  const ownerMobile = req.session.user.mobile;
  const stateDir = path.join(dataDir, "flow-state", ownerMobile);

  let cleared = 0;
  try {
    const sessions = await fs.readdir(stateDir);
    for (const s of sessions) {
      const files = await fs.readdir(path.join(stateDir, s)).catch(() => []);
      cleared += files.length;
    }
  } catch {
    // no state directory yet
  }

  await fs.rm(stateDir, { recursive: true, force: true });

  logger.info("Flow states reset", { ownerMobile, count: cleared });
  res.json({ cleared });
});

router.get("/flow-log", requireLogin, (req, res) => {
  res.sendFile(`${viewsDir}/flow-log.html`);
});

router.get("/api/flow-log", requireLogin, async (req, res) => {
  const { flowName, number, from, to, page, pageSize } = req.query;
  const result = await listResponses(req.session.user.mobile, {
    flowName,
    number,
    from,
    to,
    page: page ? Number(page) : 0,
    pageSize: pageSize ? Number(pageSize) : 20,
  });
  res.json(result);
});

export default router;
