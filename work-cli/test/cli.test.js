const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

describe("cli", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;
  const workBin = path.join(__dirname, "..", "bin", "work");

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
    fs.mkdirSync(path.join(tmpDir, "projects"));
    fs.mkdirSync(path.join(tmpDir, "config", "work"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "config", "work", "config.json"),
      JSON.stringify({}),
    );
    origVault = process.env.WORK_VAULT;
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.WORK_VAULT = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "config");
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

  beforeEach(setup);
  afterEach(teardown);

  function runWork(...args) {
    return execFileSync("node", [workBin, ...args], {
      env: {
        ...process.env,
        WORK_VAULT: tmpDir,
        XDG_CONFIG_HOME: path.join(tmpDir, "config"),
        WORK_TEST_HOUR: "10",
        WORK_SKIP_REVIEWS: "1",
        WORK_SKIP_UPGRADES: "1",
        CLAUDECODE: "",
      },
      encoding: "utf-8",
      timeout: 10000,
    });
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

  function readDailyNote(dateStr) {
    return fs.readFileSync(path.join(tmpDir, `${dateStr}.md`), "utf-8");
  }

  describe("work create-project", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("creates project file", () => {
      const output = runWork("create-project", "test-proj", "Test Project");
      assert.ok(output.includes("project.md"));
      const result = fs.readFileSync(projectPath("test-proj"), "utf-8");
      assert.ok(result.includes("# Test Project"));
      assert.ok(result.includes("status: active"));
    });

    it("rejects missing arguments", () => {
      assert.throws(() => runWork("create-project", "only-slug"), /usage/);
    });
  });

  describe("work complete", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("checks off task and logs to daily note", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] Build feature

## Changelog

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      runWork(
        "complete",
        projectPath("proj"),
        "Build feature",
        "--date=2026-03-10",
      );

      const proj = fs.readFileSync(projectPath("proj"), "utf-8");
      assert.ok(proj.includes("- [x] Build feature ✅ 2026-03-10"));

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("Build feature"));
      assert.ok(note.includes("[[projects/proj/project|Proj]]"));
    });
  });

  describe("work append-task", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("adds task to Tasks section", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks

## Changelog

## Notes`,
      );

      runWork("append-task", projectPath("proj"), "New task");

      const result = fs.readFileSync(projectPath("proj"), "utf-8");
      assert.ok(result.includes("- [ ] New task"));
    });
  });

  describe("work paths", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("prints configured paths", () => {
      const output = runWork("paths");
      assert.ok(output.includes("vault"));
      assert.ok(output.includes("projects"));
    });

    it("prints specific path by key", () => {
      const output = runWork("paths", "vault");
      assert.equal(output, tmpDir);
    });
  });

  describe("work summary", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("outputs completed and open items", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] Open task

## Changelog

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n- [x] Done thing\n");

      const output = runWork("summary", "--date=2026-03-10");
      assert.ok(output.includes("### Completed"));
      assert.ok(output.includes("### Open"));
      assert.ok(output.includes("Done thing"));
      assert.ok(output.includes("Open task"));
    });
  });

  describe("work list-projects", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("lists active and evergreen projects as TSV", () => {
      writeProject(
        "alpha",
        `---
status: active
---

# Alpha

## Tasks`,
      );

      writeProject(
        "beta",
        `---
status: evergreen
---

# Beta

## Tasks`,
      );

      writeProject(
        "done",
        `---
status: completed
---

# Done

## Changelog
- [x] Item ✅ 2026-03-01`,
      );

      const output = runWork("list-projects");
      assert.ok(output.includes("alpha\tAlpha\tactive"));
      assert.ok(output.includes("beta\tBeta\tevergreen"));
      assert.ok(!output.includes("done"));
    });

    it("outputs nothing for empty projects dir", () => {
      const output = runWork("list-projects");
      assert.equal(output.trim(), "");
    });
  });

  describe("work list-tasks", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("lists open tasks with line numbers", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] First task
- [/] Second task
- [x] Done task

## Changelog`,
      );

      const output = runWork("list-tasks");
      const lines = output.trim().split("\n");
      assert.equal(lines.length, 2);
      assert.ok(lines[0].includes("\t8\t \tProj\tFirst task"));
      assert.ok(lines[1].includes("\t9\t/\tProj\tSecond task"));
    });

    it("lists tasks from specific file", () => {
      writeProject(
        "proj",
        `---
status: completed
---

# Proj

## Tasks
- [ ] Leftover

## Changelog`,
      );

      const output = runWork("list-tasks", projectPath("proj"));
      assert.ok(output.includes("Leftover"));
    });

    it("outputs nothing for no tasks", () => {
      const output = runWork("list-tasks");
      assert.equal(output.trim(), "");
    });
  });

  describe("work set-task-state", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("sets task to in-progress", () => {
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
      runWork("set-task-state", filePath, "8", "in-progress");

      const result = fs.readFileSync(filePath, "utf-8");
      assert.ok(result.includes("- [/] My task"));
    });

    it("sets task to done with date", () => {
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
      runWork("set-task-state", filePath, "8", "done", "--date=2026-03-10");

      const result = fs.readFileSync(filePath, "utf-8");
      assert.ok(result.includes("- [x] My task ✅ 2026-03-10"));
    });

    it("rejects missing arguments", () => {
      assert.throws(() => runWork("set-task-state", "file", "1"), /usage/);
    });
  });

  describe("work close-tasks", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("bulk-closes open tasks and outputs counts", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] First task
- [ ] Second task
- [/] Third task

## Changelog

## Notes`,
      );

      const output = runWork(
        "close-tasks",
        projectPath("proj"),
        "--date=2026-03-25",
      );
      assert.match(output, /3\t0/);

      const result = fs.readFileSync(projectPath("proj"), "utf-8");
      assert.ok(result.includes("- [x] First task ✅ 2026-03-25"));
      assert.ok(result.includes("- [x] Second task ✅ 2026-03-25"));
      assert.ok(result.includes("- [x] Third task ✅ 2026-03-25"));
    });

    it("skips specified lines as cancelled", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] Keep this
