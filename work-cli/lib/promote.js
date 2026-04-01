const fs = require("node:fs");
const path = require("node:path");
const {
  parse,
  serialize,
  findSection,
  appendToSection,
  mutateSection,
  extractSection,
  parseFrontmatter,
} = require("./markdown.js");
const { atomicRewrite } = require("./atomic.js");
const { PROJECT_DIR, projectFile: getProjectFile } = require("./paths.js");

function promote(dateStr, { quiet } = {}) {
  const log = quiet ? () => {} : console.log.bind(console);
  if (!fs.existsSync(PROJECT_DIR)) return [];
  const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
  const promoted = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
    const slug = entry.name;
    const f = `${slug}/project.md`;
    const filePath = getProjectFile(slug);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (fm.status !== "active" && fm.status !== "evergreen") continue;
    const tasks = extractSection(content, "Tasks");
    const completed = tasks.filter((l) => /^- \[x\] /.test(l));
    if (completed.length === 0) continue;
    atomicRewrite(filePath, (c) => {
      const doc = parse(c);
      if (!findSection(doc, "Tasks") || !findSection(doc, "Changelog"))
        return c;
      const toInsert = [];
      mutateSection(doc, "Tasks", (lines) => {
        return lines.filter((line) => {
          if (/^- \[x\] /.test(line)) {
            let text = line.replace(/^- \[x\] /, "");
            const hasDate = / ✅ \d{4}-\d{2}-\d{2}$/.test(text);
            if (!hasDate) {
              text = `${text} ✅ ${dateStr}`;
            }
            toInsert.push(`- [x] ${text}`);
            promoted.push({ file: f, text });
            return false;
          }
          return true;
        });
      });
      appendToSection(doc, "Changelog", toInsert);
      return serialize(doc);
    });
  }
  if (promoted.length > 0) {
    log(`promoted ${promoted.length} task(s) to changelog`);
    for (const p of promoted) {
      log(`  ${p.file}: ${p.text}`);
    }
  }
  return promoted;
}

module.exports = { promote };
