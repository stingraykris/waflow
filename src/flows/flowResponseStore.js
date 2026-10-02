import crypto from "crypto";
import path from "path";
import { dataDir } from "../config/paths.js";
import { writeJsonAtomic, listJsonFiles } from "./fileStore.js";

const responsesDir = (mobile, sessionId, number) =>
  path.join(dataDir, "flow-responses", mobile, sessionId, number);

export function logCompletion(mobile, sessionId, number, entry) {
  const fileName = `${Date.now()}-${crypto.randomUUID()}.json`;
  writeJsonAtomic(path.join(responsesDir(mobile, sessionId, number), fileName), entry);
}

export function listResponses(mobile, { flowName, number, from, to, page = 0, pageSize = 20 } = {}) {
  let entries = listJsonFiles(path.join(dataDir, "flow-responses", mobile))
    .map((f) => f.data)
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, 2000); // hard cap on how much history we'll ever scan/filter

  if (flowName) {
    entries = entries.filter((e) => e.flowName === flowName);
  }
  if (number) {
    entries = entries.filter((e) => e.number.includes(number));
  }
  if (from) {
    const fromMs = new Date(from).getTime();
    if (!Number.isNaN(fromMs)) entries = entries.filter((e) => e.completedAt >= fromMs);
  }
  if (to) {
    const toMs = new Date(to).getTime();
    if (!Number.isNaN(toMs)) entries = entries.filter((e) => e.completedAt <= toMs);
  }

  const total = entries.length;
  const start = page * pageSize;
  const paged = entries.slice(start, start + pageSize);

  return { entries: paged, total };
}
