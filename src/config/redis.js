import IORedis from "ioredis";
import env from "./env.js";

const redis = new IORedis({
  host: env.redisHost,
  port: env.redisPort,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export default redis;
