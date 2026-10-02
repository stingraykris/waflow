import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import { dataDir } from "../config/paths.js";
import { readJson, writeJsonAtomic, listJsonFiles } from "../flows/fileStore.js";

const libDir = (mobile) => path.join(dataDir, "csv-library", mobile);
const metaPath = (mobile, id) => path.join(libDir(mobile), `${id}.json`);
const csvPath = (mobile, id) => path.join(libDir(mobile), `${id}.csv`);

export async function listCsvFiles(mobile) {
  return listJsonFiles(libDir(mobile))
    .map((f) => f.data)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCsvFile(mobile, id) {
  return readJson(metaPath(mobile, id));
}

export function csvFilePath(mobile, id) {
  return csvPath(mobile, id);
}

// Saves an already-uploaded CSV (multer temp path) into the library under a
// stable id, alongside metadata describing it.
export async function saveCsvFile(mobile, { name, originalFilename, tmpPath, rowCount }) {
  const id = crypto.randomUUID();
  await fs.mkdir(libDir(mobile), { recursive: true });
  await fs.rename(tmpPath, csvPath(mobile, id));

  const meta = { id, name, originalFilename, rowCount, createdAt: Date.now() };
  writeJsonAtomic(metaPath(mobile, id), meta);
  return meta;
}

export async function deleteCsvFile(mobile, id) {
  await fs.rm(metaPath(mobile, id), { force: true });
  await fs.rm(csvPath(mobile, id), { force: true });
}
