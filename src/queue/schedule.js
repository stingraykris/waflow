import { resolveDelay } from "../utils/helpers.js";

// Shared job-options builder for every send path (manual, CSV, API), so
// scheduling behaves identically everywhere: immediate jittered delay by
// default, or a fixed delay computed from `scheduleAt` when provided.
export function buildJobOptions(index, userDelay, scheduleAt) {
  return {
    delay: resolveDelay(index, userDelay, scheduleAt),
    attempts: 5,
    backoff: { type: "fixed", delay: 25000 },
  };
}
