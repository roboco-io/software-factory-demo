import path from "node:path";

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
export const FACTORY_DIR = path.join(REPO_ROOT, "factory");
