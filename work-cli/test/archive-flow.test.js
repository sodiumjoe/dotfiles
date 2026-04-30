const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

describe("archive-flow", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;
  const workBin = path.join(__dirname, "..", "bin", "work");

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-flow-"));
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

  function runWork(...args) {
    return runWorkEnv({}, ...args);
  }

  function runWorkEnv(extraEnv, ...args) {
    return execFileSync("node", [workBin, ...args], {
      env: {
        ...process.env,
        WORK_VAULT: tmpDir,
        XDG_CONFIG_HOME: path.join(tmpDir, "config"),
        WORK_TEST_HOUR: "10",
        WORK_SKIP_REVIEWS: "1",
        WORK_SKIP_UPGRADES: "1",
        CLAUDECODE: "",
        ...extraEnv,
      },
      encoding: "utf-8",
      timeout: 10000,
    });
  }

  describe("work archive-project CLI", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("archives project via CLI", () => {
      writeProject(
        "test-proj",
        `---
status: completed
---

# Test Project

## Changelog
- [x] Item ✅ 2026-03-01`,
      );

      const output = runWork("archive-project", "test-proj");
      assert.ok(output.includes("archived project: test-proj"));
      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "test-proj")));
      assert.ok(
        fs.existsSync(
          path.join(tmpDir, "archive", "projects", "test-proj", "project.md"),
        ),
      );
    });

    it("errors on nonexistent project", () => {
      assert.throws(() => runWork("archive-project", "nope"), /not found/);
    });
  });

  describe("tick archive queue integration", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("tick dequeues checked archive items", () => {
      writeProject(
        "to-archive",
        `---
status: completed
---

# To Archive

## Changelog
- [x] Done ✅ 2026-03-01`,
      );

      writeDailyNote(
        "2026-03-10",
        [
          "## Tasks",
          "",
          "## Log",
          "",
          "## Archive",
          "- [x] [[projects/to-archive/project|To Archive]] — completed 2026-03-01 <!-- key:projects/to-archive -->",
        ].join("\n"),
      );

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(output.includes("archived project: to-archive"));
      assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "to-archive")));
      assert.ok(
        fs.existsSync(
          path.join(tmpDir, "archive", "projects", "to-archive", "project.md"),
        ),
      );
      const note = readDailyNote("2026-03-10");
      assert.ok(!note.includes("key:projects/to-archive"));
    });

    it("tick ignores unchecked archive items", () => {
      writeProject(
        "keep-me",
        `---
status: completed
---

# Keep Me

## Changelog
- [x] Done ✅ 2026-03-01`,
      );

      writeDailyNote(
        "2026-03-10",
        [
          "## Tasks",
          "",
          "## Log",
          "",
          "## Archive",
          "- [ ] [[projects/keep-me/project|Keep Me]] — completed 2026-03-01 <!-- key:projects/keep-me -->",
        ].join("\n"),
      );

      runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(fs.existsSync(projectPath("keep-me")));
      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("key:projects/keep-me"));
    });

    it("tick with no archive section runs clean", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(output.includes("nothing to archive"));
    });
  });

  describe("completeProjects stamps completed_at via CLI", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("wrap stamps completed_at on newly completed projects", () => {
      writeProject(
        "completable",
        `---
status: active
---

# Completable

## Tasks

## Changelog
- [x] All done ✅ 2026-03-01

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      runWork("wrap", "--date=2026-03-10");

      const result = fs.readFileSync(projectPath("completable"), "utf-8");
      assert.ok(result.includes("status: completed"));
      assert.match(result, /completed_at: \d{4}-\d{2}-\d{2}/);
    });
  });

  describe("tick wraps previous unwrapped days", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("wraps previous day note if it lacks summary", () => {
      writeProject(
        "wrapable",
        `---
status: active
---

# Wrapable

## Tasks

## Changelog
- [x] Done ✅ 2026-03-09

## Notes`,
      );

      writeDailyNote("2026-03-09", "## Tasks\n\n## Log\n");
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      fs.mkdirSync(path.join(tmpDir, "weekly"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "weekly", "2026-W11.md"), "# done");

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(output.includes("=== wrap 2026-03-09 ==="));
      const note = readDailyNote("2026-03-09");
      assert.ok(note.includes("## Summary"));
      const proj = fs.readFileSync(projectPath("wrapable"), "utf-8");
      assert.ok(proj.includes("status: completed"));
    });

    it("stops backfill at first summarized day", () => {
      writeDailyNote(
        "2026-03-08",
        "## Tasks\n\n## Summary\nAlready done\n\n## Log\n",
      );
      writeDailyNote("2026-03-09", "## Tasks\n\n## Log\n");
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(output.includes("=== wrap 2026-03-09 ==="));
      assert.ok(!output.includes("=== wrap 2026-03-08 ==="));
    });

    it("does not wrap today", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(!output.includes("=== wrap"));
    });

    it("skips days with no daily note", () => {
      writeDailyNote("2026-03-08", "## Tasks\n\n## Log\n");
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(output.includes("=== wrap 2026-03-08 ==="));
      assert.ok(!output.includes("=== wrap 2026-03-09 ==="));
    });
  });

  describe("weekly proposals via tick", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("proposes completed projects when weekly file missing", () => {
      writeProject(
        "done-proj",
        `---
status: completed
completed_at: 2026-03-08
---

# Done Project

## Changelog
- [x] Item ✅ 2026-03-08

## Notes`,
      );

      writeProject(
        "active-proj",
        `---
status: active
---

# Active Project

## Tasks
- [ ] Still working

## Changelog

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(output.includes("propose"));
      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("key:projects/done-proj"));
      assert.ok(!note.includes("key:projects/active-proj"));
    });

    it("skips evergreen projects when proposing", () => {
      writeProject(
        "evergreen",
        `---
status: evergreen
---

# Evergreen

## Changelog
- [x] Item ✅ 2026-03-01

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      runWork("tick", "--verbose", "--date=2026-03-10");
      const note = readDailyNote("2026-03-10");
      assert.ok(!note.includes("key:projects/evergreen"));
    });

    it("skips proposals when weekly file already exists", () => {
      writeProject(
        "done-proj",
        `---
status: completed
completed_at: 2026-03-08
---

# Done Project

## Changelog
- [x] Item ✅ 2026-03-08

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      fs.mkdirSync(path.join(tmpDir, "weekly"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "weekly", "2026-W11.md"),
        "# Already done",
      );

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(!output.includes("propose"));
      const note = readDailyNote("2026-03-10");
      assert.ok(!note.includes("key:projects/done-proj"));
    });
  });

  describe("tick error debug", () => {
    beforeEach(setup);
    afterEach(teardown);

    function makeFakeClaude() {
      const argsFile = path.join(tmpDir, "claude-args.txt");
      const stdinFile = path.join(tmpDir, "claude-stdin.txt");
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
          `});`,
        ].join("\n"),
        { mode: 0o755 },
      );
      return { fakeClaude, argsFile, stdinFile };
    }

    it("spawns Claude on error with correct args and prompt", () => {
      const { fakeClaude, argsFile, stdinFile } = makeFakeClaude();
      fs.rmSync(path.join(tmpDir, "projects"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "projects"), "not a directory");
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      let output;
      try {
        output = runWorkEnv(
          { WORK_CLAUDE_CMD: fakeClaude },
          "tick",
          "--verbose",
          "--date=2026-03-10",
        );
      } catch (e) {
        output = e.stdout || "";
      }

      assert.ok(output.includes("ERROR"));
      assert.ok(fs.existsSync(argsFile), "claude should have been invoked");
      const args = JSON.parse(fs.readFileSync(argsFile, "utf-8"));
      assert.ok(args.includes("-p"));
      assert.ok(args.includes("--allowedTools"));
      assert.ok(args.includes("Read"));
      assert.ok(args.includes("Glob"));
      assert.ok(args.includes("Grep"));
      assert.ok(args.includes("Write"));
      assert.ok(args.includes("Edit"));
      const stdin = fs.readFileSync(stdinFile, "utf-8");
      assert.ok(stdin.includes("tick command encountered errors"));
      assert.ok(stdin.includes("Fix tick error:"));
    });

    it("skips Claude if tick-error task already exists", () => {
      const { fakeClaude, argsFile } = makeFakeClaude();
      writeProject(
        "work",
        "---\nstatus: evergreen\n---\n\n# work\n\n## Tasks\n\n- [ ] Fix tick error: previous error\n\n## Changelog\n",
      );
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      try {
        runWorkEnv(
          { WORK_CLAUDE_CMD: fakeClaude },
          "tick",
          "--verbose",
          "--date=2026-03-10",
          "--simulate-error",
        );
      } catch {}

      assert.ok(
        !fs.existsSync(argsFile),
        "claude should NOT have been invoked",
      );
    });

    it("logs syslog INFO on success", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { fakeClaude, argsFile } = makeFakeClaude();

      const output = runWorkEnv(
        { WORK_CLAUDE_CMD: fakeClaude },
        "tick",
        "--date=2026-03-10",
      );

      assert.ok(output.includes("INFO"));
      assert.ok(output.includes("tick ok"));
      assert.ok(
        !fs.existsSync(argsFile),
        "claude should NOT have been invoked",
      );
    });
  });

  describe("tick archives evergreen plans", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("tick archives done plans from evergreen projects", () => {
      const projDir = path.join(tmpDir, "projects", "my-evergreen");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "project.md"),
        [
          "---",
          "status: evergreen",
          "---",
          "",
          "# My Evergreen",
          "",
          "## Plans",
          "- [[done-plan]]",
          "- [[active-plan]]",
          "",
          "## Tasks",
          "",
          "## Changelog",
          "",
          "## Notes",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(projDir, "done-plan.md"),
        [
          "---",
          "status: done",
          "---",
          "",
          "# Done Plan",
          "",
          "## Notes",
          "Some notes here.",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(projDir, "active-plan.md"),
        [
          "---",
          "status: active",
          "---",
          "",
          "# Active Plan",
          "",
          "## Notes",
        ].join("\n"),
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      fs.mkdirSync(path.join(tmpDir, "weekly"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "weekly", "2026-W11.md"), "# done");

      const fakeClaude = path.join(tmpDir, "fake-claude.js");
      fs.writeFileSync(
        fakeClaude,
        ["#!/usr/bin/env node", `process.stdout.write("NONE");`].join("\n"),
        { mode: 0o755 },
      );

      const output = runWorkEnv(
        { WORK_CLAUDE_CMD: fakeClaude },
        "tick",
        "--verbose",
        "--date=2026-03-10",
      );
      assert.ok(output.includes("archived plan: done-plan"));
      assert.ok(
        fs.existsSync(
          path.join(
            tmpDir,
            "archive",
            "projects",
            "my-evergreen",
            "done-plan.md",
          ),
        ),
      );
      assert.ok(!fs.existsSync(path.join(projDir, "done-plan.md")));
      assert.ok(fs.existsSync(path.join(projDir, "active-plan.md")));
      const proj = fs.readFileSync(path.join(projDir, "project.md"), "utf-8");
      assert.ok(!proj.includes("[[done-plan]]"));
      assert.ok(proj.includes("[[active-plan]]"));
    });

    it("tick skips archive-plans when no evergreen plans are done", () => {
      const projDir = path.join(tmpDir, "projects", "my-evergreen");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "project.md"),
        [
          "---",
          "status: evergreen",
          "---",
          "",
          "# My Evergreen",
          "",
          "## Plans",
          "- [[active-plan]]",
          "",
          "## Tasks",
          "",
          "## Changelog",
          "",
          "## Notes",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(projDir, "active-plan.md"),
        [
          "---",
          "status: active",
          "---",
          "",
          "# Active Plan",
          "",
          "## Notes",
        ].join("\n"),
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      fs.mkdirSync(path.join(tmpDir, "weekly"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "weekly", "2026-W11.md"), "# done");

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(output.includes("no plans to archive"));
    });
  });

  describe("tick extractFindings integration", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("spawns claude and appends findings task to daily note", () => {
      const projDir = path.join(tmpDir, "projects", "my-evergreen");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "project.md"),
        [
          "---",
          "status: evergreen",
          "---",
          "",
          "# My Evergreen",
          "",
          "## Plans",
          "- [[done-plan]]",
          "",
          "## Tasks",
          "",
          "## Changelog",
          "",
          "## Notes",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(projDir, "done-plan.md"),
        [
          "---",
          "status: done",
          "---",
          "",
          "# Done Plan",
          "",
          "## Notes",
          "Always use --frozen-lockfile for reproducible builds.",
        ].join("\n"),
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      fs.mkdirSync(path.join(tmpDir, "weekly"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "weekly", "2026-W11.md"), "# done");

      const fakeClaude = path.join(tmpDir, "fake-claude.js");
      fs.writeFileSync(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          `process.stdout.write("Discovery: always use --frozen-lockfile for reproducible builds.");`,
        ].join("\n"),
        { mode: 0o755 },
      );

      const output = runWorkEnv(
        { WORK_CLAUDE_CMD: fakeClaude },
        "tick",
        "--verbose",
        "--date=2026-03-10",
      );
      assert.ok(output.includes("findings review task"));
      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("Review findings from"));
      assert.ok(note.includes("frozen-lockfile"));
    });

    it("skips findings task when claude returns NONE", () => {
      const projDir = path.join(tmpDir, "projects", "my-evergreen");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "project.md"),
        [
          "---",
          "status: evergreen",
          "---",
          "",
          "# My Evergreen",
          "",
          "## Plans",
          "- [[done-plan]]",
          "",
          "## Tasks",
          "",
          "## Changelog",
          "",
          "## Notes",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(projDir, "done-plan.md"),
        [
          "---",
          "status: done",
          "---",
          "",
          "# Done Plan",
          "",
          "## Notes",
          "Nothing special.",
        ].join("\n"),
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      fs.mkdirSync(path.join(tmpDir, "weekly"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "weekly", "2026-W11.md"), "# done");

      const fakeClaude = path.join(tmpDir, "fake-claude.js");
      fs.writeFileSync(
        fakeClaude,
        ["#!/usr/bin/env node", `process.stdout.write("NONE");`].join("\n"),
        { mode: 0o755 },
      );

      runWorkEnv(
        { WORK_CLAUDE_CMD: fakeClaude },
        "tick",
        "--verbose",
        "--date=2026-03-10",
      );
      const note = readDailyNote("2026-03-10");
      assert.ok(!note.includes("Review findings"));
    });
  });

  describe("tick writes weekly summary", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("spawns claude for weekly summary when weekly file missing", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Weekly Project

## Tasks

## Changelog
- [x] Weekly work ✅ 2026-03-10

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      const weeklyDir = path.join(tmpDir, "weekly");
      const outputPath = path.join(weeklyDir, "2026-W11.md");
      const stdinFile = path.join(tmpDir, "claude-stdin.txt");
      const fakeClaude = path.join(tmpDir, "fake-claude.js");
      fs.writeFileSync(
        fakeClaude,
        [
          "#!/usr/bin/env node",
          `const fs = require('fs');`,
          `let stdin = '';`,
          `process.stdin.setEncoding('utf-8');`,
          `process.stdin.on('data', d => stdin += d);`,
          `process.stdin.on('end', () => {`,
          `  fs.writeFileSync(${JSON.stringify(stdinFile)}, stdin);`,
          `  fs.mkdirSync(${JSON.stringify(weeklyDir)}, { recursive: true });`,
          `  fs.writeFileSync(${JSON.stringify(outputPath)}, '# 2026-W11 Work Summary\\n\\nNarrative.');`,
          `});`,
        ].join("\n"),
        { mode: 0o755 },
      );

      const output = runWorkEnv(
        { WORK_CLAUDE_CMD: fakeClaude },
        "tick",
        "--verbose",
        "--date=2026-03-10",
      );
      assert.ok(output.includes("weekly summary"));
      assert.ok(fs.existsSync(outputPath));
      const stdin = fs.readFileSync(stdinFile, "utf-8");
      assert.ok(stdin.includes("Weekly Project"));
      assert.ok(stdin.includes("Weekly work"));
    });

    it("skips weekly summary when weekly file already exists", () => {
      writeProject(
        "proj",
        `---
status: active
---

# Project

## Tasks

## Changelog
- [x] Work ✅ 2026-03-10

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");

      fs.mkdirSync(path.join(tmpDir, "weekly"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "weekly", "2026-W11.md"),
        "# Already done",
      );

      const output = runWork("tick", "--verbose", "--date=2026-03-10");
      assert.ok(!output.includes("weekly summary"));
    });
  });
});
