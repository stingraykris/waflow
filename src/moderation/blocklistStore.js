import redis from "../config/redis.js";

const key = (ownerMobile) => `optout:${ownerMobile}`;

export async function addToBlocklist(ownerMobile, number) {
  await redis.sadd(key(ownerMobile), number);
}

export async function removeFromBlocklist(ownerMobile, number) {
  await redis.srem(key(ownerMobile), number);
}

export async function listBlocklist(ownerMobile) {
  return redis.smembers(key(ownerMobile));
}

export async function isOptedOut(ownerMobile, number) {
  return (await redis.sismember(key(ownerMobile), number)) === 1;
}

// Splits numbers into { allowed, blocked } in a single round trip.
export async function filterOptedOut(ownerMobile, numbers) {
  if (!numbers.length) return { allowed: [], blocked: [] };

  const flags = await redis.smismember(key(ownerMobile), numbers);
  const allowed = [];
  const blocked = [];
  numbers.forEach((number, i) => {
    (flags[i] ? blocked : allowed).push(number);
  });
  return { allowed, blocked };
}
