import { extractText, extractMediaType, extractNumber } from "../moderation/messageText.js";
import { transcribeAudio } from "../ai/transcription.js";
import { handleInboundMessage } from "./flowEngine.js";
import { getState } from "./flowStateStore.js";
import { getFlow } from "./flowStore.js";
import { dispatch } from "../webhooks/dispatcher.js";
import logger from "../config/logger.js";

// A question node with "Accept media" + audioMode "file" wants the raw
// voice note kept as a file, not transcribed - so skip the (paid, costs
// time) transcription call entirely for that one case. Every other case
// (no active state / a different node / transcribe mode) transcribes as
// normal, since trigger matching and text-based questions need the text.
async function wantsRawAudioFile(ownerMobile, sessionId, number) {
  const state = getState(sessionId, number);
  if (!state) return false;
  const flow = await getFlow(ownerMobile, state.flowId);
  const node = flow?.nodes?.[state.currentNodeId];
  return !!(node?.type === "question" && node.acceptMedia && node.audioMode === "file");
}

export function attachFlowListener(sock, sessionId) {
  const ownerMobile = sessionId.split("-")[0];

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid || remoteJid.endsWith("@g.us")) continue;
        if (msg.key?.fromMe) continue;

        let text = extractText(msg.message);
        const mediaType = extractMediaType(msg.message);
        const number = extractNumber(remoteJid, msg);

        // Transcribe once, here, before anything else touches the message -
        // this is what lets a voice note both trigger a flow and answer a
        // question node identically to typed text (flowEngine.js never
        // needs to know the text came from audio) - unless the node
        // currently waiting on this contact wants the raw file instead.
        if (!text && mediaType === "audio" && !(await wantsRawAudioFile(ownerMobile, sessionId, number))) {
          text = await transcribeAudio(ownerMobile, sock, msg);
        }

        // A media reply to a "question" node often has no caption at all -
        // don't drop it just because there's no text.
        if (!text && !mediaType) continue;

        dispatch(ownerMobile, "messageReceived", { sessionId, number, text: text || null, mediaType });
        await handleInboundMessage(sock, sessionId, number, text || "", remoteJid, msg);
      } catch (err) {
        logger.error("Flow handling failed", { sessionId, error: err.message });
      }
    }
  });
}
