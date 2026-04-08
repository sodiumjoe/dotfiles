const fs = require("node:fs");
const path = require("node:path");
const {
  VAULT_ROOT,
  notePath,
  todayStr,
  PROJECT_DIR,
  projectFile: getProjectFile,
} = require("./paths.js");
const {
  parse,
  serialize,
  findSection,
  appendToSection,
  replaceSection,
  insertSectionBefore,
  extractSection,
  getTitle,
} = require("./markdown.js");
const { atomicRewrite } = require("./atomic.js");

function ensure(dateStr, { quiet } = {}) {
  const log = quiet ? () => {} : console.log.bind(console);
  const p = notePath(dateStr);
  if (!fs.existsSync(p)) {
    const frontmatter = `---
id: ${dateStr}
aliases: []
tags:
  - daily-notes
---

## Tasks

## Log
`;
    fs.writeFileSync(p, frontmatter);
    log(`created ${p}`);
    return;
  }
  const content = fs.readFileSync(p, "utf-8");
  if (/^## Queue/m.test(content) && !/^## Tasks/m.test(content)) {
    atomicRewrite(p, (c) => c.replace(/^## Queue/m, "## Tasks"));
    log(`migrated Queue → Tasks in ${p}`);
  }
  const current = fs.readFileSync(p, "utf-8");
  const missing = [];
  if (!/^## Tasks/m.test(current)) missing.push("## Tasks\n");
  if (!/^## Log/m.test(current)) missing.push("## Log\n");
  if (missing.length > 0) {
    fs.appendFileSync(p, "\n" + missing.join("\n"));
    log(
      `added missing sections to ${p}: ${missing.map((s) => s.trim()).join(", ")}`,
    );
  } else {
    log(`exists ${p}`);
  }
}

function logSyncEntries(dateStr, entries, dryRun, { quiet } = {}) {
  const log = quiet ? () => {} : console.log.bind(console);
  if (entries.length === 0) return;
  const formatted = entries.map((e) => {
    const slug = e.filename.replace(".md", "");
    const wikiPath = `projects/${slug}/project`;
    return `- [x] ${e.itemText} — [[${wikiPath}|${e.title}]]`;
  });
  if (dryRun) {
    for (const line of formatted) log(line);
    return;
  }
  const dailyNote = notePath(dateStr);
  if (!fs.existsSync(dailyNote)) {
    throw new Error("no daily note found");
  }
  atomicRewrite(dailyNote, (content) => {
    const doc = parse(content);
    appendToSection(doc, "Log", formatted);
    return serialize(doc);
  });
  log(`logged ${formatted.length} sync entry/entries`);
}

function inject(dateStr, scanResults, { quiet } = {}) {
  const log = quiet ? () => {} : console.log.bind(console);
  const dailyNote = notePath(dateStr);
  if (!fs.existsSync(dailyNote)) return;
  if (!scanResults || scanResults.length === 0) {
    log("no tasks to inject");
    atomicRewrite(dailyNote, (c) => {
      const doc = parse(c);
      replaceSection(doc, "Tasks", []);
      return serialize(doc);
    });
    return;
  }
  const grouped = groupByProject(scanResults);
  const lines = [];
  for (const [projectSlug, items] of grouped) {
    if (lines.length > 0) lines.push("");
    let title = projectSlug;
    if (projectSlug === "_unassigned") {
      lines.push(`- **Unassigned**`);
    } else {
      const pf = getProjectFile(projectSlug);
      if (fs.existsSync(pf)) {
        const content = fs.readFileSync(pf, "utf-8");
        title = getTitle(content) || projectSlug;
      }
      lines.push(`- **[[projects/${projectSlug}/project#Tasks|${title}]]**`);
    }
    for (const item of items) {
      if (item.itemText === "") continue;
      const suffix = item.state === "/" ? " (in progress)" : "";
      lines.push(`  - ${item.itemText}${suffix}`);
    }
  }
  atomicRewrite(dailyNote, (c) => {
    const doc = parse(c);
    replaceSection(doc, "Tasks", lines);
    return serialize(doc);
  });
  const count = scanResults.length;
  log(`injected ${count} task(s) into daily note`);
}

function groupByProject(results) {
  const groups = new Map();
  const evergreenProjects = new Set();
  for (const r of results) {
    const key = r.projectSlug || "_unassigned";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    if (r.evergreen) {
      evergreenProjects.add(key);
    }
    groups.get(key).push({
      itemText: r.itemText,
      state: r.state,
      projectTitle: r.title,
      sourceType: r.sourceType,
    });
  }
  const sorted = new Map();
  for (const [k, v] of [...groups.entries()].sort((a, b) => {
    if (a[0] === "_unassigned") return 1;
    if (b[0] === "_unassigned") return -1;
    const aEvergreen = evergreenProjects.has(a[0]);
    const bEvergreen = evergreenProjects.has(b[0]);
    if (aEvergreen && !bEvergreen) return -1;
    if (!aEvergreen && bEvergreen) return 1;
    return a[0].localeCompare(b[0]);
  })) {
    sorted.set(k, v);
  }
  return sorted;
}

function injectReviews(dateStr, reviews, { quiet } = {}) {
  const log = quiet ? () => {} : console.log.bind(console);
  const dailyNote = notePath(dateStr);
  if (!fs.existsSync(dailyNote)) return;
  const { formatReviews } = require("./reviews.js");
  const lines = formatReviews(reviews);
  atomicRewrite(dailyNote, (c) => {
    const doc = parse(c);
    if (findSection(doc, "Reviews")) {
      replaceSection(doc, "Reviews", lines);
    } else {
      insertSectionBefore(doc, "Tasks", "Reviews", lines);
    }
    return serialize(doc);
  });
  log(`injected ${reviews.length} review(s) into daily note`);
}

module.exports = {
  ensure,
  logSyncEntries,
  inject,
  injectReviews,
};
