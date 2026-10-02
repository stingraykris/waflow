import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.join(__dirname, "..", "..");
export const viewsDir = path.join(rootDir, "views");
export const publicDir = path.join(rootDir, "public");
export const dataDir = path.join(rootDir, "data");
