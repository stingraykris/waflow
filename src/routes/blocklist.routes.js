import { Router } from "express";
import { requireLogin } from "../auth/middleware.js";
import { listBlocklist, addToBlocklist, removeFromBlocklist } from "../moderation/blocklistStore.js";
import { formatNumber } from "../utils/helpers.js";
import { viewsDir } from "../config/paths.js";

const router = Router();

router.get("/blocklist", requireLogin, (req, res) => {
  res.sendFile(`${viewsDir}/blocklist.html`);
});

router.get("/api/blocklist", requireLogin, async (req, res) => {
  const numbers = await listBlocklist(req.session.user.mobile);
  res.json(numbers);
});

router.post("/api/blocklist", requireLogin, async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: "missing number" });

  const clean = formatNumber(number, req.session.user.country || "92");
  await addToBlocklist(req.session.user.mobile, clean);
  res.json({ status: "added", number: clean });
});

router.delete("/api/blocklist/:number", requireLogin, async (req, res) => {
  await removeFromBlocklist(req.session.user.mobile, req.params.number);
  res.json({ status: "removed" });
});

export default router;
