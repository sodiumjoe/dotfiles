const fs = require("node:fs");
const path = require("node:path");
const { atomicRewrite } = require("./atomic");

function parseDevboxLine(line) {
  if (!line) return [];
  const match = line.match(/^devboxes:\s*\[?(.*?)\]?\s*$/);
  if (!match || !match[1].trim()) return [];
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function serializeDevboxLine(names) {
  if (names.length === 0) return "devboxes:";
  return `devboxes: [${names.join(", ")}]`;
}

function link(filePath, remote) {
  return atomicRewrite(filePath, (content) => {
    const devboxMatch = content.match(/^devboxes:.*$/m);
    if (devboxMatch) {
      const existing = parseDevboxLine(devboxMatch[0]);
      if (existing.includes(remote)) return content;
      existing.push(remote);
      return content.replace(/^devboxes:.*$/m, serializeDevboxLine(existing));
    }
    const lines = content.split("\n");
    let fmCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "---") fmCount++;
      if (fmCount === 2) {
        lines.splice(i, 0, serializeDevboxLine([remote]));
        break;
      }
    }
    return lines.join("\n");
  });
}

function unlink(filePath, remote) {
  return atomicRewrite(filePath, (content) => {
    const devboxMatch = content.match(/^devboxes:.*$/m);
    if (!devboxMatch) return content;
    const existing = parseDevboxLine(devboxMatch[0]);
    const filtered = existing.filter((n) => n !== remote);
    if (filtered.length === existing.length) return content;
    return content.replace(/^devboxes:.*$/m, serializeDevboxLine(filtered));
  });
}

function listAll(projectsDir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pf = path.join(projectsDir, entry.name, "project.md");
    let content;
    try {
      content = fs.readFileSync(pf, "utf-8");
    } catch {
      continue;
    }
    const match = content.match(/^devboxes:.*$/m);
    if (!match) continue;
    const remotes = parseDevboxLine(match[0]);
    if (remotes.length > 0) {
      results.push({ slug: entry.name, remotes });
    }
  }
  return results;
}

module.exports = { link, unlink, listAll, parseDevboxLine };
