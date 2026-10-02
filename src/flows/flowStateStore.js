import path from "path";
import { dataDir } from "../config/paths.js";
import { readJson, writeJsonAtomic, deleteFile, listJsonFiles } from "./fileStore.js";
import logger from "../config/logger.js";

const STATE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const statePath = (sessionId, number) =>
  path.join(dataDir, "flow-state", sessionId.split("-")[0], sessionId, `${number}.json`);

// No Redis TTL here, so expiry is enforced lazily on read: a state file
// older than 24h is treated as gone (and cleaned up) rather than resumed.
export function getState(sessionId, number) {
  const filePath = statePath(sessionId, number);
  const state = readJson(filePath);
  if (!state) return null;

  if (Date.now() - (state.updatedAt || 0) > STATE_TTL_MS) {
    deleteFile(filePath);
    return null;
  }

  return state;
}

export function saveState(sessionId, number, state) {
  writeJsonAtomic(statePath(sessionId, number), { ...state, updatedAt: Date.now() });
}

export function clearState(sessionId, number) {
  deleteFile(statePath(sessionId, number));
}

// Proactive cleanup so a conversation that just went quiet (no more inbound
// messages to trigger the lazy-expiry check in getState) doesn't sit around
// forever - called on a timer from src/index.js.
export function sweepExpiredStates() {
  const files = listJsonFiles(path.join(dataDir, "flow-state"));
  let cleared = 0;

  for (const { path: filePath, data } of files) {
    if (Date.now() - (data.updatedAt || 0) > STATE_TTL_MS) {
      deleteFile(filePath);
      cleared++;
    }
  }

  if (cleared) {
    logger.info("Swept expired flow conversation states", { cleared });
  }

  return cleared;
}
