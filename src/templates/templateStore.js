import crypto from "crypto";
import redis from "../config/redis.js";

const key = (mobile) => `templates:${mobile}`;

export async function listTemplates(mobile) {
  const raw = await redis.hgetall(key(mobile));
  return Object.values(raw)
    .map((v) => JSON.parse(v))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function createTemplate(mobile, { name, body }) {
  const id = crypto.randomUUID();
  const template = { id, name, body, createdAt: Date.now() };
  await redis.hset(key(mobile), id, JSON.stringify(template));
  return template;
}

export async function deleteTemplate(mobile, id) {
  await redis.hdel(key(mobile), id);
}
