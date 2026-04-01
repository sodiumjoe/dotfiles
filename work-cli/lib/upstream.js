const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SKILLS_DIR =
  process.env.WORK_SKILLS_DIR || path.join(__dirname, "..", "skills");

function checkUpstream(skillsDir = SKILLS_DIR) {
  if (!fs.existsSync(skillsDir)) return [];
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
    const [pluginName, registry] = plugin.split("@");
    const cacheBase = path.join(
      process.env.HOME,
      ".claude",
      "plugins",
      "cache",
      registry || "",
      pluginName,
    );
    if (!fs.existsSync(cacheBase)) {
      results.push({
        skill: dir.name,
        status: "no-cache",
        message: `upstream cache not found at ${cacheBase}`,
      });
      continue;
    }
    const versions = fs
      .readdirSync(cacheBase, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const diff = (pa[i] || 0) - (pb[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });
    if (versions.length === 0) continue;
    const latestVersion = versions[versions.length - 1];
    const upstreamFile = path.join(
      cacheBase,
      latestVersion,
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
        latestVersion,
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
