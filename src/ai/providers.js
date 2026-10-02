import logger from "../config/logger.js";
import { getApiKey, getModel } from "./aiSettingsStore.js";

const TIMEOUT_MS = 20000;

// Shared shape for OpenAI and DeepSeek, which both speak the same
// chat-completions API.
async function callOpenAiCompatible(baseUrl, apiKey, model, { systemPrompt, userMessage }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt || "You are a helpful assistant." },
        { role: "user", content: userMessage },
      ],
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`${baseUrl} request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function callOpenAI(apiKey, model, opts) {
  return callOpenAiCompatible("https://api.openai.com/v1", apiKey, model, opts);
}

async function callDeepSeek(apiKey, model, opts) {
  return callOpenAiCompatible("https://api.deepseek.com", apiKey, model, opts);
}

async function callAnthropic(apiKey, model, { systemPrompt, userMessage }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      system: systemPrompt || "You are a helpful assistant.",
      messages: [{ role: "user", content: userMessage }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

async function callGemini(apiKey, model, { systemPrompt, userMessage }) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: userMessage }] }],
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

const ADAPTERS = {
  openai: callOpenAI,
  anthropic: callAnthropic,
  gemini: callGemini,
  deepseek: callDeepSeek,
};

export async function generateReply(mobile, provider, { systemPrompt, userMessage }) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`unknown AI provider "${provider}"`);

  const apiKey = getApiKey(mobile, provider);
  if (!apiKey) throw new Error(`${provider} is not configured for this account`);
  const model = getModel(mobile, provider);

  try {
    return await adapter(apiKey, model, { systemPrompt, userMessage });
  } catch (err) {
    logger.error("AI provider call failed", { provider, model, error: err.message });
    throw err;
  }
}

// Asks the model to read `userMessage` and return only a JSON object with
// exactly the requested keys, so a question node can turn one freeform
// spoken/typed reply into several distinct `answers` entries (e.g. a CRM
// "new lead" flow extracting name/phone/product from a single sentence).
// Returns null (never throws past this point) on missing config, provider
// failure, or a reply that isn't valid parseable JSON - callers fall back
// to storing the raw text so an answer is never silently dropped.
export async function extractFields(mobile, provider, { fields, userMessage }) {
  const adapter = ADAPTERS[provider];
  if (!adapter) return null;

  const apiKey = getApiKey(mobile, provider);
  if (!apiKey) return null;
  const model = getModel(mobile, provider);

  const fieldList = (fields || [])
    .map((f) => `- "${f.name}": ${f.description || "(no description given)"}`)
    .join("\n");
  const systemPrompt =
    "You extract structured data from a WhatsApp message. Read the user's " +
    "message and respond with ONLY a single JSON object (no prose, no code " +
    "fences) containing exactly these keys:\n" +
    fieldList +
    '\n\nIf a field is not mentioned in the message, use an empty string "" ' +
    "as its value. Do not invent information that isn't in the message.";

  try {
    const raw = await adapter(apiKey, model, { systemPrompt, userMessage });
    const jsonText = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    logger.error("AI field extraction failed", { provider, error: err.message });
    return null;
  }
}

export { ADAPTERS };
