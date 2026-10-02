import path from "path";
import redis from "../config/redis.js";
import { dataDir } from "../config/paths.js";
import { readJson, writeJsonAtomic } from "../flows/fileStore.js";

// 7-day warm-up ramp, based on community-tested Baileys anti-ban practice
// (see plan notes) - new sessions start conservative and step up over their
// first week. Day 7+ lands on the default cap, itself still well under the
// ~12 msgs/min ceiling that's been stress-tested without bans - this app
// targets small-business automation, not bulk sending.
const WARMUP_STAGES = [
  { maxDay: 1, dailyCap: 20, hourlyCap: 5 },
  { maxDay: 3, dailyCap: 50, hourlyCap: 10 },
  { maxDay: 6, dailyCap: 100, hourlyCap: 15 },
];
const DEFAULT_CAP = { dailyCap: 200, hourlyCap: 25 };

const settingsPath = (mobile, sessionId) =>
  path.join(dataDir, "session-safety", mobile, `${sessionId}.json`);

function loadSettings(mobile, sessionId) {
  return (
    readJson(settingsPath(mobile, sessionId)) || {
      firstReadyAt: Date.now(),
      dailyCapOverride: null,
      hourlyCapOverride: null,
      businessHours: { enabled: false, startHour: 9, endHour: 20 },
    }
  );
}

// Only creates the file if one doesn't already exist, so a reconnect never
// resets the warm-up clock.
export function ensureSettingsFile(mobile, sessionId) {
  const existing = readJson(settingsPath(mobile, sessionId));
  if (existing) return existing;

  const settings = {
    firstReadyAt: Date.now(),
    dailyCapOverride: null,
    hourlyCapOverride: null,
    businessHours: { enabled: false, startHour: 9, endHour: 20 },
  };
  writeJsonAtomic(settingsPath(mobile, sessionId), settings);
  return settings;
}

export function updateSettings(mobile, sessionId, { dailyCapOverride, hourlyCapOverride, businessHours }) {
  const settings = loadSettings(mobile, sessionId);
  if (dailyCapOverride !== undefined) settings.dailyCapOverride = dailyCapOverride;
  if (hourlyCapOverride !== undefined) settings.hourlyCapOverride = hourlyCapOverride;
  if (businessHours !== undefined) settings.businessHours = businessHours;
  writeJsonAtomic(settingsPath(mobile, sessionId), settings);
  return settings;
}

export function getWarmupDay(firstReadyAt) {
  return Math.floor((Date.now() - firstReadyAt) / (24 * 60 * 60 * 1000));
}

function warmupDefaultCaps(day) {
  const stage = WARMUP_STAGES.find((s) => day <= s.maxDay);
  return stage ? { dailyCap: stage.dailyCap, hourlyCap: stage.hourlyCap } : DEFAULT_CAP;
}

export function getCaps(mobile, sessionId) {
  const settings = loadSettings(mobile, sessionId);
  const day = getWarmupDay(settings.firstReadyAt);
  const defaults = warmupDefaultCaps(day);

  return {
    dailyCap: settings.dailyCapOverride ?? defaults.dailyCap,
    hourlyCap: settings.hourlyCapOverride ?? defaults.hourlyCap,
    warmupDay: day,
    isWarmingUp: day <= 6 && !settings.dailyCapOverride && !settings.hourlyCapOverride,
  };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateParts(d = new Date()) {
  return { y: d.getFullYear(), m: pad(d.getMonth() + 1), day: pad(d.getDate()), h: pad(d.getHours()) };
}

function hourKey(sessionId) {
  const { y, m, day, h } = dateParts();
  return `safety:hour:${sessionId}:${y}-${m}-${day}T${h}`;
}

function dayKey(sessionId) {
  const { y, m, day } = dateParts();
  return `safety:day:${sessionId}:${y}-${m}-${day}`;
}

function nextHourBoundary() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

function nextDayBoundary() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Atomically checks the session's hour/day counts against its caps; if
// under both, reserves a slot (increments both counters) and allows the
// send. Otherwise reports when the blocking window resets.
export async function checkAndReserve(mobile, sessionId) {
  const caps = getCaps(mobile, sessionId);
  const hKey = hourKey(sessionId);
  const dKey = dayKey(sessionId);

  const [hourCount, dayCount] = await Promise.all([redis.get(hKey), redis.get(dKey)]);
  const hour = Number(hourCount) || 0;
  const day = Number(dayCount) || 0;

  if (hour >= caps.hourlyCap) {
    return { allowed: false, reason: "hourly_cap", retryAt: nextHourBoundary() };
  }
  if (day >= caps.dailyCap) {
    return { allowed: false, reason: "daily_cap", retryAt: nextDayBoundary() };
  }

  await redis
    .multi()
    .incr(hKey)
    .expire(hKey, 3700)
    .incr(dKey)
    .expire(dKey, 90000)
    .exec();

  return { allowed: true };
}

export function isWithinBusinessHours(mobile, sessionId) {
  const settings = loadSettings(mobile, sessionId);
  const bh = settings.businessHours;
  if (!bh?.enabled) return { allowed: true };

  const now = new Date();
  const hour = now.getHours();

  if (hour >= bh.startHour && hour < bh.endHour) {
    return { allowed: true };
  }

  const next = new Date();
  if (hour >= bh.endHour) next.setDate(next.getDate() + 1);
  next.setHours(bh.startHour, 0, 0, 0);

  return { allowed: false, retryAt: next.getTime() };
}

function weekKey() {
  const d = new Date();
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

export async function recordSentForHealth(sessionId) {
  const key = `safety:sent7d:${sessionId}:${weekKey()}`;
  await redis.incr(key);
  await redis.expire(key, 8 * 24 * 60 * 60);
}

export async function recordReplyForHealth(sessionId, number) {
  const key = `safety:replied7d:${sessionId}:${weekKey()}`;
  await redis.sadd(key, number);
  await redis.expire(key, 8 * 24 * 60 * 60);
}

async function getReplyHealth(sessionId) {
  const wk = weekKey();
  const [sent, repliedCount] = await Promise.all([
    redis.get(`safety:sent7d:${sessionId}:${wk}`),
    redis.scard(`safety:replied7d:${sessionId}:${wk}`),
  ]);
  const sentCount = Number(sent) || 0;
  const ratio = sentCount > 0 ? repliedCount / sentCount : null;
  return { sentCount, repliedCount, ratio };
}

export async function getStatus(mobile, sessionId) {
  const settings = loadSettings(mobile, sessionId);
  const caps = getCaps(mobile, sessionId);

  const [hourCount, dayCount, health] = await Promise.all([
    redis.get(hourKey(sessionId)),
    redis.get(dayKey(sessionId)),
    getReplyHealth(sessionId),
  ]);

  return {
    sessionId,
    warmupDay: caps.warmupDay,
    isWarmingUp: caps.isWarmingUp,
    hourlyCap: caps.hourlyCap,
    dailyCap: caps.dailyCap,
    hourlyUsed: Number(hourCount) || 0,
    dailyUsed: Number(dayCount) || 0,
    businessHours: settings.businessHours,
    health,
  };
}
