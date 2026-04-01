const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("changelog", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-test-"));
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
    return require(path.join(libDir, "changelog.js"));
  }

  function writeDailyNote(dateStr, content) {
    fs.writeFileSync(path.join(tmpDir, `${dateStr}.md`), content);
  }

  function readDailyNote(dateStr) {
    return fs.readFileSync(path.join(tmpDir, `${dateStr}.md`), "utf-8");
  }

  describe("closeTask", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("checks off an existing open item", () => {
      const { closeTask } = requireFresh();
      const f = path.join(tmpDir, "test.md");
      fs.writeFileSync(
        f,
        "# Plan\n\n## Changelog\n- [ ] Fix the bug\n- [ ] Add tests\n\n## Notes",
      );
      closeTask(f, "Fix the bug", "2026-03-05", { quiet: true });
      const result = fs.readFileSync(f, "utf-8");
      assert.ok(result.includes("- [x] Fix the bug ✅ 2026-03-05"));
      assert.ok(result.includes("- [ ] Add tests"));
    });

    it("appends if no matching item", () => {
      const { closeTask } = requireFresh();
      const f = path.join(tmpDir, "test.md");
      fs.writeFileSync(
        f,
        "# Plan\n\n## Changelog\n- [ ] Existing item\n\n## Notes",
      );
      closeTask(f, "New work", "2026-03-05", { quiet: true });
      const result = fs.readFileSync(f, "utf-8");
      assert.ok(result.includes("- [x] New work ✅ 2026-03-05"));
      assert.ok(result.includes("- [ ] Existing item"));
    });

    it("matches by substring", () => {
      const { closeTask } = requireFresh();
      const f = path.join(tmpDir, "test.md");
      fs.writeFileSync(
        f,
        "# Plan\n\n## Changelog\n- [ ] Implement feature X with tests\n\n## Notes",
      );
      closeTask(f, "feature X", "2026-03-05", { quiet: true });
      const result = fs.readFileSync(f, "utf-8");
      assert.ok(
        result.includes("- [x] Implement feature X with tests ✅ 2026-03-05"),
      );
    });

    it("throws on missing file", () => {
      const { closeTask } = requireFresh();
      assert.throws(
        () =>
          closeTask("/nonexistent/path.md", "desc", "2026-01-01", {
            quiet: true,
          }),
        /file not found/,
      );
    });

    it("creates Changelog section if missing and appends", () => {
      const { closeTask } = requireFresh();
      const f = path.join(tmpDir, "test.md");
      fs.writeFileSync(f, "# Plan\n\n## Notes");
      closeTask(f, "New item", "2026-03-05", { quiet: true });
      const result = fs.readFileSync(f, "utf-8");
      assert.ok(result.includes("## Changelog"));
      assert.ok(result.includes("- [x] New item ✅ 2026-03-05"));
    });

    it("checks off item in Tasks section", () => {
      const { closeTask } = requireFresh();
      const f = path.join(tmpDir, "test.md");
      fs.writeFileSync(
        f,
        "# Proj\n\n## Tasks\n- [ ] Build feature\n\n## Changelog\n\n## Notes",
      );
      const action = closeTask(f, "Build feature", "2026-03-05", {
        quiet: true,
      });
      assert.equal(action, "checked");
      const result = fs.readFileSync(f, "utf-8");
      assert.ok(result.includes("- [x] Build feature ✅ 2026-03-05"));
    });

    it("cancels a task with [-] when cancel option is set", () => {
      const { closeTask } = requireFresh();
      const f = path.join(tmpDir, "test.md");
      fs.writeFileSync(
        f,
        "# Proj\n\n## Tasks\n- [ ] Skipped task\n- [ ] Kept task\n\n## Changelog\n\n## Notes",
      );
      const action = closeTask(f, "Skipped task", "2026-03-05", {
        quiet: true,
        cancel: true,
      });
      assert.equal(action, "cancelled");
      const result = fs.readFileSync(f, "utf-8");
      assert.ok(result.includes("- [-] Skipped task"));
      assert.ok(!result.includes("✅ 2026-03-05"));
      assert.ok(result.includes("- [ ] Kept task"));
    });

    it("applyCloseTask mutates content without file I/O", () => {
      const { applyCloseTask } = requireFresh();
      const content = "# Proj\n\n## Tasks\n- [ ] Do thing\n\n## Changelog";
      const result = applyCloseTask(content, "Do thing", "2026-03-05");
      assert.equal(result.action, "checked");
      assert.ok(result.content.includes("- [x] Do thing ✅ 2026-03-05"));
    });
  });

  describe("appendLog", () => {
    beforeEach(setup);
    afterEach(teardown);
    it("appends entry to daily note Log section", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { appendLog } = requireFresh();

      appendLog(
        "2026-03-10",
        "Did something",
        "project",
        "my-proj",
        "My Project",
        { quiet: true },
      );

      const note = readDailyNote("2026-03-10");
      assert.ok(
        note.includes(
          "- [x] Did something ✅ 2026-03-10 — [[projects/my-proj/project|My Project]]",
        ),
      );
    });

    it("omits wikilink when no source metadata", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { appendLog } = requireFresh();

      appendLog("2026-03-10", "Manual entry", undefined, undefined, undefined, {
        quiet: true,
      });

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("- [x] Manual entry ✅ 2026-03-10"));
      assert.ok(!note.includes("[["));
    });

    it("throws if daily note missing", () => {
      const { appendLog } = requireFresh();
      assert.throws(
        () =>
          appendLog("2026-03-10", "desc", undefined, undefined, undefined, {
            quiet: true,
          }),
        /no daily note/,
      );
    });
  });
});
