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

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseSupportHashes(frontmatter) {
  const support = [];
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "support_hashes:") continue;
    for (let j = i + 1; j < lines.length; j++) {
      const match = lines[j].match(/^  ([^:]+):\s*([a-f0-9]{64})$/);
      if (!match) break;
      support.push({ relativePath: match[1], storedHash: match[2] });
    }
  }
  return support;
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
    const currentHash = hashFile(upstreamFile);
    const driftedFiles = [];
    if (currentHash !== storedHash) {
      driftedFiles.push({
        relativePath: "SKILL.md",
        storedHash,
        currentHash,
        upstreamFile,
        localFile: skillFile,
      });
    }
    let missingSupportFile = false;
    for (const support of parseSupportHashes(fm)) {
      const localSupportFile = path.join(
        skillsDir,
        dir.name,
        support.relativePath,
      );
      const upstreamSupportFile = path.join(
        upstreamDir,
        "skills",
        upstreamSkill,
        support.relativePath,
      );
      if (!fs.existsSync(upstreamSupportFile)) {
        results.push({
          skill: dir.name,
          status: "no-upstream",
          message: `upstream support file not found at ${upstreamSupportFile}`,
        });
        missingSupportFile = true;
        break;
      }
      const supportCurrentHash = hashFile(upstreamSupportFile);
      if (supportCurrentHash !== support.storedHash) {
        driftedFiles.push({
          relativePath: support.relativePath,
          storedHash: support.storedHash,
          currentHash: supportCurrentHash,
          upstreamFile: upstreamSupportFile,
          localFile: localSupportFile,
        });
      }
    }
    if (missingSupportFile) continue;
    if (driftedFiles.length > 0) {
      const first = driftedFiles[0];
      results.push({
        skill: dir.name,
        status: "drifted",
        storedHash: first.storedHash,
        currentHash: first.currentHash,
        forkedVersion,
        upstreamFile: first.upstreamFile,
        localFile: first.localFile,
        driftedFiles,
      });
    } else {
      results.push({ skill: dir.name, status: "up-to-date" });
    }
  }
  return results;
}

module.exports = { checkUpstream, parseSupportHashes };