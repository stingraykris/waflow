import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_PATH = path.join(__dirname, "..", "..", "users.json");

export function getUsers() {
  return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
}

export function saveUsers(users) {
  const tmpPath = USERS_PATH + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(users, null, 2));
  fs.renameSync(tmpPath, USERS_PATH);
}

export function findByMobile(mobile) {
  return getUsers().find((u) => u.mobile === mobile);
}

export function findByApiKey(apiKey) {
  return getUsers().find((u) => u.apiKey === apiKey);
}

export function verifyPassword(user, plainPass) {
  if (!user.passHash) return false;
  return bcrypt.compareSync(plainPass, user.passHash);
}

export function hashPassword(plainPass) {
  return bcrypt.hashSync(plainPass, 10);
}

function generateApiKey() {
  return "WF_" + crypto.randomBytes(12).toString("hex");
}

export function createUser({ name, mobile, pass, country, isAdmin }) {
  const users = getUsers();
  if (users.some((u) => u.mobile === mobile)) {
    throw new Error("mobile already exists");
  }

  const user = {
    name,
    mobile,
    passHash: hashPassword(pass),
    country: country || "92",
    apiKey: generateApiKey(),
    isAdmin: !!isAdmin,
  };

  users.push(user);
  saveUsers(users);
  return user;
}

export function deleteUser(mobile) {
  const users = getUsers();
  const next = users.filter((u) => u.mobile !== mobile);
  if (next.length === users.length) {
    throw new Error("user not found");
  }
  saveUsers(next);
}

export function resetApiKey(mobile) {
  const users = getUsers();
  const index = users.findIndex((u) => u.mobile === mobile);
  if (index === -1) {
    throw new Error("user not found");
  }

  const newKey = generateApiKey();
  users[index].apiKey = newKey;
  saveUsers(users);
  return newKey;
}
