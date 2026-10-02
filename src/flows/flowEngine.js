import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import logger from "../config/logger.js";
import { dataDir } from "../config/paths.js";
import { numberToJid } from "../utils/helpers.js";
import { isOptedOut } from "../moderation/blocklistStore.js";
import { extractMediaType } from "../moderation/messageText.js";
import { generateReply, extractFields } from "../ai/providers.js";
import { getActiveFlows, getFlow } from "./flowStore.js";
import { getState, saveState, clearState } from "./flowStateStore.js";
import { logCompletion } from "./flowResponseStore.js";
import { dispatch } from "../webhooks/dispatcher.js";

const MAX_RETRIES = 3;

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
};

// Only matches {identifier} / {dotted.path} placeholders - not any {...}
// span - so this is safe to run over JSON request/response bodies where
// the surrounding braces are JSON syntax, not placeholders.
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_.]+)\}/g;

function renderText(text, answers) {
  return (text || "").replace(PLACEHOLDER_RE, (_, k) => {
    const v = answers[k];
    if (v && typeof v === "object") return v.path ? `[${v.type}]` : "";
    return k in answers ? v : "";
  });
}

// Same {key} substitution as renderText, plus a one-level dot-path lookup
// into the API Call node's response body via {response.someField} so a
// reply template can quote back whatever the CRM/ERP just returned.
function renderApiTemplate(text, answers, responseData) {
  return (text || "").replace(PLACEHOLDER_RE, (match, k) => {
    if (k.startsWith("response.")) {
      const path = k.slice("response.".length).split(".");
      let v = responseData;
      for (const segment of path) {
        if (v == null) break;
        v = v[segment];
      }
      return v == null ? "" : String(v);
    }
    const v = answers[k];
    if (v && typeof v === "object") return v.path ? `[${v.type}]` : "";
    return k in answers ? v : "";
  });
}

// For every media answer (an {type, path} object - a downloaded photo,
// document, or voice note), adds {thatKey.base64} and {thatKey.mimetype}
// to a copy of `answers` so a JSON body can embed the file's raw bytes
// directly, e.g. {"voice_note":"{voice_note.base64}"}. Left out of the
// plain answers object itself so message/menu text (which never wants a
// multi-KB base64 blob dropped into a chat bubble) is unaffected.
async function withMediaBase64(answers) {
  const out = { ...answers };
  for (const [key, val] of Object.entries(answers)) {
    if (val && typeof val === "object" && val.path) {
      try {
        const buf = await fs.readFile(val.path);
        out[`${key}.base64`] = buf.toString("base64");
        out[`${key}.mimetype`] = val.mimetype || "";
      } catch (err) {
        logger.error("Failed to read media file for API body", { key, error: err.message });
        out[`${key}.base64`] = "";
      }
    }
  }
  return out;
}

// Header names likely to carry a secret (API key, bearer token, session
// cookie) - masked before the request ever gets written into a trace that
// the flow log page/CSV export can show, so debugging a CRM integration
// never means leaking that CRM's credential back out over WAFLOW's UI.
const SENSITIVE_HEADER_RE = /auth|api[-_]?key|token|cookie|secret/i;

function maskSecret(value) {
  if (!value || value.length <= 8) return "****";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function maskHeadersForTrace(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? maskSecret(v) : v;
  }
  return out;
}

// Calls the node's configured external API (the user's CRM/ERP), with the
// URL/headers/body all templated against the flow's answers so far. Never
// throws - callers branch on `ok` and show a fallback message instead.
// Also returns exactly what was sent/received (headers pre-masked) so the
// flow log can show the real payload and response for this step.
async function callApi(node, answers) {
  const url = renderText(node.url, answers);
  const headers = {};
  for (const h of node.headers || []) {
    if (h.key) headers[h.key] = renderText(h.value, answers);
  }
  const hasBody = node.body && !["GET", "DELETE"].includes(node.method);
  if (hasBody && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const request = { method: node.method || "GET", url, headers: maskHeadersForTrace(headers) };

  try {
    const bodyAnswers = hasBody ? await withMediaBase64(answers) : answers;
    const body = hasBody ? renderText(node.body, bodyAnswers) : undefined;
    request.body = body || null;

    const res = await fetch(url, {
      method: node.method || "GET",
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });

    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = raw;
    }

    return { ok: res.ok, data, request, response: { status: res.status, body: data } };
  } catch (err) {
    logger.error("API call node failed", { url, error: err.message });
    return { ok: false, data: null, request, response: { error: err.message } };
  }
}

