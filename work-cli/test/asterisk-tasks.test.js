const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

describe("asterisk checkbox tasks", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;
  const date = "2026-03-10";
  const libDir = path.join(__dirname, "..", "lib");
  const workBin = path.join(__dirname, "..", "bin", "work");
  const load = (name) => require(path.join(libDir, name));
  const read = (file) => fs.readFileSync(file, "utf8");
  const run = (...args) => execFileSync(process.execPath, [workBin, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "asterisk-tasks-"));
    origVault = process.env.WORK_VAULT;
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.WORK_VAULT = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "config");
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
    fs.writeFileSync(path.join(tmpDir, `${date}.md`), "## Tasks\n\n## Log");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origVault === undefined) delete process.env.WORK_VAULT;
    else process.env.WORK_VAULT = origVault;
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  });

  function project(tasks, changelog = "") {
    const dir = path.join(tmpDir, "projects", "proj");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "project.md");
    fs.writeFileSync(file, `---
status: active
---

# Proj

## Tasks
${tasks}

## Changelog
${changelog}`);
    return file;
  }

  it("parses asterisk states, dates, links, and continuation lines", () => {
    const { parseCheckboxItems } = load("checkbox.js");
    const items = parseCheckboxItems([
      "* [ ] Open — [[projects/proj/project|Proj]]",
      "  Details",
      "* [/] Started",
      "* [x] Finished ✅ 2026-03-10",
      "* [-] Cancelled",
    ]);
    assert.deepEqual(items.map(({ state }) => state), [" ", "/", "x", "-"]);
    assert.equal(items[0].text, "Open");
    assert.equal(items[0].wikilink, "projects/proj/project|Proj");
    assert.deepEqual(items[0].continuation, ["  Details"]);
    assert.equal(items[2].doneDate, date);
  });

  it("preserves an asterisk when toggling a checkbox", () => {
    const { setState } = load("checkbox.js");
    assert.equal(setState("* [ ] Open", "/"), "* [/] Open");
    assert.equal(setState("* [/] Open", "x"), "* [x] Open");
  });

  it("injects mixed bullets into the daily tracker without completed tasks", () => {
    project("* [ ] Async editor\n* [ ] Actual model\n- [ ] Responsiveness\n* [/] Started\n* [x] Finished\n* [-] Cancelled");
    run("inject", `--date=${date}`);
    const note = read(path.join(tmpDir, `${date}.md`));
    assert.ok(note.includes("  - Async editor\n  - Actual model\n  - Responsiveness\n  - Started (in progress)"));
    assert.ok(!note.includes("Finished"));
    assert.ok(!note.includes("Cancelled"));
    assert.ok(read(path.join(tmpDir, "projects", "proj", "project.md")).includes("* [ ] Async editor"));
  });

  it("lists mixed bullets globally and by file with accurate line numbers", () => {
    const file = project("* [ ] Open\n* [/] Started\n- [ ] Hyphen\n* [x] Finished\n* [-] Cancelled");
    const { listTasks } = load("scan.js");
    for (const tasks of [listTasks(), listTasks(file)]) {
      assert.deepEqual(tasks.map(({ description, state, line }) => [description, state, line]), [
        ["Open", " ", 8], ["Started", "/", 9], ["Hyphen", " ", 10],
      ]);
    }
  });

  it("updates an asterisk task through all states and removes the done date on reopening", () => {
    const file = project("* [ ] Open");
    const { setTaskState } = load("scan.js");
    setTaskState(file, 8, "in-progress", date);
    assert.equal(load("scan.js").listTasks(file)[0].state, "/");
    setTaskState(file, 8, "done", date);
    assert.ok(read(file).includes(`[x] Open ✅ ${date}`));
    assert.deepEqual(load("scan.js").listTasks(file), []);
    setTaskState(file, 8, "open", date);
    assert.equal(load("scan.js").listTasks(file)[0].state, " ");
    assert.ok(!read(file).includes("✅"));
  });

  for (const section of ["Tasks", "Changelog"]) {
    it(`completes an asterisk task in ${section} without duplicating it`, () => {
      const file = section === "Tasks" ? project("* [ ] Open") : project("", "* [ ] Open");
      run("complete", "proj", "Open", `--date=${date}`);
      assert.ok(!read(file).includes("* [ ] Open"));
      assert.equal(read(file).split("Open").length - 1, 1);
      assert.ok(read(file).includes(`[x] Open ✅ ${date}`));
      assert.ok(read(path.join(tmpDir, `${date}.md`)).includes("Open"));
    });
  }

  it("promotes asterisk completions while preserving open tasks and existing dates", () => {
    const file = project("* [x] Finished\n* [x] Dated ✅ 2026-03-05\n* [ ] Open");
    const { promote } = load("promote.js");
    const { extractSection } = load("markdown.js");
    assert.equal(promote(date, { quiet: true }).length, 2);
    assert.deepEqual(extractSection(read(file), "Tasks").filter(Boolean), ["* [ ] Open"]);
    assert.deepEqual(extractSection(read(file), "Changelog").filter(Boolean), [
      "- [x] Finished ✅ 2026-03-10", "- [x] Dated ✅ 2026-03-05",
    ]);
  });

  it("strips asterisk checkbox markers when syncing completed entries", () => {
    project("", "* [x] Finished ✅ 2026-03-10");
    const { syncCheck } = load("scan.js");
    const { logSyncEntries } = load("daily.js");
    logSyncEntries(date, syncCheck(date), false, { quiet: true });
    assert.ok(read(path.join(tmpDir, `${date}.md`)).includes("- [x] Finished ✅ 2026-03-10 — [[projects/proj/project|Proj]]"));
    assert.deepEqual(syncCheck(date), []);
  });

  for (const section of ["Tasks", "Changelog"]) {
    it(`keeps a project active while ${section} contains an open asterisk task`, () => {
      const file = section === "Tasks"
        ? project("* [/] Started", "- [x] Finished ✅ 2026-03-10")
        : project("", "* [ ] Open\n- [x] Finished ✅ 2026-03-10");
      assert.deepEqual(load("project.js").completeProjects({ quiet: true }), []);
      assert.ok(read(file).includes("status: active"));
    });
  }

  it("completes a project whose completed changelog uses asterisk bullets", () => {
    const file = project("", "* [x] Finished ✅ 2026-03-10");
    assert.equal(load("project.js").completeProjects({ quiet: true }).length, 1);
    assert.ok(read(file).includes("status: completed"));
  });

  it("refuses explicit project closing while asterisk tasks remain", () => {
    const file = project("* [ ] Open");
    assert.throws(() => load("project.js").closeProject("proj", "Finished", date, { quiet: true }), /open tasks remain/);
    assert.ok(read(file).includes("status: active"));
  });

  it("closes or cancels asterisk tasks by line number", () => {
    const file = project("* [ ] Finish\n* [/] Cancel");
    const result = load("project.js").closeTasks(file, [9], date, { quiet: true });
    assert.deepEqual(result, { completed: 1, cancelled: 1 });
    assert.ok(read(file).includes("[x] Finish ✅ 2026-03-10"));
    assert.ok(read(file).includes("[-] Cancel"));
    assert.ok(!read(file).includes("[/]"));
  });

  it("dequeues asterisk completions from the daily note", () => {
    const file = path.join(tmpDir, `${date}.md`);
    fs.writeFileSync(file, "## Queue\n* [x] Finished <!-- key:done -->\n* [ ] Open <!-- key:open -->");
    assert.deepEqual(load("queue.js").dequeue(date, "Queue"), [{ key: "done", label: "Finished" }]);
    assert.ok(!read(file).includes("key:done"));
    assert.ok(read(file).includes("* [ ] Open"));
  });

  it("parses checked asterisk upgrade tasks", () => {
    const { parseUpgradeLine } = load("upgrades.js");
    assert.deepEqual(parseUpgradeLine("* [x] [npm] typescript 5.8 → 5.9"), { type: "npm", name: "typescript" });
    assert.deepEqual(parseUpgradeLine("* [x] neovim 0.11 → 0.12"), { type: "brew", name: "neovim" });
    assert.equal(parseUpgradeLine("* [ ] neovim 0.11 → 0.12"), null);
  });
});