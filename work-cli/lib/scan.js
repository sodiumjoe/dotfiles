const fs = require("node:fs");
const path = require("node:path");
const {
  extractSection,
  findSectionLineRange,
  parseFrontmatter,
  getTitle,
} = require("./markdown.js");
const { atomicRewrite } = require("./atomic.js");
const { PROJECT_DIR, projectFile, notePath } = require("./paths.js");

function scanOpenItems() {
  const results = [];
  if (fs.existsSync(PROJECT_DIR)) {
    const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
      const slug = entry.name;
      const filePath = projectFile(slug);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(content);
      const evergreen = fm.status === "evergreen";
      if (fm.status !== "active" && !evergreen) continue;
      const tasks = extractSection(content, "Tasks");
      const title = getTitle(content);
      let hasOpenTasks = false;
      for (const line of tasks) {
        if (/^- \[[ /]\] /.test(line)) {
          const state = line.match(/^- \[(.)\]/)[1];
          const item = line.replace(/^- \[.\] /, "");
          results.push({
            filename: `${slug}.md`,
            title,
            itemText: item,
            sourceType: "project",
            state,
            projectSlug: slug,
            evergreen,
          });
          hasOpenTasks = true;
        }
      }
      if (evergreen && !hasOpenTasks) {
        results.push({
          filename: `${slug}.md`,
          title,
          itemText: "",
          sourceType: "project",
          state: " ",
          projectSlug: slug,
          evergreen: true,
        });
      }
    }
  }
  return results;
}

function formatScanTSV(results) {
  return results
    .map(
      (r) =>
        `${r.filename}\t${r.title}\t${r.itemText}\t${r.sourceType}\t${r.state}\t${r.projectSlug || ""}`,
    )
    .join("\n");
}

function syncCheck(dateStr) {
  const results = [];
  if (fs.existsSync(PROJECT_DIR)) {
    const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
      const slug = entry.name;
      const filePath = projectFile(slug);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.includes(`✅ ${dateStr}`)) continue;
      const changelog = extractSection(content, "Changelog");
      const title = getTitle(content);
      for (const line of changelog) {
        if (line.includes(`✅ ${dateStr}`)) {
          const item = line.replace(/^- \[x\] /, "");
          results.push({
            filename: `${slug}.md`,
            title,
            itemText: item,
            sourceType: "project",
          });
        }
      }
    }
  }
  const dailyNote = notePath(dateStr);
  if (!fs.existsSync(dailyNote) || results.length === 0) return results;
  const dailyContent = fs.readFileSync(dailyNote, "utf-8");
  const logLines = extractSection(dailyContent, "Log");
  const logText = logLines.join("\n");
  return results.filter((r) => {
    const textWithoutDate = r.itemText.replace(/ ✅ \d{4}-\d{2}-\d{2}$/, "");
    return !logText.includes(textWithoutDate);
  });
}

function listTasks(filePath) {
  const results = [];
  if (filePath) {
    if (!fs.existsSync(filePath)) return results;
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const title = getTitle(content);
    const range = findSectionLineRange(lines, "Tasks");
    if (!range) return results;
    for (let i = range.start + 1; i < range.end; i++) {
      if (/^- \[[ /]\] /.test(lines[i])) {
        const state = lines[i].match(/^- \[(.)\]/)[1];
        const description = lines[i].replace(/^- \[.\] /, "");
        results.push({
          file: filePath,
          line: i + 1,
          state,
          title,
          description,
        });
      }
    }
    return results;
  }
  if (!fs.existsSync(PROJECT_DIR)) return results;
  const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
    const slug = entry.name;
    const fp = projectFile(slug);
    if (!fs.existsSync(fp)) continue;
    const content = fs.readFileSync(fp, "utf-8");
    const fm = parseFrontmatter(content);
    if (fm.status !== "active" && fm.status !== "evergreen") continue;
    const lines = content.split("\n");
    const title = getTitle(content);
    const range = findSectionLineRange(lines, "Tasks");
    if (!range) continue;
    for (let i = range.start + 1; i < range.end; i++) {
      if (/^- \[[ /]\] /.test(lines[i])) {
        const state = lines[i].match(/^- \[(.)\]/)[1];
        const description = lines[i].replace(/^- \[.\] /, "");
        results.push({ file: fp, line: i + 1, state, title, description });
      }
    }
  }
  return results;
}

function setTaskState(filePath, lineNum, state, dateStr) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const stateChar =
    state === "open" ? " " : state === "in-progress" ? "/" : "x";
  atomicRewrite(filePath, (content) => {
    const lines = content.split("\n");
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) {
      throw new Error(`line ${lineNum} out of range`);
    }
    if (!/^- \[.\] /.test(lines[idx])) {
      throw new Error(`line ${lineNum} is not a checkbox item`);
    }
    let text = lines[idx].replace(/^- \[.\] /, "");
    if (state === "done") {
      if (!/ ✅ \d{4}-\d{2}-\d{2}$/.test(text)) {
        text = `${text} ✅ ${dateStr}`;
      }
    } else {
      text = text.replace(/ ✅ \d{4}-\d{2}-\d{2}$/, "");
    }
    lines[idx] = `- [${stateChar}] ${text}`;
    return lines.join("\n");
  });
}

module.exports = {
  scanOpenItems,
  formatScanTSV,
  syncCheck,
  listTasks,
  setTaskState,
};