- [ ] Cancel this

## Changelog`,
      );

      const output = runWork(
        "close-tasks",
        projectPath("proj"),
        "--skip=9",
        "--date=2026-03-25",
      );
      assert.match(output, /1\t1/);

      const result = fs.readFileSync(projectPath("proj"), "utf-8");
      assert.ok(result.includes("- [x] Keep this ✅ 2026-03-25"));
      assert.ok(result.includes("- [-] Cancel this"));
    });
  });

  describe("work close-project", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("completes project with summary", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks

## Changelog
- [x] Did something ✅ 2026-03-20

## Notes`,
      );

      writeDailyNote("2026-03-25", "## Tasks\n\n## Log\n");

      runWork("close-project", "proj", "Summary text", "--date=2026-03-25");

      const result = fs.readFileSync(projectPath("proj"), "utf-8");
      assert.ok(result.includes("status: completed"));
      assert.ok(result.includes("completed_at: 2026-03-25"));
    });

    it("rejects when open tasks remain", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Proj

## Tasks
- [ ] Still open

## Changelog`,
      );

      writeDailyNote("2026-03-25", "## Tasks\n\n## Log\n");

      assert.throws(
        () => runWork("close-project", "proj", "Summary", "--date=2026-03-25"),
        /open tasks remain/,
      );
    });
  });

  describe("work close-plan", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("marks plan as done with findings flag", () => {
      const planFile = path.join(tmpDir, "test-plan.md");
      fs.writeFileSync(
        planFile,
        `---
status: active
project: "[[projects/proj/project|Proj]]"
---

# Test Plan

## Approach
Do the thing.`,
      );

      runWork("close-plan", planFile);

      const result = fs.readFileSync(planFile, "utf-8");
      assert.ok(result.includes("status: done"));
      assert.ok(result.includes("findings_extracted: true"));
      assert.ok(!result.includes("status: active"));
    });
  });

  describe("work help", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("prints help text", () => {
      const output = runWork("help");
      assert.ok(output.includes("Usage:"));
      assert.ok(output.includes("Commands:"));
    });
  });
});
