import { downloadMediaMessage } from "@whiskeysockets/baileys";
import logger from "../config/logger.js";
import { getApiKey, getModel } from "./aiSettingsStore.js";

async function transcribeWithOpenAI(apiKey, buffer, mimetype) {
  const ext = mimetype?.includes("ogg") ? "ogg" : "m4a";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimetype || "audio/ogg" }), `voice.${ext}`);
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Whisper transcription failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.text?.trim() || "";
}

async function transcribeWithGemini(apiKey, model, buffer, mimetype) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  "Provide a highly accurate, word-for-word transcription of this audio. " +
                  "Break it down into clean paragraphs. Do not add summaries or commentary.",
              },
              { inlineData: { mimeType: mimetype || "audio/ogg", data: buffer.toString("base64") } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini transcription failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

// Downloads an inbound voice note and transcribes it via whichever
// capable provider the account has configured (OpenAI Whisper preferred,
// Gemini as a fallback since it accepts audio natively). Returns null
// (not a throw) if no transcription-capable provider is set up, so
// callers can just fall back to their normal no-text-message handling.
export async function transcribeAudio(mobile, sock, msg) {
  const openaiKey = getApiKey(mobile, "openai");
  const geminiKey = getApiKey(mobile, "gemini");
  if (!openaiKey && !geminiKey) return null;

  let buffer;
  try {
    buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
  } catch (err) {
    logger.error("Failed to download voice note", { error: err.message });
    return null;
  }

  const mimetype = msg.message?.audioMessage?.mimetype;

  try {
    if (openaiKey) return await transcribeWithOpenAI(openaiKey, buffer, mimetype);
    return await transcribeWithGemini(geminiKey, getModel(mobile, "gemini"), buffer, mimetype);
  } catch (err) {
    logger.error("Audio transcription failed", { error: err.message });
    return null;
  }
}
