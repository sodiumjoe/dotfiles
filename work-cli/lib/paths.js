const fs = require("node:fs");
const path = require("node:path");

function loadConfig() {
  const xdgConfig =
    process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, ".config");
  const configPath = path.join(xdgConfig, "work", "config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

const config = loadConfig();
const expandHome = (p) => p?.replace(/^~(?=$|\/)/, process.env.HOME);
const VAULT_ROOT =
  process.env.WORK_VAULT ||
  expandHome(config.vault) ||
  path.join(process.env.HOME, "work");
const PROJECT_DIR = path.join(VAULT_ROOT, "projects");

function projectDir(slug) {
  return path.join(PROJECT_DIR, slug);
}

function projectFile(slug) {
  return path.join(PROJECT_DIR, slug, "project.md");
}

function notePath(dateStr) {
  return path.join(VAULT_ROOT, `${dateStr}.md`);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

module.exports = {
  VAULT_ROOT,
  PROJECT_DIR,
  projectDir,
  projectFile,
  notePath,
  todayStr,
};
