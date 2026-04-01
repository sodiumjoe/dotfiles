const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("summary", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;
  const libDir = path.join(__dirname, "..", "lib");

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-test-"));
    fs.mkdirSync(path.join(tmpDir, "projects"));
    fs.mkdirSync(path.join(tmpDir, "config", "work"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "config", "work", "config.json"),
      JSON.stringify({}),
    );
    origVault = process.env.WORK_VAULT;
    origXdg = process.env.XDG_CONFIG_HOME;
  }

  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origVault === undefined) {
      delete process.env.WORK_VAULT;
    } else {
      process.env.WORK_VAULT = origVault;
    }
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
  }

  function requireFresh() {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
    process.env.WORK_VAULT = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "config");
    return require(path.join(libDir, "summary.js"));
  }

  function writeProject(slug, content) {
    const dir = path.join(tmpDir, "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.md"), content);
  }

  function writeDailyNote(dateStr, content) {
    fs.writeFileSync(path.join(tmpDir, `${dateStr}.md`), content);
  }

  describe("isoWeek", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("returns correct week for mid-year date", () => {
      const { isoWeek } = requireFresh();
      const result = isoWeek(new Date(2026, 2, 8));
      assert.equal(result.year, 2026);
      assert.equal(result.week, 10);
    });

    it("returns correct week for start of year", () => {
      const { isoWeek } = requireFresh();
      const result = isoWeek(new Date(2026, 0, 5));
      assert.equal(result.year, 2026);
      assert.equal(result.week, 2);
    });

    it("handles year boundary: 2025-12-29 is W01 of 2026", () => {
      const { isoWeek } = requireFresh();
      const result = isoWeek(new Date(2025, 11, 29));
      assert.equal(result.year, 2026);
      assert.equal(result.week, 1);
    });
  });

  describe("weekRange", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("returns Monday-Sunday for a Sunday date", () => {
      const { weekRange } = requireFresh();
      const result = weekRange("2026-03-08");
      assert.equal(result.monday, "2026-03-02");
      assert.equal(result.sunday, "2026-03-08");
      assert.equal(result.dates.size, 7);
      assert.ok(result.dates.has("2026-03-02"));
      assert.ok(result.dates.has("2026-03-08"));
    });

    it("returns correct range for a Wednesday", () => {
      const { weekRange } = requireFresh();
      const result = weekRange("2026-03-04");
      assert.equal(result.monday, "2026-03-02");
      assert.equal(result.sunday, "2026-03-08");
    });
  });

  describe("collectWeekEntries", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("finds project entries in date range", () => {
      writeProject(
        "proj",
        `---
status: active
---

# My Project

## Changelog
- [x] In range ✅ 2026-03-05
- [x] Out of range ✅ 2026-03-15`,
      );

      const { collectWeekEntries } = requireFresh();
      const result = collectWeekEntries("2026-03-08");
      assert.equal(result.groups.length, 1);
      assert.equal(result.groups[0].title, "My Project");
      assert.equal(result.groups[0].entries.length, 1);
      assert.ok(result.groups[0].entries[0].includes("In range"));
    });

    it("returns empty groups when nothing matches", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Project

## Changelog
- [x] Old entry ✅ 2026-01-01`,
      );

      const { collectWeekEntries } = requireFresh();
      const result = collectWeekEntries("2026-03-08");
      assert.equal(result.groups.length, 0);
    });

    it("returns correct weekLabel", () => {
      const { collectWeekEntries } = requireFresh();
      const result = collectWeekEntries("2026-03-08");
      assert.equal(result.weekLabel, "2026-W10");
    });
  });

  describe("collectDailySummaries", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("collects summaries from daily notes in the week", () => {
      writeDailyNote(
        "2026-03-05",
        "## Tasks\n\n## Summary\nWorked on feature X.\n\n## Log\n",
      );
      writeDailyNote(
        "2026-03-06",
        "## Tasks\n\n## Summary\nFixed bug Y.\n\n## Log\n",
      );

      const { collectDailySummaries } = requireFresh();
      const result = collectDailySummaries("2026-03-08");
      assert.equal(result.length, 2);
      assert.equal(result[0].date, "2026-03-05");
      assert.ok(result[0].text.includes("feature X"));
      assert.equal(result[1].date, "2026-03-06");
      assert.ok(result[1].text.includes("bug Y"));
    });

    it("skips days without daily notes", () => {
      writeDailyNote(
        "2026-03-05",
        "## Tasks\n\n## Summary\nSomething.\n\n## Log\n",
      );

      const { collectDailySummaries } = requireFresh();
      const result = collectDailySummaries("2026-03-08");
      assert.equal(result.length, 1);
    });

    it("skips daily notes without Summary section", () => {
      writeDailyNote("2026-03-05", "## Tasks\n\n## Log\n");

      const { collectDailySummaries } = requireFresh();
      const result = collectDailySummaries("2026-03-08");
      assert.equal(result.length, 0);
    });

    it("returns empty array when no notes exist", () => {
      const { collectDailySummaries } = requireFresh();
      const result = collectDailySummaries("2026-03-08");
      assert.equal(result.length, 0);
    });
  });

  describe("buildWeeklyPrompt", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("includes daily summaries and changelog entries", () => {
      const { buildWeeklyPrompt } = requireFresh();
      const result = buildWeeklyPrompt(
        "2026-W10",
        [
          {
            title: "Project A",
            sourceType: "project",
            entries: ["- [x] Entry 1 ✅ 2026-03-05"],
          },
        ],
        [{ date: "2026-03-05", text: "Worked on Project A." }],
        "/tmp/weekly/2026-W10.md",
      );
      assert.ok(result.includes("2026-W10"));
      assert.ok(result.includes("Daily summaries"));
      assert.ok(result.includes("2026-03-05"));
      assert.ok(result.includes("Worked on Project A"));
      assert.ok(result.includes("Changelog entries"));
      assert.ok(result.includes("Project A"));
      assert.ok(result.includes("Entry 1"));
      assert.ok(result.includes("/tmp/weekly/2026-W10.md"));
    });

    it("handles no daily summaries", () => {
      const { buildWeeklyPrompt } = requireFresh();
      const result = buildWeeklyPrompt(
        "2026-W10",
        [
          {
            title: "Project A",
            sourceType: "project",
            entries: ["- [x] Entry ✅ 2026-03-05"],
          },
        ],
        [],
        "/tmp/weekly/2026-W10.md",
      );
      assert.ok(result.includes("no daily summaries available"));
    });
  });

  describe("writeWeeklySummary", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("spawns claude with correct prompt and creates file", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Project

## Changelog
- [x] Work done ✅ 2026-03-05`,
      );

      writeDailyNote(
        "2026-03-05",
        "## Tasks\n\n## Summary\nDid work.\n\n## Log\n",
      );

      const weeklyDir = path.join(tmpDir, "weekly");
      const outputPath = path.join(weeklyDir, "2026-W10.md");
      const stdinFile = path.join(tmpDir, "claude-stdin.txt");
      const argsFile = path.join(tmpDir, "claude-args.txt");
      const fakeClaude = path.join(tmpDir, "fake-claude.js");
      fs.writeFileSync(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          `const fs = require('fs');`,
          `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
          `let stdin = '';`,
          `process.stdin.setEncoding('utf-8');`,
          `process.stdin.on('data', d => stdin += d);`,
          `process.stdin.on('end', () => {`,
          `  fs.writeFileSync(${JSON.stringify(stdinFile)}, stdin);`,
          `  fs.mkdirSync(${JSON.stringify(weeklyDir)}, { recursive: true });`,
          `  fs.writeFileSync(${JSON.stringify(outputPath)}, '# 2026-W10 Work Summary\\n\\nNarrative here.');`,
          `});`,
        ].join("\n"),
        { mode: 0o755 },
      );

      process.env.WORK_CLAUDE_CMD = fakeClaude;
      const { writeWeeklySummary } = requireFresh();
      const filePath = writeWeeklySummary("2026-03-08");

      assert.ok(filePath);
      assert.ok(filePath.endsWith("2026-W10.md"));
      assert.ok(fs.existsSync(filePath));
      const content = fs.readFileSync(filePath, "utf-8");
      assert.ok(content.includes("2026-W10 Work Summary"));

      const args = JSON.parse(fs.readFileSync(argsFile, "utf-8"));
      assert.ok(args.includes("-p"));
      assert.ok(args.includes("--allowedTools"));
      assert.ok(args.includes("Write"));

      const stdin = fs.readFileSync(stdinFile, "utf-8");
      assert.ok(stdin.includes("Daily summaries"));
      assert.ok(stdin.includes("Did work"));
      assert.ok(stdin.includes("Changelog entries"));
      assert.ok(stdin.includes("Work done"));

      delete process.env.WORK_CLAUDE_CMD;
    });

    it("returns null when no entries and no summaries", () => {
      const { writeWeeklySummary } = requireFresh();
      const result = writeWeeklySummary("2026-03-08");
      assert.equal(result, null);
      assert.ok(!fs.existsSync(path.join(tmpDir, "weekly")));
    });
  });
});
