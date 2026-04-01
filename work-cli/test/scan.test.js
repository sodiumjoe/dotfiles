const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("scan", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-test-"));
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
    const libDir = path.join(__dirname, "..", "lib");
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
    process.env.WORK_VAULT = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "config");
    return require(path.join(libDir, "scan.js"));
  }

  function writeProject(slug, content) {
    const dir = path.join(tmpDir, "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.md"), content);
  }

  function projectPath(slug) {
    return path.join(tmpDir, "projects", slug, "project.md");
  }

  function writeDailyNote(dateStr, content) {
    fs.writeFileSync(path.join(tmpDir, `${dateStr}.md`), content);
  }

  describe("scanOpenItems", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("finds open tasks in active projects", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] Open task
- [x] Done task

## Changelog

## Notes`,
      );

      const { scanOpenItems } = requireFresh();
      const results = scanOpenItems();
      assert.equal(results.length, 1);
      assert.equal(results[0].itemText, "Open task");
      assert.equal(results[0].sourceType, "project");
      assert.equal(results[0].projectSlug, "proj");
    });

    it("finds in-progress tasks", () => {
      writeProject(
        "wip",
        `---
status: active
---

# WIP

## Tasks
- [/] In progress

## Changelog

## Notes`,
      );

      const { scanOpenItems } = requireFresh();
      const results = scanOpenItems();
      assert.equal(results.length, 1);
      assert.equal(results[0].state, "/");
    });

    it("skips non-active non-evergreen projects", () => {
      writeProject(
        "done",
        `---
status: completed
---

# Done

## Tasks
- [ ] Leftover

## Changelog

## Notes`,
      );

      const { scanOpenItems } = requireFresh();
      const results = scanOpenItems();
      assert.equal(results.length, 0);
    });

    it("includes evergreen projects", () => {
      writeProject(
        "eg",
        `---
status: evergreen
---

# Evergreen

## Tasks
- [ ] Recurring task

## Changelog

## Notes`,
      );

      const { scanOpenItems } = requireFresh();
      const results = scanOpenItems();
      assert.equal(results.length, 1);
      assert.equal(results[0].evergreen, true);
    });

    it("adds placeholder for evergreen projects with no open tasks", () => {
      writeProject(
        "eg-empty",
        `---
status: evergreen
---

# Evergreen Empty

## Tasks

## Changelog

## Notes`,
      );

      const { scanOpenItems } = requireFresh();
      const results = scanOpenItems();
      assert.equal(results.length, 1);
      assert.equal(results[0].itemText, "");
      assert.equal(results[0].evergreen, true);
    });
  });

  describe("formatScanTSV", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("formats results as TSV", () => {
      const { formatScanTSV } = requireFresh();
      const tsv = formatScanTSV([
        {
          filename: "proj.md",
          title: "Proj",
          itemText: "Task",
          sourceType: "project",
          state: " ",
          projectSlug: "proj",
        },
      ]);
      assert.ok(tsv.includes("proj.md\tProj\tTask\tproject\t \tproj"));
    });

    it("returns empty string for empty results", () => {
      const { formatScanTSV } = requireFresh();
      assert.equal(formatScanTSV([]), "");
    });
  });

  describe("syncCheck", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("finds completed items not in daily note log", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks

## Changelog
- [x] Done today ✅ 2026-03-10

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      const { syncCheck } = requireFresh();
      const results = syncCheck("2026-03-10");
      assert.equal(results.length, 1);
      assert.ok(results[0].itemText.includes("Done today"));
    });

    it("excludes items already in daily note log", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks

## Changelog
- [x] Already logged ✅ 2026-03-10

## Notes`,
      );

      writeDailyNote(
        "2026-03-10",
        "## Tasks\n\n## Log\n- [x] Already logged ✅ 2026-03-10 — [[projects/proj/project|Proj]]\n",
      );

      const { syncCheck } = requireFresh();
      const results = syncCheck("2026-03-10");
      assert.equal(results.length, 0);
    });

    it("returns empty when no completions today", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] Not done

## Changelog

