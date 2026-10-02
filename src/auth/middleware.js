import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { findByApiKey, findByMobile } from "./users.js";
import logger from "../config/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED_IPS_PATH = path.join(__dirname, "..", "..", "allowedIPs.json");

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    if (req.apiUser?.mobile) {
      return `user:${req.apiUser.mobile}`;
    }
    return ipKeyGenerator(req);
  },
});

export function requireLogin(req, res, next) {
  if (!req.session.authenticated) return res.redirect("/");
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session.authenticated) return res.redirect("/");

  const user = findByMobile(req.session.user.mobile);
  if (!user?.isAdmin) return res.status(403).send("forbidden");

  next();
}

export function apiAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey) {
    return res.status(401).json({ error: "missing api key" });
  }
  const user = findByApiKey(apiKey);
  if (!user) {
    return res.status(403).json({ error: "invalid api key" });
  }

  req.apiUser = user;
  next();
}

export function ipAllowlist(req, res, next) {
  const allowedIPsData = JSON.parse(fs.readFileSync(ALLOWED_IPS_PATH, "utf8"));
  const allowedIPs = allowedIPsData.map((entry) => entry.ip);

  const raw_ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  const ip = raw_ip.replace("::ffff:", "");

  if (!allowedIPs.includes(ip)) {
    logger.error("ip not allowed", { ip });
    return res.status(403).json({ error: "ip not allowed" });
  }

  next();
}
