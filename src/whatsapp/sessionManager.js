import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import { useRedisAuthState, clearRedisAuthState } from "./authState.js";
import { attachDeliveryTracking } from "../delivery/tracker.js";
import { attachOptOutListener } from "../moderation/inboundOptOut.js";
import { attachFlowListener } from "../flows/inboundFlowListener.js";
import { attachHealthTracker } from "../safety/healthTracker.js";
import { ensureSettingsFile } from "../safety/safetyLimiter.js";
import logger from "../config/logger.js";
import { getQueue } from "../queue/queue.js";

// In-memory registry of live socket connections for this process, mirroring
// the old app's `Sessions` object. The durable bit (creds/keys) lives in
// Redis via authState.js so a restart doesn't force a re-scan of the QR code.
export const Sessions = {};

const waLogger = pino({ level: "silent" });
const bannedSessions = new Set();

// Disconnect codes that mean "this session is permanently dead" - don't
// reconnect, tear it down instead. Everything else (including 515
// restartRequired, which Baileys throws right after a QR scan as part of
// normal pairing) should trigger a reconnect using the same persisted creds.
const NON_RECOVERABLE_CODES = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
]);

export function markBanned(sessionId) {
  bannedSessions.add(sessionId);
}

export function isBanned(sessionId) {
  return bannedSessions.has(sessionId);
}

export async function createSession(sessionId, { onQr, onReady } = {}) {
  if (Sessions[sessionId]) return Sessions[sessionId];

  const entry = { sock: null, ready: false, createdAt: Date.now(), onQr, onReady };
  Sessions[sessionId] = entry;

  await connectSocket(sessionId, entry);

  return entry;
}

async function connectSocket(sessionId, entry) {
  const { state, saveCreds } = await useRedisAuthState(sessionId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, waLogger),
    },
    logger: waLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  entry.sock = sock;

  sock.ev.on("creds.update", saveCreds);
  attachDeliveryTracking(sock, sessionId);
  attachOptOutListener(sock, sessionId);
  attachFlowListener(sock, sessionId);
  attachHealthTracker(sock, sessionId);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("QR generated", { sessionId });
      entry.onQr?.(qr);
    }

    if (connection === "open") {
      entry.ready = true;
      ensureSettingsFile(sessionId.split("-")[0], sessionId);
      logger.info("Client ready", { sessionId });
      entry.onReady?.();
    }

    if (connection === "close") {
      entry.ready = false;
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined;

      // No longer tracked (deliberately deleted) -> nothing to do.
      if (!Sessions[sessionId]) return;

      if (statusCode === DisconnectReason.forbidden) {
        logger.warn("Session forbidden by WhatsApp -> banning", { sessionId });
        markBanned(sessionId);
        await destroySession(sessionId);
        return;
      }

      if (NON_RECOVERABLE_CODES.has(statusCode)) {
        logger.warn("Non-recoverable disconnect -> destroying session", {
          sessionId,
          statusCode,
        });
        await destroySession(sessionId);
        return;
      }

      logger.info("Reconnecting session", { sessionId, statusCode });
      setTimeout(() => {
        if (Sessions[sessionId]) {
          connectSocket(sessionId, entry).catch((err) =>
            logger.error("Reconnect failed", { sessionId, error: err.message }),
          );
        }
      }, 2000);
    }
  });
}

export function getSession(sessionId) {
  return Sessions[sessionId];
}

export async function destroySession(sessionId) {
  const entry = Sessions[sessionId];
  delete Sessions[sessionId]; // stop any pending reconnect immediately

  const queue = getQueue();
  const jobs = await queue.getJobs(["waiting", "active", "delayed"], 0, 5000);
  for (const job of jobs) {
    if (job.data.sessionId === sessionId) {
      await job.remove().catch(() => {});
    }
  }

  if (entry?.sock) {
    try {
      await entry.sock.logout();
    } catch (e) {
      logger.warn("Session logout failed", { sessionId, error: e.message });
    }
    try {
      entry.sock.end(undefined);
    } catch {
      // socket already closed
    }
  }

  await clearRedisAuthState(sessionId);

  logger.info("Session destroyed", { sessionId });
}
