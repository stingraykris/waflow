import fs1 from "fs/promises";
import path from "path";
import crypto from "crypto";
import { publicDir } from "../config/paths.js";

export async function saveFile(formData) {
  if (!formData.image) return null;

  let buffer;

  if (typeof formData.image === "string") {
    buffer = Buffer.from(formData.image, "base64");
  } else if (Buffer.isBuffer(formData.image)) {
    buffer = formData.image;
  } else if (formData.image.data) {
    buffer = Buffer.from(formData.image.data, "base64");
  } else {
    throw new Error("Invalid image format");
  }

  const ext = path.extname(formData.filename || "") || ".jpg";
  const safeName = crypto.randomUUID() + ext;
  const filePath = path.join(publicDir, "images", safeName);

  await fs1.writeFile(filePath, buffer);

  return filePath;
}
