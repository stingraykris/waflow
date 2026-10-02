import { Queue } from "bullmq";
import redis from "../config/redis.js";
import env from "../config/env.js";

let globalQueue;

export function getQueue() {
  if (!globalQueue) {
    globalQueue = new Queue(env.queueName, {
      connection: redis,
      defaultJobOptions: {
        removeOnComplete: { age: 3600 },
        removeOnFail: 1000,
      },
    });
  }
  return globalQueue;
}
