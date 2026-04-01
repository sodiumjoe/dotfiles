const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("project", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-test-"));
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

  function writeProject(slug, content) {
    const dir = path.join(tmpDir, "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.md"), content);
  }

  function projectPath(slug) {
    return path.join(tmpDir, "projects", slug, "project.md");
  }

  function writePlanInProject(slug, planName, content) {
    const dir = path.join(tmpDir, "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, planName), content);
  }

  function requireFresh() {
    const libDir = path.join(__dirname, "..", "lib");
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
    process.env.WORK_VAULT = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "config");
    return require(path.join(libDir, "project.js"));
  }

  describe("completeProjects", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("marks a fully checked-off project as completed", () => {
      writeProject(
        "done-proj",
        `---
status: active
---

# Done Project

## Changelog
- [x] Step one ✅ 2026-03-01
- [x] Step two ✅ 2026-03-02

## Notes`,
      );

      const { completeProjects } = requireFresh();
      const completed = completeProjects({ quiet: true });
      assert.equal(completed.length, 1);
      assert.equal(completed[0].file, "done-proj/project.md");

      const result = fs.readFileSync(projectPath("done-proj"), "utf-8");
      assert.ok(result.includes("status: completed"));
      assert.ok(!result.includes("status: active"));
    });

    it("skips projects with open items", () => {
      writeProject(
        "mixed",
        `---
status: active
---

# Mixed

## Changelog
- [x] Done item ✅ 2026-03-01
- [ ] Open item

## Notes`,
      );

      const { completeProjects } = requireFresh();
      const completed = completeProjects({ quiet: true });
      assert.equal(completed.length, 0);

      const result = fs.readFileSync(projectPath("mixed"), "utf-8");
      assert.ok(result.includes("status: active"));
    });

    it("skips projects with no changelog items", () => {
      writeProject(
        "empty",
        `---
status: active
---

# Empty

## Changelog

## Notes`,
      );

      const { completeProjects } = requireFresh();
      const completed = completeProjects({ quiet: true });
      assert.equal(completed.length, 0);
    });

    it("skips already completed projects", () => {
      writeProject(
        "already",
        `---
status: completed
---

# Already Done

## Changelog
- [x] Item ✅ 2026-03-01

## Notes`,
      );

      const { completeProjects } = requireFresh();
      const completed = completeProjects({ quiet: true });
      assert.equal(completed.length, 0);
    });

    it("is idempotent", () => {
      writeProject(
        "idem",
        `---
status: active
---

# Idempotent

## Changelog
- [x] Only item ✅ 2026-03-01

## Notes`,
      );

      const mod = requireFresh();
      mod.completeProjects({ quiet: true });
      mod.completeProjects({ quiet: true });

      const result = fs.readFileSync(projectPath("idem"), "utf-8");
      assert.ok(result.includes("status: completed"));
      const matches = result.match(/status:/g);
      assert.equal(matches.length, 1);
    });

    it("stamps completed_at when marking completed", () => {
      writeProject(
        "stamp",
        `---
status: active
---

# Stamp

## Changelog
- [x] Done ✅ 2026-03-01

## Notes`,
      );

      const { completeProjects } = requireFresh();
      completeProjects({ quiet: true });

      const result = fs.readFileSync(projectPath("stamp"), "utf-8");
      assert.ok(result.includes("status: completed"));
      assert.match(result, /completed_at: \d{4}-\d{2}-\d{2}/);
    });

    it("skips permanent projects", () => {
      writeProject(
        "perm",
        `---
status: active
permanent: true
---

# Permanent

## Changelog
- [x] Done ✅ 2026-03-01

## Notes`,
      );

      const { completeProjects } = requireFresh();
      const completed = completeProjects({ quiet: true });
      assert.equal(completed.length, 0);

      const result = fs.readFileSync(projectPath("perm"), "utf-8");
      assert.ok(result.includes("status: active"));
    });

    it("skips evergreen projects", () => {
      writeProject(
        "eg",
        `---
status: evergreen
---

# Evergreen

## Changelog
- [x] Done ✅ 2026-03-01

## Notes`,
      );

      const { completeProjects } = requireFresh();
      const completed = completeProjects({ quiet: true });
      assert.equal(completed.length, 0);

      const result = fs.readFileSync(projectPath("eg"), "utf-8");
      assert.ok(result.includes("status: evergreen"));
    });

    it("blocks completion when Tasks section has open items", () => {
      writeProject(
        "open-tasks",
        `---
status: active
---

# Open Tasks

## Tasks
- [ ] Not done yet

## Changelog
- [x] Done ✅ 2026-03-01

## Notes`,
      );

      const { completeProjects } = requireFresh();
      const completed = completeProjects({ quiet: true });
      assert.equal(completed.length, 0);

      const result = fs.readFileSync(projectPath("open-tasks"), "utf-8");
      assert.ok(result.includes("status: active"));
    });

    it("blocks completion when Tasks has in-progress [/] items", () => {
      writeProject(
        "in-prog",
        `---
status: active
---

# In Progress

## Tasks
- [/] Working on it

## Changelog
- [x] Done ✅ 2026-03-01

## Notes`,
      );

      const { completeProjects } = requireFresh();
      const completed = completeProjects({ quiet: true });
      assert.equal(completed.length, 0);

      const result = fs.readFileSync(projectPath("in-prog"), "utf-8");
      assert.ok(result.includes("status: active"));
    });

    it("does not duplicate completed_at on re-run", () => {
      writeProject(
        "no-dup",
        `---
status: completed
completed_at: 2026-03-01
---

# No Dup

## Changelog
- [x] Done ✅ 2026-03-01

## Notes`,
      );

      const { completeProjects } = requireFresh();
      completeProjects({ quiet: true });

      const result = fs.readFileSync(projectPath("no-dup"), "utf-8");
      const matches = result.match(/completed_at/g);
      assert.equal(matches.length, 1);
    });
  });

  describe("archiveProject", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("moves project directory to archive/projects/", () => {
      writeProject(
        "done",
        `---
status: completed
---

# Done

## Changelog
- [x] Item ✅ 2026-03-01`,
      );

      const { archiveProject } = requireFresh();
      archiveProject("done", { quiet: true });

      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "done")));
      assert.ok(
        fs.existsSync(
          path.join(tmpDir, "archive", "projects", "done", "project.md"),
        ),
      );
    });

    it("throws for nonexistent project", () => {
      const { archiveProject } = requireFresh();
      assert.throws(
        () => archiveProject("nonexistent", { quiet: true }),
        /not found/,
      );
    });

    it("handles project with no associated plans", () => {
      writeProject(
        "solo",
        `---
status: completed
---

# Solo

## Changelog
- [x] Item ✅ 2026-03-01`,
      );

      const { archiveProject } = requireFresh();
      archiveProject("solo", { quiet: true });

      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "solo")));
      assert.ok(
        fs.existsSync(
          path.join(tmpDir, "archive", "projects", "solo", "project.md"),
        ),
      );
    });

    it("archives active project (does not check status)", () => {
      writeProject(
        "active",
        `---
status: active
---

# Active

## Tasks
- [ ] Still working

## Changelog

## Notes`,
      );

      const { archiveProject } = requireFresh();
      archiveProject("active", { quiet: true });

      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "active")));
      assert.ok(
        fs.existsSync(
          path.join(tmpDir, "archive", "projects", "active", "project.md"),
        ),
      );
    });
  });

  describe("createProject", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("creates project file with standard template", () => {
      const { createProject } = requireFresh();
      createProject("my-proj", "My Project");

      const result = fs.readFileSync(projectPath("my-proj"), "utf-8");
      assert.ok(result.includes("status: active"));
      assert.ok(result.includes("# My Project"));
      assert.ok(result.includes("## Tasks"));
      assert.ok(result.includes("## Changelog"));
      assert.ok(result.includes("## Notes"));
    });

    it("rejects slug with spaces", () => {
      const { createProject } = requireFresh();
      assert.throws(() => createProject("bad slug", "Bad"), /invalid slug/);
    });

    it("rejects slug with slash", () => {
      const { createProject } = requireFresh();
      assert.throws(() => createProject("bad/slug", "Bad"), /invalid slug/);
    });

    it("rejects empty slug", () => {
      const { createProject } = requireFresh();
      assert.throws(() => createProject("", "Bad"), /invalid slug/);
    });

    it("throws if project already exists", () => {
      writeProject("exists", "# Exists");
      const { createProject } = requireFresh();
      assert.throws(() => createProject("exists", "Exists"), /exists/);
    });
  });

  describe("resolveProject", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("resolves project from plan frontmatter", () => {
      writeProject(
        "target",
        `---
status: active
---

# Target`,
      );

      const planFile = path.join(tmpDir, "projects", "target", "test-plan.md");
      writePlanInProject(
        "target",
        "test-plan.md",
        `---
status: active
project: "[[projects/target/project]]"
---

# Test Plan`,
      );

      const { resolveProject } = requireFresh();
      resolveProject(planFile);
    });

    it("returns undefined for missing plan file", () => {
      const { resolveProject } = requireFresh();
      const result = resolveProject("/nonexistent/plan.md");
      assert.equal(result, undefined);
    });

    it("returns undefined for plan with no project field", () => {
      writePlanInProject(
        "some-proj",
        "no-proj.md",
        `---
status: active
---

# No Project`,
      );

      const { resolveProject } = requireFresh();
      const result = resolveProject(
        path.join(tmpDir, "projects", "some-proj", "no-proj.md"),
      );
      assert.equal(result, undefined);
    });
  });

  describe("listProjects", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("returns active projects", () => {
      writeProject(
        "alpha",
        `---
status: active
---

# Alpha

## Tasks

## Changelog`,
      );

      const { listProjects } = requireFresh();
      const results = listProjects();
      assert.equal(results.length, 1);
      assert.equal(results[0].slug, "alpha");
      assert.equal(results[0].title, "Alpha");
      assert.equal(results[0].status, "active");
    });

    it("returns evergreen projects", () => {
      writeProject(
        "infra",
        `---
status: evergreen
---

# Infra

## Tasks

## Changelog`,
      );

      const { listProjects } = requireFresh();
      const results = listProjects();
      assert.equal(results.length, 1);
      assert.equal(results[0].slug, "infra");
      assert.equal(results[0].status, "evergreen");
    });

    it("excludes completed projects", () => {
      writeProject(
        "done",
        `---
status: completed
completed_at: 2026-03-01
---

# Done

## Changelog
- [x] Item ✅ 2026-03-01`,
      );

      const { listProjects } = requireFresh();
      const results = listProjects();
      assert.equal(results.length, 0);
    });

    it("returns empty array for empty projects dir", () => {
      const { listProjects } = requireFresh();
      const results = listProjects();
      assert.equal(results.length, 0);
    });

    it("returns both active and evergreen projects", () => {
      writeProject(
        "a",
        `---
status: active
---

# Active One

## Tasks`,
      );

      writeProject(
        "b",
        `---
status: evergreen
---

# Evergreen One

## Tasks`,
      );

      writeProject(
        "c",
        `---
status: completed
---

# Completed One

## Changelog
- [x] Done ✅ 2026-03-01`,
      );

      const { listProjects } = requireFresh();
      const results = listProjects();
      assert.equal(results.length, 2);
      const slugs = results.map((r) => r.slug).sort();
      assert.deepEqual(slugs, ["a", "b"]);
    });

    it("defaults to active when status is missing", () => {
      writeProject(
        "no-status",
        `---
---

# No Status

## Tasks`,
      );

      const { listProjects } = requireFresh();
      const results = listProjects();
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "active");
    });

    it("skips _template directory", () => {
      writeProject(
        "_template",
        `---
status: active
---

# Template`,
      );

      const { listProjects } = requireFresh();
      const results = listProjects();
      assert.equal(results.length, 0);
    });
  });

  describe("closeTasks", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("marks all open tasks as done with date stamp", () => {
      writeProject(
        "closing",
        `---
status: active
---

# Closing

## Tasks
- [ ] First task
- [/] Second task
- [x] Already done ✅ 2026-03-01

## Changelog

## Notes`,
      );

      const { closeTasks } = requireFresh();
      const result = closeTasks(projectPath("closing"), [], "2026-03-25", {
        quiet: true,
      });
      assert.deepEqual(result, { completed: 2, cancelled: 0 });

      const content = fs.readFileSync(projectPath("closing"), "utf-8");
      assert.ok(content.includes("- [x] First task ✅ 2026-03-25"));
      assert.ok(content.includes("- [x] Second task ✅ 2026-03-25"));
      assert.ok(content.includes("- [x] Already done ✅ 2026-03-01"));
    });

    it("marks skipped line numbers as cancelled", () => {
      const projectContent = `---
status: active
---

# Skip Test

## Tasks
- [ ] Task one
- [ ] Task two
- [ ] Task three

## Changelog

## Notes`;
      writeProject("skip", projectContent);

      const raw = fs.readFileSync(projectPath("skip"), "utf-8");
      const lines = raw.split("\n");
      let taskTwoLine;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("Task two")) {
          taskTwoLine = i + 1;
          break;
        }
      }

      const { closeTasks } = requireFresh();
      const result = closeTasks(
        projectPath("skip"),
        [taskTwoLine],
        "2026-03-25",
        { quiet: true },
      );
      assert.deepEqual(result, { completed: 2, cancelled: 1 });

      const content = fs.readFileSync(projectPath("skip"), "utf-8");
      assert.ok(content.includes("- [x] Task one ✅ 2026-03-25"));
      assert.ok(content.includes("- [-] Task two"));
      assert.ok(!content.includes("- [-] Task two ✅"));
      assert.ok(content.includes("- [x] Task three ✅ 2026-03-25"));
    });

    it("returns zero counts when no open tasks", () => {
      writeProject(
        "all-done",
        `---
status: active
---

# All Done

## Tasks
- [x] Already done ✅ 2026-03-01
- [x] Also done ✅ 2026-03-02

## Changelog

## Notes`,
      );

      const { closeTasks } = requireFresh();
      const result = closeTasks(projectPath("all-done"), [], "2026-03-25", {
        quiet: true,
      });
      assert.deepEqual(result, { completed: 0, cancelled: 0 });
    });
  });

  describe("closeProject", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("appends summary to changelog, sets completed status, logs to daily", () => {
      writeProject(
        "proj",
        `---
status: active
---

# My Project

## Tasks
- [x] Done task ✅ 2026-03-20

## Changelog

## Notes`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "2026-03-25.md"),
        `---
id: "2026-03-25"
tags: [daily-notes]
---

# 2026-03-25

## Tasks

## Log

## Archive`,
      );

      const { closeProject } = requireFresh();
      closeProject("proj", "Implemented the full feature", "2026-03-25", {
        quiet: true,
      });

      const project = fs.readFileSync(projectPath("proj"), "utf-8");
      assert.ok(project.includes("status: completed"));
      assert.ok(project.includes("completed_at: 2026-03-25"));
      assert.ok(
        project.includes("- [x] Implemented the full feature ✅ 2026-03-25"),
      );

      const daily = fs.readFileSync(
        path.join(tmpDir, "2026-03-25.md"),
        "utf-8",
      );
      assert.ok(daily.includes("Implemented the full feature"));
      assert.ok(daily.includes("[[projects/proj/project|My Project]]"));
    });

    it("throws if daily note is missing", () => {
      writeProject(
        "proj",
        `---
status: active
---

# My Project

## Tasks
- [x] Done task ✅ 2026-03-20

## Changelog

## Notes`,
      );

      const { closeProject } = requireFresh();
      assert.throws(
        () => closeProject("proj", "Summary", "2026-03-25", { quiet: true }),
        /no daily note/,
      );
    });

    it("does not duplicate completed_at if already present", () => {
      writeProject(
        "proj",
        `---
status: active
completed_at: 2026-03-20
---

# My Project

## Tasks
- [x] Done task ✅ 2026-03-20

## Changelog

## Notes`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "2026-03-25.md"),
        `---
id: "2026-03-25"
tags: [daily-notes]
---

# 2026-03-25

## Tasks

## Log

## Archive`,
      );

      const { closeProject } = requireFresh();
      closeProject("proj", "Final summary", "2026-03-25", { quiet: true });

      const project = fs.readFileSync(projectPath("proj"), "utf-8");
      assert.ok(project.includes("completed_at: 2026-03-20"));
      const matches = project.match(/completed_at:/g);
      assert.strictEqual(matches.length, 1);
    });

    it("throws if open tasks remain", () => {
      writeProject(
        "open",
        `---
status: active
---

# Open

## Tasks
- [ ] Still open

## Changelog

## Notes`,
      );

      const { closeProject } = requireFresh();
      assert.throws(
        () => closeProject("open", "Summary", "2026-03-25", { quiet: true }),
        /open tasks remain/,
      );
    });
  });

  describe("parseChangelog", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("filters changelog lines by regex", () => {
      writeProject(
        "cl",
        `---
status: active
---

# CL

## Changelog
- [x] Fix bug ✅ 2026-03-01
- [x] Add feature ✅ 2026-03-02

## Notes`,
      );

      const { parseChangelog } = requireFresh();
      parseChangelog(projectPath("cl"), "bug", { quiet: true });
    });

    it("returns undefined for missing file", () => {
      const { parseChangelog } = requireFresh();
      const result = parseChangelog("/nonexistent/file.md", "test");
      assert.equal(result, undefined);
    });

    it("throws on invalid regex", () => {
      writeProject(
        "re",
        `---
status: active
---

# RE

## Changelog
- [x] Item ✅ 2026-03-01`,
      );

      const { parseChangelog } = requireFresh();
      assert.throws(
        () => parseChangelog(projectPath("re"), "[invalid"),
        /invalid regex/,
      );
    });
  });

  describe("closePlan", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("sets plan status to done and adds findings_extracted flag", () => {
      writeProject(
        "proj",
        `---
status: evergreen
---

# Proj

## Plans

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "proj",
        "2026-03-25-feature.md",
        `---
status: active
project: "[[projects/proj/project]]"
---

# Feature Plan`,
      );

      const { closePlan } = requireFresh();
      const planPath = path.join(
        tmpDir,
        "projects",
        "proj",
        "2026-03-25-feature.md",
      );
      closePlan(planPath, { quiet: true });

      const content = fs.readFileSync(planPath, "utf-8");
      assert.ok(content.includes("status: done"));
      assert.ok(content.includes("findings_extracted: true"));
      assert.ok(!content.includes("status: active"));
    });

    it("works on plans already marked done (just adds findings_extracted)", () => {
      writeProject(
        "proj",
        `---
status: evergreen
---

# Proj

## Plans

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "proj",
        "2026-03-25-feature.md",
        `---
status: done
project: "[[projects/proj/project]]"
---

# Feature Plan`,
      );

      const { closePlan } = requireFresh();
      const planPath = path.join(
        tmpDir,
        "projects",
        "proj",
        "2026-03-25-feature.md",
      );
      closePlan(planPath, { quiet: true });

      const content = fs.readFileSync(planPath, "utf-8");
      assert.ok(content.includes("status: done"));
      assert.ok(content.includes("findings_extracted: true"));
    });
  });

  describe("syncPlans", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("links colocated plan to its project", () => {
      writeProject(
        "alpha",
        `---
status: active
---

# Alpha

## Plans

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "alpha",
        "my-plan.md",
        `---
status: active
project: "[[projects/alpha/project]]"
---

# My Plan`,
      );

      const { syncPlans } = requireFresh();
      const added = syncPlans({ quiet: true });
      assert.equal(added.length, 1);
      assert.equal(added[0].slug, "alpha");
      assert.equal(added[0].plan, "my-plan");

      const result = fs.readFileSync(projectPath("alpha"), "utf-8");
      assert.ok(result.includes("- [[my-plan|My Plan]]"));
    });

    it("skips plans already linked", () => {
      writeProject(
        "beta",
        `---
status: active
---

# Beta

## Plans

- [[existing-plan|Existing]]

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "beta",
        "existing-plan.md",
        `---
status: active
project: "[[projects/beta/project]]"
---

# Existing`,
      );

      const { syncPlans } = requireFresh();
      const added = syncPlans({ quiet: true });
      assert.equal(added.length, 0);
    });

    it("skips plans with no project field", () => {
      writeProject(
        "delta",
        `---
status: active
---

# Delta

## Plans

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "delta",
        "orphan.md",
        `---
status: active
---

# Orphan`,
      );

      const { syncPlans } = requireFresh();
      const added = syncPlans({ quiet: true });
      assert.equal(added.length, 0);
    });

    it("skips plans pointing to a different project", () => {
      writeProject(
        "epsilon",
        `---
status: active
---

# Epsilon

## Plans

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "epsilon",
        "misplaced.md",
        `---
status: active
project: "[[projects/other-project/project]]"
---

# Misplaced`,
      );

      const { syncPlans } = requireFresh();
      const added = syncPlans({ quiet: true });
      assert.equal(added.length, 0);
    });

    it("skips completed projects", () => {
      writeProject(
        "done",
        `---
status: completed
---

# Done

## Plans

## Tasks

## Changelog
- [x] Item ✅ 2026-03-01`,
      );
      writePlanInProject(
        "done",
        "late-plan.md",
        `---
status: active
project: "[[projects/done/project]]"
---

# Late Plan`,
      );

      const { syncPlans } = requireFresh();
      const added = syncPlans({ quiet: true });
      assert.equal(added.length, 0);
    });

    it("is idempotent", () => {
      writeProject(
        "zeta",
        `---
status: active
---

# Zeta

## Plans

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "zeta",
        "idempotent.md",
        `---
status: active
project: "[[projects/zeta/project]]"
---

# Idempotent`,
      );

      const { syncPlans } = requireFresh();
      syncPlans({ quiet: true });
      const mod2 = requireFresh();
      const added = mod2.syncPlans({ quiet: true });
      assert.equal(added.length, 0);

      const result = fs.readFileSync(projectPath("zeta"), "utf-8");
      const matches = result.match(/\[\[idempotent/g);
      assert.equal(matches.length, 1);
    });

    it("links multiple plans in one pass", () => {
      writeProject(
        "eta",
        `---
status: active
---

# Eta

## Plans

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "eta",
        "plan-a.md",
        `---
status: active
project: "[[projects/eta/project]]"
---

# Plan A`,
      );
      writePlanInProject(
        "eta",
        "plan-b.md",
        `---
status: active
project: "[[projects/eta/project]]"
---

# Plan B`,
      );

      const { syncPlans } = requireFresh();
      const added = syncPlans({ quiet: true });
      assert.equal(added.length, 2);

      const result = fs.readFileSync(projectPath("eta"), "utf-8");
      assert.ok(result.includes("[[plan-a|Plan A]]"));
      assert.ok(result.includes("[[plan-b|Plan B]]"));
    });

    it("uses bare basename for plan with no title", () => {
      writeProject(
        "theta",
        `---
status: active
---

# Theta

## Plans

## Tasks

## Changelog`,
      );
      writePlanInProject(
        "theta",
        "no-title.md",
        `---
status: active
project: "[[projects/theta/project]]"
---`,
      );

      const { syncPlans } = requireFresh();
      const added = syncPlans({ quiet: true });
      assert.equal(added.length, 1);

      const result = fs.readFileSync(projectPath("theta"), "utf-8");
      assert.ok(result.includes("- [[no-title]]"));
    });
  });

  describe("extractFindings", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("skips plans with findings_extracted: true", () => {
      writeProject(
        "proj",
        `---
status: evergreen
---

# Evergreen

## Plans

## Tasks

## Changelog`,
      );
      const archivePath = path.join(tmpDir, "archive", "projects", "proj");
      fs.mkdirSync(archivePath, { recursive: true });
      fs.writeFileSync(
        path.join(archivePath, "plan.md"),
        `---
status: done
findings_extracted: true
project: "[[projects/proj/project]]"
---

# Plan

## Notes
Some implementation notes here.`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "2026-03-25.md"),
        `---
id: "2026-03-25"
tags: [daily-notes]
---

# 2026-03-25

## Tasks

## Log`,
      );
      process.env.WORK_CLAUDE_CMD = "false";
      const { extractFindings } = requireFresh();
      const archivedPlans = [
        {
          slug: "proj",
          file: "plan.md",
          basename: "plan",
          title: "Plan",
          archivePath: path.join(archivePath, "plan.md"),
        },
      ];
      const findings = extractFindings(archivedPlans, "2026-03-25", {
        quiet: true,
      });
      assert.equal(findings.length, 0);
    });
  });
});
