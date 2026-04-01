const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("daily", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-test-"));
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

  function requireFresh(mod = "daily.js") {
    const libDir = path.join(__dirname, "..", "lib");
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
    process.env.WORK_VAULT = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "config");
    return require(path.join(libDir, mod));
  }

  function writeDailyNote(dateStr, content) {
    fs.writeFileSync(path.join(tmpDir, `${dateStr}.md`), content);
  }

  function readDailyNote(dateStr) {
    return fs.readFileSync(path.join(tmpDir, `${dateStr}.md`), "utf-8");
  }

  function writeProject(slug, content) {
    const dir = path.join(tmpDir, "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.md"), content);
  }

  describe("ensure", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("creates daily note if missing", () => {
      const { ensure } = requireFresh();
      ensure("2026-03-10", { quiet: true });

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("id: 2026-03-10"));
      assert.ok(note.includes("## Tasks"));
      assert.ok(note.includes("## Log"));
    });

    it("does not overwrite existing note", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\nExisting content\n");
      const { ensure } = requireFresh();
      ensure("2026-03-10", { quiet: true });

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("Existing content"));
    });

    it("migrates Queue to Tasks", () => {
      writeDailyNote("2026-03-10", "## Queue\n- [ ] Item\n\n## Log\n");
      const { ensure } = requireFresh();
      ensure("2026-03-10", { quiet: true });

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("## Tasks"));
      assert.ok(!note.includes("## Queue"));
    });

    it("adds missing Tasks section to existing note", () => {
      writeDailyNote("2026-03-10", "## Log\nSome log\n");
      const { ensure } = requireFresh();
      ensure("2026-03-10", { quiet: true });

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("## Tasks"));
      assert.ok(note.includes("## Log"));
    });

    it("adds missing Log section to existing note", () => {
      writeDailyNote("2026-03-10", "## Tasks\n- [ ] Item\n");
      const { ensure } = requireFresh();
      ensure("2026-03-10", { quiet: true });

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("## Log"));
    });
  });

  describe("logSyncEntries", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("appends entries to Log section", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { logSyncEntries } = requireFresh();

      logSyncEntries(
        "2026-03-10",
        [
          {
            filename: "my-proj.md",
            title: "My Proj",
            itemText: "Did a thing",
            sourceType: "project",
          },
        ],
        false,
        { quiet: true },
      );

      const note = readDailyNote("2026-03-10");
      assert.ok(
        note.includes(
          "- [x] Did a thing — [[projects/my-proj/project|My Proj]]",
        ),
      );
    });

    it("does nothing on empty entries", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { logSyncEntries } = requireFresh();
      logSyncEntries("2026-03-10", [], false, { quiet: true });

      const note = readDailyNote("2026-03-10");
      assert.equal(note, "## Tasks\n\n## Log\n");
    });

    it("throws if daily note missing", () => {
      const { logSyncEntries } = requireFresh();
      assert.throws(
        () =>
          logSyncEntries(
            "2026-03-10",
            [
              {
                filename: "x.md",
                title: "X",
                itemText: "y",
                sourceType: "project",
              },
            ],
            false,
            { quiet: true },
          ),
        /no daily note/,
      );
    });
  });

  describe("inject", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("rebuilds Tasks section from scan results", () => {
      writeProject(
        "proj-a",
        `---
status: active
---

# Project A

## Tasks
- [ ] Open task

## Changelog

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\nold content\n\n## Log\n");
      const { inject } = requireFresh();

      inject(
        "2026-03-10",
        [
          {
            projectSlug: "proj-a",
            itemText: "Open task",
            state: " ",
            sourceType: "project",
            title: "Project A",
            evergreen: false,
          },
        ],
        { quiet: true },
      );

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("Open task"));
      assert.ok(note.includes("proj-a"));
      assert.ok(!note.includes("old content"));
    });

    it("shows in-progress state", () => {
      writeProject(
        "proj-b",
        `---
status: active
---

# Project B

## Tasks

## Changelog

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { inject } = requireFresh();

      inject(
        "2026-03-10",
        [
          {
            projectSlug: "proj-b",
            itemText: "Working on it",
            state: "/",
            sourceType: "project",
            title: "Project B",
            evergreen: false,
          },
        ],
        { quiet: true },
      );

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("Working on it (in progress)"));
    });

    it("clears Tasks when no results", () => {
      writeDailyNote("2026-03-10", "## Tasks\nold stuff\n\n## Log\n");
      const { inject } = requireFresh();

      inject("2026-03-10", [], { quiet: true });

      const note = readDailyNote("2026-03-10");
      assert.ok(!note.includes("old stuff"));
      assert.ok(note.includes("## Tasks"));
      assert.ok(note.includes("## Log"));
    });

    it("sorts evergreen projects first", () => {
      writeProject(
        "z-regular",
        `---
status: active
---

# Z Regular

## Tasks

## Changelog

## Notes`,
      );

      writeProject(
        "a-evergreen",
        `---
status: evergreen
---

# A Evergreen

## Tasks

## Changelog

## Notes`,
      );

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { inject } = requireFresh();

      inject(
        "2026-03-10",
        [
          {
            projectSlug: "z-regular",
            itemText: "Regular task",
            state: " ",
            sourceType: "project",
            title: "Z Regular",
            evergreen: false,
          },
          {
            projectSlug: "a-evergreen",
            itemText: "Evergreen task",
            state: " ",
            sourceType: "project",
            title: "A Evergreen",
            evergreen: true,
          },
        ],
        { quiet: true },
      );

      const note = readDailyNote("2026-03-10");
      const evergreenPos = note.indexOf("a-evergreen");
      const regularPos = note.indexOf("z-regular");
      assert.ok(
        evergreenPos < regularPos,
        "evergreen should appear before regular",
      );
    });
  });

  function assertSectionWhitespace(content) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^## /.test(lines[i])) continue;
      if (i > 0) {
        const prev = lines[i - 1];
        const prevPrev = i >= 2 ? lines[i - 2] : null;
        if (prev !== "---") {
          assert.equal(
            prev,
            "",
            `line ${i}: expected blank line before "${lines[i]}", got "${prev}"`,
          );
          if (prevPrev !== null && prevPrev !== "---") {
            assert.notEqual(
              prevPrev,
              "",
              `line ${i}: double blank line before "${lines[i]}"`,
            );
          }
        }
      }
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      if (next !== null && next.trim() !== "" && !/^## /.test(next)) {
        assert.equal(
          next,
          "",
          `line ${i}: expected blank line after "${lines[i]}", got "${next}"`,
        );
      }
    }
  }

  describe("section whitespace", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("ensure creates note with single blank between sections", () => {
      const { ensure } = requireFresh();
      ensure("2026-03-10", { quiet: true });
      assertSectionWhitespace(readDailyNote("2026-03-10"));
    });

    it("inject with content preserves single blank before Log", () => {
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

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { inject } = requireFresh();
      inject(
        "2026-03-10",
        [
          {
            projectSlug: "proj",
            itemText: "Task",
            state: " ",
            sourceType: "project",
            title: "Proj",
            evergreen: false,
          },
        ],
        { quiet: true },
      );

      assertSectionWhitespace(readDailyNote("2026-03-10"));
    });

    it("inject with empty results preserves single blank before Log", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { inject } = requireFresh();
      inject("2026-03-10", [], { quiet: true });

      assertSectionWhitespace(readDailyNote("2026-03-10"));
    });

    it("logSyncEntries maintains single blank between sections", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n\n## Summary\n");
      const { logSyncEntries } = requireFresh();
      logSyncEntries(
        "2026-03-10",
        [
          {
            filename: "proj.md",
            title: "Proj",
            itemText: "Did work",
            sourceType: "project",
          },
        ],
        false,
        { quiet: true },
      );

      assertSectionWhitespace(readDailyNote("2026-03-10"));
    });

    it("appendLog maintains single blank between sections", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n\n## Summary\n");
      const { appendLog } = requireFresh("changelog.js");
      appendLog("2026-03-10", "Did something", "project", "proj", "Proj", {
        quiet: true,
      });

      assertSectionWhitespace(readDailyNote("2026-03-10"));
    });

    it("appendLog to empty Log section maintains whitespace", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { appendLog } = requireFresh("changelog.js");
      appendLog("2026-03-10", "First entry", "project", "proj", "Proj", {
        quiet: true,
      });

      const note = readDailyNote("2026-03-10");
      assert.ok(note.includes("First entry"));
    });

    it("multiple appendLog calls do not accumulate blanks", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n\n## Summary\n");
      const { appendLog } = requireFresh("changelog.js");
      appendLog("2026-03-10", "First", "project", "proj", "Proj", {
        quiet: true,
      });
      appendLog("2026-03-10", "Second", "project", "proj", "Proj", {
        quiet: true,
      });
      appendLog("2026-03-10", "Third", "project", "proj", "Proj", {
        quiet: true,
      });

      assertSectionWhitespace(readDailyNote("2026-03-10"));
    });

    it("inject then appendLog maintains consistent whitespace", () => {
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

      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const daily = requireFresh();
      daily.inject(
        "2026-03-10",
        [
          {
            projectSlug: "proj",
            itemText: "Task",
            state: " ",
            sourceType: "project",
            title: "Proj",
            evergreen: false,
          },
        ],
        { quiet: true },
      );

      const { appendLog } = requireFresh("changelog.js");
      appendLog("2026-03-10", "Done", "project", "proj", "Proj", {
        quiet: true,
      });

      assertSectionWhitespace(readDailyNote("2026-03-10"));
    });
  });
});
