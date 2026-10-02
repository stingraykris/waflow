import fs from "fs";
import path from "path";

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Same tmp-file-then-rename pattern as src/auth/users.js's saveUsers,
// so a crash mid-write never corrupts a flow/state/response file.
export function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function deleteFile(filePath) {
  fs.rmSync(filePath, { force: true });
}

// Recursively walks a directory for .json files, returns parsed contents
// alongside path/mtime. Missing directory -> empty list, not an error.
export function listJsonFiles(dir) {
  const results = [];

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const data = readJson(full);
        if (data) {
          const stat = fs.statSync(full);
          results.push({ path: full, data, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }

  walk(dir);
  return results;
}
