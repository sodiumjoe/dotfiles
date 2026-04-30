const fs = require("node:fs");
const path = require("node:path");
const {
  parse,
  serialize,
  findSection,
  appendToSection,
  parseFrontmatter,
  extractSection,
  getTitle,
} = require("./markdown.js");
const {
  PROJECT_DIR,
  VAULT_ROOT,
  projectDir,
  projectFile,
  notePath,
  todayStr,
} = require("./paths.js");
const { atomicRewrite } = require("./atomic.js");
const { closeTask, applyCloseTask, appendLog } = require("./changelog.js");

function createProject(slug, title) {
  if (!slug || /[\s/]/.test(slug)) {
    throw new Error("invalid slug: must be non-empty, no spaces, no /");
  }
  const dir = projectDir(slug);
  const target = projectFile(slug);
  if (fs.existsSync(target)) {
    throw new Error(`exists: ${target}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    target,
    `---
status: active
id: ${slug}
---

# ${title}

## Links

## Plans

## Tasks

## Changelog

## Notes`,
  );
  console.log(target);
}

function resolveProject(planFile) {
  if (!planFile || !fs.existsSync(planFile)) return;
  const content = fs.readFileSync(planFile, "utf-8");
  const fm = parseFrontmatter(content);
  if (!fm.project) return;
  let project = fm.project;
  project = project.replace(/^\[\[/, "").replace(/\]\]$/, "");
  const slug = project.replace(/^projects\//, "").replace(/\/project$/, "");
  const newPath = projectFile(slug);
  if (fs.existsSync(newPath)) {
    console.log(newPath);
    return;
  }
  const legacyPath = path.join(VAULT_ROOT, `${project}.md`);
  if (fs.existsSync(legacyPath)) {
    console.log(legacyPath);
    return;
  }
}

function parseChangelog(filePath, pattern, { quiet } = {}) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  const title = getTitle(content);
  const base = path.basename(filePath);
  const changelog = extractSection(content, "Changelog");
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`invalid regex pattern: ${pattern}`);
  }
  for (const line of changelog) {
    if (re.test(line)) {
      if (!quiet) console.log(`${base}\t${title}\t${line}`);
    }
  }
}

function completeProjects({ quiet } = {}) {
  if (!fs.existsSync(PROJECT_DIR)) return [];
  const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
  const completed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
    const slug = entry.name;
    const filePath = projectFile(slug);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    if (fm.status === "completed") continue;
    if (fm.status === "evergreen") continue;
    if (fm.permanent === "true" || fm.permanent === true) continue;
    const tasks = extractSection(content, "Tasks");
    const openTasks = tasks.filter((l) => /^- \[[ /]\]/.test(l));
    if (openTasks.length > 0) continue;
    const changelog = extractSection(content, "Changelog");
    const openChangelog = changelog.filter((l) => /^- \[ \]/.test(l));
    const done = changelog.filter((l) => /^- \[x\]/.test(l));
    if (done.length === 0) continue;
    if (openChangelog.length > 0) continue;
    atomicRewrite(filePath, (c) => {
      c = c.replace(/^status:\s*active\s*$/m, "status: completed");
      if (!/^completed_at:/m.test(c)) {
        c = c.replace(
          /^status:\s*completed\s*$/m,
          `status: completed\ncompleted_at: ${todayStr()}`,
        );
      }
      return c;
    });
    const title = getTitle(content) || slug;
    completed.push({ file: `${slug}/project.md`, title });
    if (!quiet) console.log(`completed: ${title} (${slug})`);
  }
  return completed;
}

function archiveProject(slug, { quiet } = {}) {
  const srcDir = projectDir(slug);
  const srcFile = projectFile(slug);
  if (!fs.existsSync(srcFile)) throw new Error(`not found: ${srcFile}`);
  const archiveProjectDir = path.join(VAULT_ROOT, "archive", "projects");
  fs.mkdirSync(archiveProjectDir, { recursive: true });
  const destDir = path.join(archiveProjectDir, slug);
  fs.renameSync(srcDir, destDir);
  if (!quiet) console.log(`archived project: ${slug}`);
}

