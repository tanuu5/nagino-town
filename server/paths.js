// フォルダの場所をまとめる。app/ の外（runs/、ledger/）は指示書のフォルダ構成に合わせる。
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const APP_DIR = path.resolve(here, "..");
export const ROOT_DIR = path.resolve(APP_DIR, "..");
export const CONFIG_DIR = path.join(APP_DIR, "config");
export const WEB_DIR = path.join(APP_DIR, "web");
export const ENV_FILE = path.join(APP_DIR, ".env");
export const RUNS_DIR = path.join(ROOT_DIR, "runs");
export const LEDGER_DIR = path.join(ROOT_DIR, "ledger");
export const LEDGER_FILE = path.join(LEDGER_DIR, "ledger.jsonl");