// Builds the Baileys send payload for a node: plain text, or
// image/video/document with an optional caption when node.media is set.
function buildContent(node, text) {
  const media = node.media;
  if (!media?.path) return { text };

  if (media.type === "image") return { image: { url: media.path }, caption: text || undefined };
  if (media.type === "video") return { video: { url: media.path }, caption: text || undefined };
  if (media.type === "document") {
    return {
      document: { url: media.path },
      fileName: media.filename || path.basename(media.path),
      caption: text || undefined,
    };
  }
  return { text };
}

async function send(sock, jid, node, text, sessionId) {
  const content = buildContent(node, text);
  await sock.sendMessage(jid, content).catch((err) =>
    logger.error("Flow send failed", { sessionId, error: err.message }),
  );
}

function logAndClear(ctx, flow, answers, status = "completed", trace = []) {
  const completedAt = Date.now();
  logCompletion(ctx.ownerMobile, ctx.sessionId, ctx.number, {
    number: ctx.number,
    flowName: flow.name,
    sessionId: ctx.sessionId,
    status,
    answers,
    trace,
    // The first trace entry's timestamp is when this conversation actually
    // started (the trigger message) - trace always has at least one entry
    // by the time a flow completes, since every code path that reaches
    // logAndClear has already traced the node it just finished on.
    startedAt: trace[0]?.at || completedAt,
    steps: trace.length,
    completedAt,
  });
  dispatch(ctx.ownerMobile, "flowCompleted", { flowName: flow.name, number: ctx.number, answers, status });
  clearState(ctx.sessionId, ctx.number);
}

// One entry per node visited, in order - what came in, what went out, and
// for an API Call node the exact request/response - so the flow log can
// show a full step-by-step trace of a conversation, not just its final
// answers. Threaded through runFrom/handleInboundMessage as a plain array
// and persisted on saved state (state.trace) across separate inbound
// messages, since one conversation spans many separate function calls.
function traced(trace, entry) {
  return [...trace, { at: Date.now(), ...entry }];
}

// Calls the node's configured AI provider with the latest inbound text and
// sends the reply. Returns { ok: false } (having already sent a graceful
// fallback message) if the provider isn't configured or the call fails, so
// callers can end the flow instead of leaving the contact hanging - and
// { ok: true, replyText } on success so the caller can trace what was sent.
async function sendAiReply(sock, ctx, node, inboundText) {
  try {
    const replyText = await generateReply(ctx.ownerMobile, node.provider, {
      systemPrompt: node.systemPrompt,
      userMessage: inboundText || "",
    });
    await sock.sendMessage(ctx.jid, { text: replyText }).catch((err) =>
      logger.error("Flow send failed", { sessionId: ctx.sessionId, error: err.message }),
    );
    return { ok: true, replyText };
  } catch (err) {
    logger.error("AI node failed", { sessionId: ctx.sessionId, provider: node.provider, error: err.message });
    await sock
      .sendMessage(ctx.jid, { text: "Sorry, I'm having trouble responding right now." })
      .catch(() => {});
    return { ok: false, error: err.message };
  }
}