function archivePlans({ quiet } = {}) {
  if (!fs.existsSync(PROJECT_DIR)) return [];
  const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
  const archived = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
    const slug = entry.name;
    const pf = projectFile(slug);
    if (!fs.existsSync(pf)) continue;
    const content = fs.readFileSync(pf, "utf-8");
    const fm = parseFrontmatter(content);
    if (fm.status !== "evergreen") continue;
    const dir = projectDir(slug);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "project.md");
    const toArchive = [];
    for (const file of files) {
      const planContent = fs.readFileSync(path.join(dir, file), "utf-8");
      const planFm = parseFrontmatter(planContent);
      if (planFm.status !== "done" && planFm.status !== "completed") continue;
      const basename = file.replace(/\.md$/, "");
      const title = getTitle(planContent);
      toArchive.push({ file, basename, title });
    }
    if (toArchive.length > 0) {
      const archiveDir = path.join(VAULT_ROOT, "archive", "projects", slug);
      fs.mkdirSync(archiveDir, { recursive: true });
      for (const plan of toArchive) {
        const src = path.join(dir, plan.file);
        const dest = path.join(archiveDir, plan.file);
        fs.renameSync(src, dest);
        archived.push({
          slug,
          file: plan.file,
          basename: plan.basename,
          title: plan.title,
          archivePath: dest,
        });
        if (!quiet) console.log(`archived plan: ${plan.basename} (${slug})`);
      }
    }
    const doc = parse(fs.readFileSync(pf, "utf-8"));
    const plansSection = findSection(doc, "Plans");
    if (plansSection) {
      const basenames = new Set(toArchive.map((p) => p.basename));
      const before = plansSection.lines.length;
      plansSection.lines = plansSection.lines.filter((line) => {
        if (line.includes("[[archive/")) return false;
        for (const bn of basenames) {
          if (line.includes(`[[${bn}`)) return false;
        }
        return true;
      });
      if (plansSection.lines.length !== before) {
        fs.writeFileSync(pf, serialize(doc), "utf-8");
      }
    }
  }
  return archived;
}

function extractFindings(archivedPlans, dateStr, { quiet } = {}) {
  if (archivedPlans.length === 0) return [];
  const { execFileSync } = require("node:child_process");
  const findings = [];
  for (const plan of archivedPlans) {
    const planContent = fs.readFileSync(plan.archivePath, "utf-8");
    const planFm = parseFrontmatter(planContent);
    if (
      planFm.findings_extracted === "true" ||
      planFm.findings_extracted === true
    ) {
      if (!quiet)
        console.log(
          `skipping findings for ${plan.basename} (already extracted)`,
        );
      continue;
    }
    const pf = projectFile(plan.slug);
    const prompt = `Read the archived plan file at ${plan.archivePath} and the project file at ${pf}.

Identify anything worth preserving from this completed plan:
- Patterns discovered, gotchas, or workarounds
- Architectural decisions and their rationale
- Configuration details that might be needed again
- Debugging insights

Output a short summary (2-3 sentences max) of notable findings. If there is nothing worth preserving beyond what the project changelog already captures, respond with exactly: NONE`;

    try {
      const claudeCmd = process.env.WORK_CLAUDE_CMD || "claude";
      const result = execFileSync(
        claudeCmd,
        ["-p", "--allowedTools", "Read", "Glob", "Grep"],
        {
          input: prompt,
          stdio: ["pipe", "pipe", "inherit"],
          timeout: 120000,
          encoding: "utf-8",
        },
      );
      const summary = result.trim();
      if (summary && summary !== "NONE") {
        findings.push({ plan, summary });
      }
    } catch (e) {
      if (!quiet)
        console.error(
          `findings extraction failed for ${plan.basename}: ${e.message}`,
        );
    }
  }
  if (findings.length > 0) {
    const np = notePath(dateStr);
    if (fs.existsSync(np)) {
      const lines = findings.map(
        (f) =>
          `- [ ] Review findings from "${f.plan.title || f.plan.basename}": ${f.summary}`,
      );
      atomicRewrite(np, (c) => {
        const doc = parse(c);
        appendToSection(doc, "Tasks", lines);
        return serialize(doc);
      });
      if (!quiet)
        console.log(`added ${findings.length} findings review task(s)`);
    }
  }
  return findings;
}

function listProjects() {
  if (!fs.existsSync(PROJECT_DIR)) return [];
  const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
    const slug = entry.name;
    const filePath = projectFile(slug);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);
    const status = fm.status || "active";
    if (status !== "active" && status !== "evergreen") continue;
    const title = getTitle(content) || slug;
    results.push({ slug, title, status });
  }
  return results;
}

