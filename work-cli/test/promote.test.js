const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let tmpDir;
let origVault;
let origXdg;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-test-"));
  fs.mkdirSync(path.join(tmpDir, "projects"));
  fs.mkdirSync(path.join(tmpDir, "config", "work"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "config", "work", "config.json"),
    JSON.stringify({}),
  );
  origVault = process.env.WORK_VAULT;
  origXdg = process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
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
});

function requireFresh() {
  const libDir = path.join(__dirname, "..", "lib");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libDir)) delete require.cache[key];
  }
  process.env.WORK_VAULT = tmpDir;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, "config");
  return require(path.join(libDir, "promote.js"));
}

function writeProject(slug, content) {
  const dir = path.join(tmpDir, "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.md"), content);
}

function projectPath(slug) {
  return path.join(tmpDir, "projects", slug, "project.md");
}

describe("promote", () => {
  it("moves checked tasks from Tasks to Changelog", () => {
    writeProject(
      "proj",
      `---
status: active
---

# Proj

## Tasks
- [x] Done task
- [ ] Open task

## Changelog

## Notes`,
    );

    const { promote } = requireFresh();
    const promoted = promote("2026-03-10", { quiet: true });

    assert.equal(promoted.length, 1);
    assert.ok(promoted[0].text.includes("Done task"));

    const result = fs.readFileSync(projectPath("proj"), "utf-8");
    const { extractSection } = require("../lib/markdown.js");
    const tasks = extractSection(result, "Tasks");
    const changelog = extractSection(result, "Changelog");
    assert.ok(!tasks.some((l) => l.includes("Done task")));
    assert.ok(tasks.some((l) => l.includes("Open task")));
    assert.ok(changelog.some((l) => l.includes("Done task")));
  });

  it("stamps done date if missing", () => {
    writeProject(
      "no-date",
      `---
status: active
---

# No Date

## Tasks
- [x] Finished

## Changelog

## Notes`,
    );

    const { promote } = requireFresh();
    promote("2026-03-10", { quiet: true });

    const result = fs.readFileSync(projectPath("no-date"), "utf-8");
    const { extractSection } = require("../lib/markdown.js");
    const changelog = extractSection(result, "Changelog");
    assert.ok(changelog.some((l) => l.includes("✅ 2026-03-10")));
  });

  it("preserves existing done date", () => {
    writeProject(
      "has-date",
      `---
status: active
---

# Has Date

## Tasks
- [x] Already dated ✅ 2026-03-05

## Changelog

## Notes`,
    );

    const { promote } = requireFresh();
    promote("2026-03-10", { quiet: true });

    const result = fs.readFileSync(projectPath("has-date"), "utf-8");
    assert.ok(result.includes("✅ 2026-03-05"));
    assert.ok(!result.includes("✅ 2026-03-10"));
  });

  it("skips non-active projects", () => {
    writeProject(
      "completed",
      `---
status: completed
---

# Completed

## Tasks
- [x] Done

## Changelog

## Notes`,
    );

    const { promote } = requireFresh();
    const promoted = promote("2026-03-10", { quiet: true });
    assert.equal(promoted.length, 0);
  });

  it("promotes checked tasks in evergreen projects", () => {
    writeProject(
      "evergreen",
      `---
status: evergreen
---

# Evergreen

## Tasks
- [x] Done task
- [ ] Open task

## Changelog

## Notes`,
    );

    const { promote } = requireFresh();
    const promoted = promote("2026-03-12", { quiet: true });

    assert.equal(promoted.length, 1);
    assert.ok(promoted[0].text.includes("Done task"));

    const result = fs.readFileSync(projectPath("evergreen"), "utf-8");
    const { extractSection } = require("../lib/markdown.js");
    const tasks = extractSection(result, "Tasks");
    const changelog = extractSection(result, "Changelog");
    assert.ok(!tasks.some((l) => l.includes("Done task")));
    assert.ok(tasks.some((l) => l.includes("Open task")));
    assert.ok(
      changelog.some(
        (l) => l.includes("Done task") && l.includes("✅ 2026-03-12"),
      ),
    );
  });

  it("returns empty array when no projects exist", () => {
    fs.rmSync(path.join(tmpDir, "projects"), { recursive: true });
    const { promote } = requireFresh();
    const promoted = promote("2026-03-10", { quiet: true });
    assert.deepEqual(promoted, []);
  });

  it("handles multiple checked tasks", () => {
    writeProject(
      "multi",
      `---
status: active
---

# Multi

## Tasks
- [x] First
- [x] Second
- [ ] Third

## Changelog

## Notes`,
    );

    const { promote } = requireFresh();
    const promoted = promote("2026-03-10", { quiet: true });
    assert.equal(promoted.length, 2);
  });

  it("preserves blank line before next section heading", () => {
    writeProject(
      "ws",
      `---
status: active
---

# WS

## Tasks
- [x] Done

## Changelog

## Notes`,
    );

    const { promote } = requireFresh();
    promote("2026-03-10", { quiet: true });

    const result = fs.readFileSync(projectPath("ws"), "utf-8");
    assert.ok(
      result.includes("Done task") === false || result.includes("\n\n## Notes"),
    );
    assert.ok(
      !result.includes("✅ 2026-03-10\n## Notes"),
      "missing blank line before ## Notes",
    );
  });

  it("does not insert blank line in middle of changelog", () => {
    writeProject(
      "existing",
      `---
status: active
---

# Existing

## Tasks
- [x] New item

## Changelog
- [x] Old item ✅ 2026-03-01

## Notes`,
    );

    const { promote } = requireFresh();
    promote("2026-03-10", { quiet: true });

    const result = fs.readFileSync(projectPath("existing"), "utf-8");
    const { extractSection } = require("../lib/markdown.js");
    const changelog = extractSection(result, "Changelog");
    const nonEmpty = changelog.filter((l) => l.trim() !== "");
    assert.equal(nonEmpty.length, 2);
    const trimmed = changelog.slice();
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === "")
      trimmed.pop();
    const blankLines = trimmed.filter((l) => l.trim() === "");
    assert.equal(
      blankLines.length,
      0,
      "should have no blank lines between changelog items",
    );
  });
});
