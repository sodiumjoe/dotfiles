const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SKILLS_DIR =
  process.env.WORK_SKILLS_DIR || path.join(__dirname, "..", "..", "skills");

const CONFIG_PATH =
  process.env.WORK_UPSTREAM_CONFIG ||
  path.join(__dirname, "upstream-config.json");

function loadUpstreamConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { upstreams: {} };
  }
}

function expandHome(p) {
  return p.replace(/^~(?=$|\/)/, process.env.HOME);
}

function checkUpstream(skillsDir = SKILLS_DIR) {
  if (!fs.existsSync(skillsDir)) return [];
  const config = loadUpstreamConfig();
  const results = [];
  const dirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  for (const dir of dirs) {
    const skillFile = path.join(skillsDir, dir.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const content = fs.readFileSync(skillFile, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    const pluginMatch = fm.match(/plugin:\s*(.+)/);
    const versionMatch = fm.match(/version:\s*(.+)/);
    const skillMatch = fm.match(/skill:\s*(.+)/);
    const hashMatch = fm.match(/content_hash:\s*(.+)/);
    if (!pluginMatch || !hashMatch || !skillMatch) continue;
    const plugin = pluginMatch[1].trim();
    const storedHash = hashMatch[1].trim();
    const upstreamSkill = skillMatch[1].trim();
    const forkedVersion = versionMatch ? versionMatch[1].trim() : null;
    const upstreamBase = config.upstreams[plugin];
    if (!upstreamBase) {
      results.push({
        skill: dir.name,
        status: "no-upstream-config",
        message: `no upstream configured for plugin "${plugin}"`,
      });
      continue;
    }
    const upstreamDir = expandHome(upstreamBase);
    if (!fs.existsSync(upstreamDir)) {
      results.push({
        skill: dir.name,
        status: "no-cache",
        message: `upstream path not found at ${upstreamDir}`,
      });
      continue;
    }
    const upstreamFile = path.join(
      upstreamDir,
      "skills",
      upstreamSkill,
      "SKILL.md",
    );
    if (!fs.existsSync(upstreamFile)) {
      results.push({
        skill: dir.name,
        status: "no-upstream",
        message: `upstream skill not found at ${upstreamFile}`,
      });
      continue;
    }
    const upstreamContent = fs.readFileSync(upstreamFile, "utf-8");
    const currentHash = crypto
      .createHash("sha256")
      .update(upstreamContent)
      .digest("hex");
    if (currentHash !== storedHash) {
      results.push({
        skill: dir.name,
        status: "drifted",
        storedHash,
        currentHash,
        forkedVersion,
        upstreamFile,
        localFile: skillFile,
      });
    } else {
      results.push({ skill: dir.name, status: "up-to-date" });
    }
  }
  return results;
}

module.exports = { checkUpstream };