## Notes`,
      );

      const { syncCheck } = requireFresh();
      const results = syncCheck("2026-03-10");
      assert.equal(results.length, 0);
    });
  });

  describe("listTasks", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("returns tasks with line numbers from all active projects", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] First task
- [/] In progress task
- [x] Done task

## Changelog

## Notes`,
      );

      const { listTasks } = requireFresh();
      const results = listTasks();
      assert.equal(results.length, 2);
      assert.equal(results[0].description, "First task");
      assert.equal(results[0].state, " ");
      assert.equal(results[0].line, 8);
      assert.equal(results[1].description, "In progress task");
      assert.equal(results[1].state, "/");
      assert.equal(results[1].line, 9);
    });

    it("filters to active and evergreen projects", () => {
      writeProject(
        "active",
        `---
status: active
---

# Active

## Tasks
- [ ] Active task

## Changelog`,
      );

      writeProject(
        "evergreen",
        `---
status: evergreen
---

# Evergreen

## Tasks
- [ ] Evergreen task

## Changelog`,
      );

      writeProject(
        "completed",
        `---
status: completed
---

# Completed

## Tasks
- [ ] Should not appear

## Changelog`,
      );

      const { listTasks } = requireFresh();
      const results = listTasks();
      assert.equal(results.length, 2);
      const descriptions = results.map((r) => r.description);
      assert.ok(descriptions.includes("Active task"));
      assert.ok(descriptions.includes("Evergreen task"));
    });

    it("returns tasks from single file regardless of status", () => {
      writeProject(
        "completed",
        `---
status: completed
---

# Completed

## Tasks
- [ ] Leftover task

## Changelog`,
      );

      const { listTasks } = requireFresh();
      const results = listTasks(projectPath("completed"));
      assert.equal(results.length, 1);
      assert.equal(results[0].description, "Leftover task");
    });

    it("returns empty array for empty tasks section", () => {
      writeProject(
        "empty",
        `---
status: active
---

# Empty

## Tasks

## Changelog`,
      );

      const { listTasks } = requireFresh();
      const results = listTasks();
      assert.equal(results.length, 0);
    });

    it("returns absolute file paths", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] A task

## Changelog`,
      );

      const { listTasks } = requireFresh();
      const results = listTasks();
      assert.ok(path.isAbsolute(results[0].file));
    });

    it("returns empty array for nonexistent file", () => {
      const { listTasks } = requireFresh();
      const results = listTasks("/nonexistent/file.md");
      assert.equal(results.length, 0);
    });
  });

  describe("setTaskState", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("sets open task to in-progress", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] My task

## Changelog`,
      );

      const filePath = projectPath("proj");
      const { setTaskState } = requireFresh();
      setTaskState(filePath, 8, "in-progress", "2026-03-10");

      const result = fs.readFileSync(filePath, "utf-8");
      assert.ok(result.includes("- [/] My task"));
    });

    it("sets in-progress task to done with date stamp", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [/] My task

## Changelog`,
      );

      const filePath = projectPath("proj");
      const { setTaskState } = requireFresh();
      setTaskState(filePath, 8, "done", "2026-03-10");

      const result = fs.readFileSync(filePath, "utf-8");
      assert.ok(result.includes("- [x] My task ✅ 2026-03-10"));
    });

    it("sets done task back to open and strips date", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [x] My task ✅ 2026-03-10

## Changelog`,
      );

      const filePath = projectPath("proj");
      const { setTaskState } = requireFresh();
      setTaskState(filePath, 8, "open", "2026-03-10");

      const result = fs.readFileSync(filePath, "utf-8");
      assert.ok(result.includes("- [ ] My task"));
      assert.ok(!result.includes("✅"));
    });

    it("preserves existing done date when setting to done", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] My task ✅ 2026-03-05

## Changelog`,
      );

      const filePath = projectPath("proj");
      const { setTaskState } = requireFresh();
      setTaskState(filePath, 8, "done", "2026-03-10");

      const result = fs.readFileSync(filePath, "utf-8");
      assert.ok(result.includes("✅ 2026-03-05"));
      assert.ok(!result.includes("✅ 2026-03-10"));
    });

    it("preserves other lines unchanged", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] First
- [ ] Second
- [ ] Third

## Changelog`,
      );

      const filePath = projectPath("proj");
      const { setTaskState } = requireFresh();
      setTaskState(filePath, 9, "in-progress", "2026-03-10");

      const result = fs.readFileSync(filePath, "utf-8");
      assert.ok(result.includes("- [ ] First"));
      assert.ok(result.includes("- [/] Second"));
      assert.ok(result.includes("- [ ] Third"));
    });

    it("throws on invalid line number", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] Task

## Changelog`,
      );

      const filePath = projectPath("proj");
      const { setTaskState } = requireFresh();
      assert.throws(
        () => setTaskState(filePath, 999, "done", "2026-03-10"),
        /out of range/,
      );
    });

    it("throws on non-checkbox line", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] Task

## Changelog`,
      );

      const filePath = projectPath("proj");
      const { setTaskState } = requireFresh();
      assert.throws(
        () => setTaskState(filePath, 7, "done", "2026-03-10"),
        /not a checkbox/,
      );
    });

    it("throws on missing file", () => {
      const { setTaskState } = requireFresh();
      assert.throws(
        () => setTaskState("/nonexistent/file.md", 1, "done", "2026-03-10"),
        /file not found/,
      );
    });
  });
});
