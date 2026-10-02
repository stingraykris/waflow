// Pulls plain text out of the WhatsApp message shapes we care about
// (used by both the opt-out listener and the flow engine).
export function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    null
  );
}

// Which of the media types flows can collect, if any, is present on this message.
export function extractMediaType(message) {
  if (message?.imageMessage) return "image";
  if (message?.videoMessage) return "video";
  if (message?.documentMessage) return "document";
  if (message?.audioMessage) return "audio";
  return null;
}

// WhatsApp's @lid privacy layer sometimes delivers remoteJid as an opaque
// "linked identifier" instead of the contact's real phone number JID. When
// that happens Baileys still attaches the real number on the message key
// itself (senderPn for a direct chat, participantPn inside a group), so
// prefer that over parsing remoteJid when remoteJid is a @lid.
export function extractNumber(remoteJid, msg) {
  if (remoteJid && remoteJid.endsWith("@lid")) {
    const pn = msg?.key?.senderPn || msg?.key?.participantPn;
    if (pn) return pn.split("@")[0];
  }
  return (remoteJid || "").split("@")[0];
}