// Sends node content, then either waits (menu/question/ai), cascades to
// the next node (message), or logs + clears state (end). `inboundText` is
// the most recent thing the contact said/sent - only "ai" nodes use it,
// everything else ignores the parameter. `trace` accumulates one entry per
// node visited across the whole conversation (see `traced()` above).
async function runFrom(sock, ctx, flow, nodeId, answers, inboundText, trace = []) {
  const node = flow.nodes?.[nodeId];
  if (!node) {
    clearState(ctx.sessionId, ctx.number);
    return;
  }

  if (node.type === "ai") {
    const result = await sendAiReply(sock, ctx, node, inboundText);
    const newTrace = traced(trace, {
      nodeId,
      type: "ai",
      provider: node.provider,
      input: inboundText || "",
      output: result.replyText || null,
      error: result.error || null,
    });
    if (!result.ok) {
      logAndClear(ctx, flow, answers, "ai_failed", newTrace);
      return;
    }
    saveState(ctx.sessionId, ctx.number, {
      flowId: flow.id,
      currentNodeId: nodeId,
      answers,
      trace: newTrace,
      retries: 0,
    });
    return;
  }

  if (node.type === "api") {
    // The contact's phone number is always available to API/reply templates
    // as {number}, without needing a question node to explicitly ask for it -
    // it's already known from the WhatsApp message itself.
    const withNumber = { ...answers, number: ctx.number };
    const { ok, data, request, response } = await callApi(node, withNumber);

    if (!ok) {
      await sock
        .sendMessage(ctx.jid, {
          text: node.failureMessage || "Sorry, something went wrong. Please try again later.",
        })
        .catch(() => {});
      const newTrace = traced(trace, { nodeId, type: "api", request, response, output: null });
      logAndClear(ctx, flow, answers, "api_failed", newTrace);
      return;
    }

    const merged = node.saveResponseAs ? { ...answers, [node.saveResponseAs]: data } : answers;
    const replyText = renderApiTemplate(node.replyTemplate, { ...merged, number: ctx.number }, data);
    if (replyText) await send(sock, ctx.jid, node, replyText, ctx.sessionId);

    const newTrace = traced(trace, { nodeId, type: "api", request, response, output: replyText || null });

    if (!node.nextNodeId) {
      logAndClear(ctx, flow, merged, "completed", newTrace);
      return;
    }
    return runFrom(sock, ctx, flow, node.nextNodeId, merged, inboundText, newTrace);
  }

  const text = renderText(node.text, { ...answers, number: ctx.number });
  if (text || node.media?.path) {
    await send(sock, ctx.jid, node, text, ctx.sessionId);
  }

  if (node.type === "message") {
    const newTrace = traced(trace, { nodeId, type: "message", output: text || null, media: node.media || null });
    if (!node.nextNodeId) {
      logAndClear(ctx, flow, answers, "completed", newTrace);
      return;
    }
    return runFrom(sock, ctx, flow, node.nextNodeId, answers, inboundText, newTrace);
  }

  if (node.type === "end") {
    const newTrace = traced(trace, { nodeId, type: "end", output: text || null });
    logAndClear(ctx, flow, answers, "completed", newTrace);
    return;
  }

  if (node.type === "menu" || node.type === "question") {
    const newTrace = traced(trace, { nodeId, type: node.type, output: text || null, media: node.media || null });
    saveState(ctx.sessionId, ctx.number, {
      flowId: flow.id,
      currentNodeId: nodeId,
      answers,
      trace: newTrace,
      retries: 0,
    });
    return;
  }

  logger.warn("Unknown flow node type", { sessionId: ctx.sessionId, nodeId, type: node.type });
  clearState(ctx.sessionId, ctx.number);
}

async function downloadAnswerMedia(sock, msg, mediaType, ctx) {
  const buffer = await downloadMediaMessage(
    msg,
    "buffer",
    {},
    { logger, reuploadRequest: sock.updateMediaMessage },
  );

  const mimetype = msg.message?.[`${mediaType}Message`]?.mimetype;
  const ext =
    mediaType === "audio"
      ? mimetype?.includes("ogg")
        ? "ogg"
        : "m4a"
      : MIME_EXT[mimetype] || (mediaType === "document" ? "bin" : "jpg");
  const fileName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(
    dataDir,
    "flow-media",
    ctx.ownerMobile,
    "received",
    ctx.sessionId,
    ctx.number,
    fileName,
  );

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);

  return { type: mediaType, path: filePath, mimetype };
}

