import crypto from "crypto";

export function traceId() {
  return crypto.randomBytes(6).toString("hex");
}

export function buildSessionId(user, id) {
  return `${user.mobile}-${id}`;
}

export function formatNumber(number, country) {
  const sanitized = number.toString().replace(/\D/g, "");

  if (sanitized.startsWith(country)) return sanitized;

  return `${country}${sanitized.slice(-10)}`;
}

// Never let a caller (manual send, CSV, public API) request a sub-4s delay -
// per anti-ban research, ~4.7s average human-like spacing is the
// community-tested safe floor; a 0ms/near-0ms delay is an unambiguous bot
// signal regardless of what caps/business-hours settings are in place.
export const MIN_DELAY_MS = 4000;

export function getDelay(i, userDelay = 4000) {
  const safeDelay = Math.max(userDelay, MIN_DELAY_MS);
  const jitter = Math.floor(Math.random() * 3000);
  // i * step would make the *first* message (i=0) fire with 0 delay,
  // skipping the floor entirely - always add one safeDelay so even the
  // first send in a batch waits at least MIN_DELAY_MS.
  return i * (safeDelay + jitter) + MIN_DELAY_MS;
}

export function numberToJid(number) {
  return `${number}@s.whatsapp.net`;
}

// Returns a BullMQ-compatible delay (ms, >=0) from either an explicit
// scheduleAt (ISO datetime) or the old jittered per-row delay.
export function resolveDelay(index, userDelay, scheduleAt) {
  if (scheduleAt) {
    const target = new Date(scheduleAt).getTime();
    if (!Number.isNaN(target)) {
      return Math.max(0, target - Date.now());
    }
  }
  return getDelay(index, userDelay);
}
