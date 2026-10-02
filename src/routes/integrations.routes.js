import { Router } from "express";
import { requireLogin } from "../auth/middleware.js";
import {
  getMaskedSettings,
  saveProviderKey,
  saveProviderModel,
  removeProviderKey,
  PROVIDERS,
} from "../ai/aiSettingsStore.js";
import { getWebhookConfig, saveWebhookConfig } from "../webhooks/webhookStore.js";
import { viewsDir } from "../config/paths.js";

const router = Router();

router.get("/integrations", requireLogin, (req, res) => {
  res.sendFile(`${viewsDir}/integrations.html`);
});

router.get("/api/ai-settings", requireLogin, (req, res) => {
  res.json(getMaskedSettings(req.session.user.mobile));
});

router.post("/api/ai-settings", requireLogin, (req, res) => {
  const { provider, apiKey, model } = req.body;
  if (!PROVIDERS.includes(provider) || !apiKey) {
    return res.status(400).json({ error: "missing/invalid fields" });
  }
  res.json(saveProviderKey(req.session.user.mobile, provider, apiKey, model));
});

router.put("/api/ai-settings/:provider/model", requireLogin, (req, res) => {
  const { model } = req.body;
  if (!PROVIDERS.includes(req.params.provider) || !model) {
    return res.status(400).json({ error: "missing/invalid fields" });
  }
  try {
    res.json(saveProviderModel(req.session.user.mobile, req.params.provider, model));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/api/ai-settings/:provider", requireLogin, (req, res) => {
  res.json(removeProviderKey(req.session.user.mobile, req.params.provider));
});

router.get("/api/webhooks", requireLogin, (req, res) => {
  res.json(getWebhookConfig(req.session.user.mobile));
});

router.post("/api/webhooks", requireLogin, (req, res) => {
  const { url, events } = req.body;
  res.json(saveWebhookConfig(req.session.user.mobile, { url, events }));
});

router.post("/api/webhooks/test", requireLogin, async (req, res) => {
  const mobile = req.session.user.mobile;
  const config = getWebhookConfig(mobile);
  if (!config.url) return res.status(400).json({ error: "no webhook url configured" });

  try {
    const started = Date.now();
    const result = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "test", timestamp: Date.now(), message: "Test ping from WAFLOW" }),
      signal: AbortSignal.timeout(5000),
    });
    res.json({ status: result.ok ? "ok" : "failed", httpStatus: result.status, ms: Date.now() - started });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
