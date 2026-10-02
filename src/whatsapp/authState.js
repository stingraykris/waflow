import { proto } from "@whiskeysockets/baileys";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import redis from "../config/redis.js";

// Redis-backed equivalent of Baileys' useMultiFileAuthState, so a session's
// credentials/keys survive a process restart instead of living only in a
// local folder (or worse, only in memory like the old whatsapp-web.js app).
const keyPrefix = (sessionId) => `baileys:auth:${sessionId}:`;
const fixKeyName = (file) => file.replace(/\//g, "__").replace(/:/g, "-");

async function writeData(sessionId, file, data) {
  const key = keyPrefix(sessionId) + fixKeyName(file);
  await redis.set(key, JSON.stringify(data, BufferJSON.replacer));
}

async function readData(sessionId, file) {
  const key = keyPrefix(sessionId) + fixKeyName(file);
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw, BufferJSON.reviver);
  } catch {
    return null;
  }
}

async function removeData(sessionId, file) {
  const key = keyPrefix(sessionId) + fixKeyName(file);
  await redis.del(key);
}

export async function useRedisAuthState(sessionId) {
  const creds = (await readData(sessionId, "creds.json")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(sessionId, `${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(
                value
                  ? writeData(sessionId, file, value)
                  : removeData(sessionId, file),
              );
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(sessionId, "creds.json", creds),
  };
}

// Wipes all persisted auth keys for a session (used on logout/delete).
export async function clearRedisAuthState(sessionId) {
  const pattern = keyPrefix(sessionId) + "*";
  const stream = redis.scanStream({ match: pattern, count: 100 });

  const keysToDelete = [];
  await new Promise((resolve, reject) => {
    stream.on("data", (keys) => keysToDelete.push(...keys));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  if (keysToDelete.length) {
    await redis.del(...keysToDelete);
  }
}
