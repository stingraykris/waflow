import fs from "fs";
import { numberToJid } from "../utils/helpers.js";

// Sends a text or image+caption message via an active Baileys socket and
// returns the WhatsApp message key (used for delivery status tracking).
export async function sendViaSocket(sock, number, message, filePath) {
  const jid = numberToJid(number);

  let content;
  if (filePath && fs.existsSync(filePath)) {
    content = { image: { url: filePath }, caption: message };
  } else {
    content = { text: message };
  }

  const result = await sock.sendMessage(jid, content);
  const messageId = result?.key?.id;

  // sock.sendMessage() can resolve without throwing yet still not actually
  // hand the message to WhatsApp (a socket that looks open but is being
  // silently rejected server-side - e.g. a flagged/restricted account).
  // Treat a missing message id as a failed send instead of letting the
  // caller mark the job "completed" with nothing sent.
  if (!messageId) {
    throw new Error("WhatsApp send did not return a message id");
  }

  return messageId;
}

export async function isNumberRegistered(sock, number) {
  const jid = numberToJid(number);
  const [result] = await sock.onWhatsApp(jid);
  return !!result?.exists;
}