function resolveProjectSlug(projectField) {
  const stripped = projectField.replace(/^\[\[/, "").replace(/\]\]$/, "");
  return stripped.replace(/^projects\//, "").replace(/\/project$/, "");
}

function syncPlans({ quiet } = {}) {
  if (!fs.existsSync(PROJECT_DIR)) return [];
  const added = [];
  const pending = new Map();
  const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
    const slug = entry.name;
    const pf = projectFile(slug);
    if (!fs.existsSync(pf)) continue;
    const content = fs.readFileSync(pf, "utf-8");
    const fm = parseFrontmatter(content);
    if (fm.status !== "active" && fm.status !== "evergreen") continue;
    const dir = projectDir(slug);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "project.md");
    const plansText = extractSection(content, "Plans").join("\n");
    for (const file of files) {
      const basename = file.replace(/\.md$/, "");
      const planContent = fs.readFileSync(path.join(dir, file), "utf-8");
      const planFm = parseFrontmatter(planContent);
      if (!planFm.project) continue;
      if (resolveProjectSlug(planFm.project) !== slug) continue;
      if (plansText.includes(`[[${basename}`)) continue;
      const title = getTitle(planContent);
      if (!pending.has(slug)) pending.set(slug, []);
      pending.get(slug).push({ basename, title });
    }
  }
  for (const [slug, plans] of pending) {
    const pf = projectFile(slug);
    const doc = parse(fs.readFileSync(pf, "utf-8"));
    const section = findSection(doc, "Plans");
    if (!section) continue;
    for (const { basename, title } of plans) {
      const link = title ? `- [[${basename}|${title}]]` : `- [[${basename}]]`;
      section.lines.push(link);
      added.push({ slug, plan: basename, title });
      if (!quiet) console.log(`linked: ${basename} → ${slug}`);
    }
    fs.writeFileSync(pf, serialize(doc), "utf-8");
  }
  return added;
}

function closeTasks(filePath, skipLines, dateStr, { quiet } = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const skipSet = new Set(skipLines);
  let completed = 0;
  let cancelled = 0;
  atomicRewrite(filePath, (content) => {
    const lines = content.split("\n");
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^## Tasks\s*$/.test(lines[i])) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) return content;
    const tasks = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) break;
      if (/^- \[[ /]\] /.test(lines[i])) {
        const text = lines[i].replace(/^- \[.\] /, "");
        const skip = skipSet.has(i + 1);
        tasks.push({ text, skip });
      }
    }
    for (const { text, skip } of tasks) {
      const result = applyCloseTask(content, text, dateStr, { cancel: skip });
      content = result.content;
      if (skip) cancelled++;
      else completed++;
    }
    return content;
  });
  if (!quiet) {
    console.log(`closed tasks: ${completed} completed, ${cancelled} cancelled`);
  }
  return { completed, cancelled };
}

function closeProject(slug, summary, dateStr, { quiet } = {}) {
  const filePath = projectFile(slug);
  if (!fs.existsSync(filePath)) {
    throw new Error(`project not found: ${slug}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const tasks = extractSection(content, "Tasks");
  const openTasks = tasks.filter((l) => /^- \[[ /]\] /.test(l));
  if (openTasks.length > 0) {
    throw new Error(
      `open tasks remain (${openTasks.length}); run close-tasks first`,
    );
  }
  const daily = notePath(dateStr);
  if (!fs.existsSync(daily)) {
    throw new Error("no daily note; run work ensure first");
  }
  closeTask(filePath, summary, dateStr, { quiet });
  atomicRewrite(filePath, (c) => {
    c = c.replace(/^status:\s*active\s*$/m, "status: completed");
    if (!/^completed_at:/m.test(c)) {
      c = c.replace(
        /^status:\s*completed\s*$/m,
        `status: completed\ncompleted_at: ${dateStr}`,
      );
    }
    return c;
  });
  const title = getTitle(content) || slug;
  appendLog(dateStr, summary, "project", slug, title, { quiet });
  if (!quiet) console.log(`closed project: ${title} (${slug})`);
}

function closePlan(planFile, { quiet } = {}) {
  if (!fs.existsSync(planFile)) {
    throw new Error(`plan not found: ${planFile}`);
  }
  atomicRewrite(planFile, (c) => {
    c = c.replace(/^status:\s*active\s*$/m, "status: done");
    if (!/^findings_extracted:/m.test(c)) {
      c = c.replace(
        /^status:\s*(done|completed)\s*$/m,
        (match) => `${match}\nfindings_extracted: true`,
      );
    }
    return c;
  });
  if (!quiet) console.log(`closed plan: ${path.basename(planFile)}`);
}

module.exports = {
  createProject,
  resolveProject,
  parseChangelog,
  completeProjects,
  archiveProject,
  archivePlans,
  extractFindings,
  listProjects,
  syncPlans,
  closeTasks,
  closeProject,
  closePlan,
};
