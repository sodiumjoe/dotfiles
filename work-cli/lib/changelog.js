const fs = require("node:fs");
const {
  parse,
  serialize,
  findSection,
  appendToSection,
  mutateSection,
} = require("./markdown.js");
const { atomicRewrite } = require("./atomic.js");
const { notePath } = require("./paths.js");

function applyCloseTask(content, description, dateStr, { cancel } = {}) {
  const doc = parse(content);
  let action;
  let found = false;

  mutateSection(doc, "Tasks", (lines) => {
    for (let i = 0; i < lines.length; i++) {
      if (/^- \[[ /]\]/.test(lines[i])) {
        const text = lines[i].replace(/^- \[.\] /, "");
        if (text === description || text.includes(description)) {
          if (cancel) {
            lines[i] = `- [-] ${text}`;
            action = "cancelled";
          } else {
            lines[i] = `- [x] ${text} ✅ ${dateStr}`;
            action = "checked";
          }
          found = true;
          break;
        }
      }
    }
    return lines;
  });
  if (found) return { content: serialize(doc), action };

  if (cancel) return { content, action: undefined };

  if (!findSection(doc, "Changelog")) {
    doc.sections.push({ name: "Changelog", lines: [] });
  }

  mutateSection(doc, "Changelog", (lines) => {
    for (let i = 0; i < lines.length; i++) {
      if (/^- \[ \]/.test(lines[i])) {
        const text = lines[i].replace(/^- \[ \] /, "");
        if (text === description || text.includes(description)) {
          lines[i] = `- [x] ${text} ✅ ${dateStr}`;
          found = true;
          action = "checked";
          break;
        }
      }
    }
    return lines;
  });
  if (found) return { content: serialize(doc), action };

  const entry = `- [x] ${description} ✅ ${dateStr}`;
  action = "appended";
  appendToSection(doc, "Changelog", [entry]);
  return { content: serialize(doc), action };
}

function closeTask(filePath, description, dateStr, { quiet, cancel } = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  let action;
  atomicRewrite(filePath, (content) => {
    const result = applyCloseTask(content, description, dateStr, { cancel });
    action = result.action;
    return result.content;
  });
  if (!quiet) console.log(`${action}: ${description}`);
  return action;
}

function appendLog(
  dateStr,
  description,
  sourceType,
  sourceSlug,
  sourceTitle,
  { quiet } = {},
) {
  const dailyNote = notePath(dateStr);
  if (!fs.existsSync(dailyNote)) {
    throw new Error("no daily note found");
  }
  let wikiSuffix = "";
  if (sourceSlug && sourceTitle) {
    const wikiPath = `projects/${sourceSlug}/project`;
    wikiSuffix = ` — [[${wikiPath}|${sourceTitle}]]`;
  }
  const entry = `- [x] ${description} ✅ ${dateStr}${wikiSuffix}`;
  atomicRewrite(dailyNote, (content) => {
    const doc = parse(content);
    if (!findSection(doc, "Log")) {
      throw new Error("no ## Log section found");
    }
    appendToSection(doc, "Log", [entry]);
    return serialize(doc);
  });
  if (!quiet) console.log(entry);
}

module.exports = { closeTask, applyCloseTask, appendLog };
