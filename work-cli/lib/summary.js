const fs = require("node:fs");
const path = require("node:path");
const {
  VAULT_ROOT,
  PROJECT_DIR,
  projectFile: getProjectFile,
  notePath,
} = require("./paths.js");
const { extractSection, parseFrontmatter, getTitle } = require("./markdown.js");

function isoWeek(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekRange(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  const day = base.getDay();
  const mondayOffset = (day + 6) % 7;
  const monday = new Date(y, m - 1, d - mondayOffset);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(
      monday.getFullYear(),
      monday.getMonth(),
      monday.getDate() + i,
    );
    dates.push(formatDate(cur));
  }
  return { monday: dates[0], sunday: dates[6], dates: new Set(dates) };
}

function collectWeekEntries(dateStr) {
  const { dates } = weekRange(dateStr);
  const [y, m, d] = dateStr.split("-").map(Number);
  const { year, week } = isoWeek(new Date(y, m - 1, d));
  const weekLabel = `${year}-W${String(week).padStart(2, "0")}`;
  const groups = [];
  const datePattern = /✅ (\d{4}-\d{2}-\d{2})/;

  if (fs.existsSync(PROJECT_DIR)) {
    const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_") || entry.name.startsWith("-")) continue;
      const slug = entry.name;
      const filePath = getProjectFile(slug);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      const title = getTitle(content) || slug;
      const changelog = extractSection(content, "Changelog");
      const matched = changelog.filter((l) => {
        const match = l.match(datePattern);
        return match && dates.has(match[1]);
      });
      if (matched.length > 0) {
        groups.push({ title, sourceType: "project", entries: matched });
      }
    }
  }

  return { weekLabel, groups };
}

function collectDailySummaries(dateStr) {
  const { dates } = weekRange(dateStr);
  const summaries = [];
  for (const d of dates) {
    const np = notePath(d);
    if (!fs.existsSync(np)) continue;
    const content = fs.readFileSync(np, "utf-8");
    const section = extractSection(content, "Summary");
    if (section.length === 0) continue;
    summaries.push({ date: d, text: section.join("\n") });
  }
  return summaries;
}

function buildWeeklyPrompt(weekLabel, groups, dailySummaries, outputPath) {
  const parts = [`Write a narrative weekly work summary for ${weekLabel}.`];
  parts.push("");
  parts.push("## Daily summaries");
  if (dailySummaries.length > 0) {
    for (const s of dailySummaries) {
      parts.push("", `### ${s.date}`, "", s.text);
    }
  } else {
    parts.push("", "(no daily summaries available)");
  }
  parts.push("", "## Changelog entries");
  for (const g of groups) {
    parts.push("", `### ${g.title}`);
    for (const e of g.entries) parts.push(e);
  }
  parts.push("", "## Instructions");
  parts.push("");
  parts.push(`Write the summary to ${outputPath} using the Write tool.`);
  parts.push("");
  parts.push("The summary should cover:");
  parts.push("- What was accomplished this week, grouped by project or theme");
  parts.push("- What moved forward but is not finished");
  parts.push("- What is still open or blocked");
  parts.push(
    "- Any patterns worth noting (e.g., most of the week on one project, context-switching)",
  );
  parts.push("");
  parts.push(
    "Write in a dry, factual tone. No enthusiasm. No filler. Complete sentences.",
  );
  parts.push(
    `Use markdown. Start with "# ${weekLabel} Work Summary" as the heading.`,
  );
  return parts.join("\n");
}

function writeWeeklySummary(dateStr) {
  const { execFileSync } = require("node:child_process");
  const { weekLabel, groups } = collectWeekEntries(dateStr);
  const dailySummaries = collectDailySummaries(dateStr);
  if (groups.length === 0 && dailySummaries.length === 0) return null;
  const dir = path.join(VAULT_ROOT, "weekly");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${weekLabel}.md`);
  const prompt = buildWeeklyPrompt(weekLabel, groups, dailySummaries, filePath);
  const claudeCmd = process.env.WORK_CLAUDE_CMD || "claude";
  execFileSync(claudeCmd, ["-p", "--allowedTools", "Write"], {
    input: prompt,
    stdio: ["pipe", "inherit", "inherit"],
    timeout: 120000,
  });
  return filePath;
}

module.exports = {
  isoWeek,
  weekRange,
  collectWeekEntries,
  collectDailySummaries,
  buildWeeklyPrompt,
  writeWeeklySummary,
};
