import crypto from "crypto";
import path from "path";
import { dataDir } from "../config/paths.js";
import { readJson, writeJsonAtomic, deleteFile, listJsonFiles } from "./fileStore.js";

const flowsDir = (ownerMobile) => path.join(dataDir, "flows", ownerMobile);
const flowPath = (ownerMobile, id) => path.join(flowsDir(ownerMobile), `${id}.json`);

export async function listFlows(ownerMobile) {
  return listJsonFiles(flowsDir(ownerMobile))
    .map((f) => f.data)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getFlow(ownerMobile, id) {
  return readJson(flowPath(ownerMobile, id));
}

export async function getActiveFlows(ownerMobile) {
  const flows = await listFlows(ownerMobile);
  return flows.filter((f) => f.isActive);
}

export async function createFlow(ownerMobile, { name, triggerKeywords, startNodeId, nodes }) {
  const id = crypto.randomUUID();
  const flow = {
    id,
    name,
    isActive: false,
    triggerKeywords: triggerKeywords || [],
    startNodeId,
    nodes,
    createdAt: Date.now(),
  };
  writeJsonAtomic(flowPath(ownerMobile, id), flow);
  return flow;
}

export async function updateFlow(ownerMobile, id, { name, triggerKeywords, startNodeId, nodes }) {
  const existing = await getFlow(ownerMobile, id);
  if (!existing) throw new Error("flow not found");

  const updated = {
    ...existing,
    name,
    triggerKeywords: triggerKeywords || [],
    startNodeId,
    nodes,
  };
  writeJsonAtomic(flowPath(ownerMobile, id), updated);
  return updated;
}

export async function deleteFlow(ownerMobile, id) {
  deleteFile(flowPath(ownerMobile, id));
}

// Multiple flows can be active at once, each triggered by its own keyword(s)
// - but two active flows can't claim the same keyword (or both be
// catch-alls with no keywords at all), since that's ambiguous about which
// one should respond.
export async function activateFlow(ownerMobile, id) {
  const flows = await listFlows(ownerMobile);
  const target = flows.find((f) => f.id === id);
  if (!target) throw new Error("flow not found");

  const others = flows.filter((f) => f.id !== id && f.isActive);
  const targetKeywords = (target.triggerKeywords || []).map((k) => k.trim().toLowerCase());

  for (const other of others) {
    const otherKeywords = (other.triggerKeywords || []).map((k) => k.trim().toLowerCase());

    if (!targetKeywords.length && !otherKeywords.length) {
      const err = new Error(`"${other.name}" is already active with no trigger keywords (catch-all) - only one catch-all flow can be active at a time`);
      err.conflict = true;
      throw err;
    }

    const shared = targetKeywords.filter((k) => otherKeywords.includes(k));
    if (shared.length) {
      const err = new Error(`"${other.name}" is already active using the same keyword(s): ${shared.join(", ")}`);
      err.conflict = true;
      throw err;
    }
  }

  target.isActive = true;
  writeJsonAtomic(flowPath(ownerMobile, id), target);
  return target;
}

export async function deactivateFlow(ownerMobile, id) {
  const flow = await getFlow(ownerMobile, id);
  if (!flow) throw new Error("flow not found");

  flow.isActive = false;
  writeJsonAtomic(flowPath(ownerMobile, id), flow);
  return flow;
}
