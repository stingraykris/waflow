import path from "path";
import { dataDir } from "../config/paths.js";
import { readJson, writeJsonAtomic } from "../flows/fileStore.js";

const PROVIDERS = ["openai", "anthropic", "gemini", "deepseek"];

// Used whenever an account hasn't picked a model for that provider yet.
// These are the cheapest/free-tier-friendly option per provider as of
// mid-2026 - pick a different one (paid, more capable) any time from
// /integrations.
const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  gemini: "gemini-3.1-flash-lite",
  deepseek: "deepseek-chat",
};

const settingsPath = (mobile) => path.join(dataDir, "ai-settings", `${mobile}.json`);

function loadRaw(mobile) {
  return readJson(settingsPath(mobile)) || { providers: {}, defaultProvider: null };
}

// Full settings including raw keys - internal use only (calling the
// provider APIs). Never expose this over HTTP.
export function getSettings(mobile) {
  return loadRaw(mobile);
}

// Safe-for-the-browser view: which providers are configured and a masked
// form of each key, never the raw secret.
export function getMaskedSettings(mobile) {
  const settings = loadRaw(mobile);
  const providers = {};
  for (const p of PROVIDERS) {
    const key = settings.providers[p]?.apiKey;
    providers[p] = key
      ? { configured: true, masked: maskKey(key), model: settings.providers[p].model || DEFAULT_MODELS[p] }
      : { configured: false, model: DEFAULT_MODELS[p] };
  }
  return { providers, defaultProvider: settings.defaultProvider };
}

function maskKey(key) {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function saveProviderKey(mobile, provider, apiKey, model) {
  if (!PROVIDERS.includes(provider)) throw new Error("unknown provider");
  const settings = loadRaw(mobile);
  settings.providers[provider] = { apiKey, model: model || DEFAULT_MODELS[provider] };
  if (!settings.defaultProvider) settings.defaultProvider = provider;
  writeJsonAtomic(settingsPath(mobile), settings);
  return getMaskedSettings(mobile);
}

// Lets an account change just the model for a provider it's already
// configured, without re-entering the API key.
export function saveProviderModel(mobile, provider, model) {
  if (!PROVIDERS.includes(provider)) throw new Error("unknown provider");
  const settings = loadRaw(mobile);
  if (!settings.providers[provider]) throw new Error("provider not configured");
  settings.providers[provider].model = model || DEFAULT_MODELS[provider];
  writeJsonAtomic(settingsPath(mobile), settings);
  return getMaskedSettings(mobile);
}

export function removeProviderKey(mobile, provider) {
  const settings = loadRaw(mobile);
  delete settings.providers[provider];
  if (settings.defaultProvider === provider) settings.defaultProvider = null;
  writeJsonAtomic(settingsPath(mobile), settings);
  return getMaskedSettings(mobile);
}

export function getApiKey(mobile, provider) {
  return loadRaw(mobile).providers[provider]?.apiKey || null;
}

export function getModel(mobile, provider) {
  return loadRaw(mobile).providers[provider]?.model || DEFAULT_MODELS[provider];
}

export function listConfiguredProviders(mobile) {
  const settings = loadRaw(mobile);
  return PROVIDERS.filter((p) => settings.providers[p]?.apiKey);
}

export { PROVIDERS };
