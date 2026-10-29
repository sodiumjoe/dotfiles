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
  const workBin = path.join(__dirname, "..", "..", "home", "bin", "work");

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


  it("creates project file", () => {
    const output = runWork("create-project", "test-proj", "Test Project");
    assert.ok(output.includes("project.md"));
    const result = fs.readFileSync(projectPath("test-proj"), "utf-8");
    assert.ok(result.includes("# Test Project"));
    assert.ok(result.includes("status: active"));
  });

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

## Notes

Unrelated project notes remain unchanged.`,
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
    assert.ok(proj.includes("## Notes\n\nUnrelated project notes remain unchanged."));

    const note = readDailyNote("2026-03-10");
    assert.ok(note.includes("Build feature"));
    assert.ok(note.includes("[[projects/proj/project|Proj]]"));
  });

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

    const before = fs.readFileSync(projectPath("test-proj"), "utf-8");
    const output = runWork("archive-project", "test-proj");
    assert.equal(fs.readFileSync(path.join(tmpDir, "archive", "projects", "test-proj", "project.md"), "utf-8"), before);
    assert.ok(output.includes("archived project: test-proj"));
    assert.ok(!fs.existsSync(path.join(tmpDir, "projects", "test-proj")));
    assert.ok(
      fs.existsSync(
        path.join(tmpDir, "archive", "projects", "test-proj", "project.md"),
      ),
    );
  });
});