export async function handleInboundMessage(sock, sessionId, number, text, remoteJid, msg) {
  const ownerMobile = sessionId.split("-")[0];
  const ctx = { sessionId, number, ownerMobile, jid: remoteJid || numberToJid(number) };

  if (await isOptedOut(ownerMobile, number)) return;
  if (text.trim().toUpperCase() === "STOP") return; // opt-out listener owns this

  const state = getState(sessionId, number);

  if (!state) {
    const activeFlows = await getActiveFlows(ownerMobile);
    if (!activeFlows.length) return;

    const normalizedText = text.trim().toLowerCase();
    const matched = activeFlows.find((f) =>
      (f.triggerKeywords || []).some((k) => k.trim().toLowerCase() === normalizedText),
    );
    // No keyword match - fall back to a catch-all flow (no keywords at all),
    // if one is active. activateFlow() guarantees at most one such flow.
    const flow = matched || activeFlows.find((f) => !(f.triggerKeywords || []).length);
    if (!flow) return;

    return runFrom(sock, ctx, flow, flow.startNodeId, {}, text);
  }

  const flow = await getFlow(ownerMobile, state.flowId);
  if (!flow) {
    clearState(sessionId, number);
    return;
  }

  const node = flow.nodes?.[state.currentNodeId];
  if (!node) {
    clearState(sessionId, number);
    return;
  }

  const trace = state.trace || [];

  if (node.type === "ai") {
    const result = await sendAiReply(sock, ctx, node, text);
    const newTrace = traced(trace, {
      nodeId: state.currentNodeId,
      type: "ai",
      provider: node.provider,
      input: text,
      output: result.replyText || null,
      error: result.error || null,
    });
    if (!result.ok || !node.nextNodeId) {
      logAndClear(ctx, flow, state.answers, result.ok ? "completed" : "ai_failed", newTrace);
      return;
    }
    if (node.nextNodeId === state.currentNodeId) {
      saveState(sessionId, number, { ...state, trace: newTrace, retries: 0 });
      return;
    }
    return runFrom(sock, ctx, flow, node.nextNodeId, state.answers, text, newTrace);
  }

  if (node.type === "question") {
    // Audio normally never reaches here as media - inboundFlowListener.js
    // transcribes voice notes into `text` before flows ever see them, so a
    // successfully transcribed voice note is indistinguishable from typed
    // text below. The one exception is audioMode "file": the listener
    // skips transcription entirely for that node, so the raw voice note
    // still needs downloading here, same as image/video/document.
    const mediaType = msg ? extractMediaType(msg.message) : null;

    if (node.acceptMedia && mediaType === "audio" && node.audioMode === "file") {
      const media = await downloadAnswerMedia(sock, msg, "audio", ctx);
      const answers = { ...state.answers, [node.saveAs]: media };
      const newTrace = traced(trace, { nodeId: state.currentNodeId, type: "question", input: null, media, savedAs: node.saveAs });
      return runFrom(sock, ctx, flow, node.nextNodeId, answers, text, newTrace);
    }

    if (node.acceptMedia && mediaType && mediaType !== "audio") {
      const media = await downloadAnswerMedia(sock, msg, mediaType, ctx);
      const answers = { ...state.answers, [node.saveAs]: media };
      const newTrace = traced(trace, { nodeId: state.currentNodeId, type: "question", input: null, media, savedAs: node.saveAs });
      return runFrom(sock, ctx, flow, node.nextNodeId, answers, text, newTrace);
    }

    if (node.acceptMedia && !text.trim()) {
      // No media, or a voice note that failed to transcribe upstream.
      await sock
        .sendMessage(ctx.jid, { text: "Please send a photo, document, or voice note to continue." })
        .catch(() => {});
      return;
    }

    if (node.aiExtract?.fields?.length) {
      const extracted = await extractFields(ctx.ownerMobile, node.aiExtract.provider, {
        fields: node.aiExtract.fields,
        userMessage: text.trim(),
      });
      const answers = extracted
        ? { ...state.answers, ...extracted }
        : { ...state.answers, [node.saveAs || `${state.currentNodeId}_raw`]: text.trim() };
      const newTrace = traced(trace, {
        nodeId: state.currentNodeId,
        type: "question",
        input: text,
        aiExtracted: extracted || null,
        savedAs: extracted ? Object.keys(extracted) : node.saveAs || `${state.currentNodeId}_raw`,
      });
      return runFrom(sock, ctx, flow, node.nextNodeId, answers, text, newTrace);
    }

    const answers = { ...state.answers, [node.saveAs]: text.trim() };
    const newTrace = traced(trace, { nodeId: state.currentNodeId, type: "question", input: text, savedAs: node.saveAs });
    return runFrom(sock, ctx, flow, node.nextNodeId, answers, text, newTrace);
  }

  if (node.type === "menu") {
    const reply = text.trim().toLowerCase();
    const option = (node.options || []).find((o) => o.value.trim().toLowerCase() === reply);

    if (option) {
      const newTrace = traced(trace, { nodeId: state.currentNodeId, type: "menu", input: text, matchedOption: option.value });
      return runFrom(sock, ctx, flow, option.nextNodeId, state.answers, text, newTrace);
    }

    const retries = (state.retries || 0) + 1;
    if (retries >= MAX_RETRIES) {
      const newTrace = traced(trace, { nodeId: state.currentNodeId, type: "menu", input: text, matchedOption: null, retries });
      logAndClear(ctx, flow, state.answers, "abandoned_retries", newTrace);
      await sock
        .sendMessage(ctx.jid, { text: "Too many invalid replies. Ending this conversation." })
        .catch(() => {});
      return;
    }

    await sock
      .sendMessage(ctx.jid, { text: `Sorry, I didn't understand that.\n${renderText(node.text, { ...state.answers, number: ctx.number })}` })
      .catch(() => {});
    const newTrace = traced(trace, { nodeId: state.currentNodeId, type: "menu", input: text, matchedOption: null, retries });
    saveState(sessionId, number, { ...state, trace: newTrace, retries });
    return;
  }

  // Somehow landed on a non-waiting node with saved state - just cascade from here.
  return runFrom(sock, ctx, flow, state.currentNodeId, state.answers, text, trace);
}
