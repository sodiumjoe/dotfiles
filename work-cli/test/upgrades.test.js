const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const LIB = path.join(__dirname, "..", "lib");

function requireFresh(mod) {
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

describe("checkNvimPluginStaleness", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrades-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.WORK_SKIP_UPGRADES;
  });

  it("reports stale when lockfile commit is old", () => {
    const { execFileSync } = require("node:child_process");
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@test.com",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: tmpDir },
    );
    fs.writeFileSync(path.join(tmpDir, "lazy-lock.json"), "{}");
    execFileSync("git", ["add", "lazy-lock.json"], { cwd: tmpDir });
    // Commit with a date 20 days ago (set both author and committer date)
    const oldDate = new Date(Date.now() - 20 * 86400 * 1000).toISOString();
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@test.com",
        "commit",
        "-m",
        "add lockfile",
        `--date=${oldDate}`,
      ],
      { cwd: tmpDir, env: { ...process.env, GIT_COMMITTER_DATE: oldDate } },
    );

    const { checkNvimPluginStaleness } = requireFresh(
      path.join(LIB, "upgrades.js"),
    );
    const result = checkNvimPluginStaleness(tmpDir);
    assert.equal(result.stale, true);
    assert.ok(result.daysSinceUpdate >= 19);
  });

  it("reports not stale when lockfile commit is recent", () => {
    const { execFileSync } = require("node:child_process");
    execFileSync("git", ["init"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "lazy-lock.json"), "{}");
    execFileSync("git", ["add", "lazy-lock.json"], { cwd: tmpDir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@test.com",
        "commit",
        "-m",
        "add lockfile",
      ],
      { cwd: tmpDir },
    );

    const { checkNvimPluginStaleness } = requireFresh(
      path.join(LIB, "upgrades.js"),
    );
    const result = checkNvimPluginStaleness(tmpDir);
    assert.equal(result.stale, false);
    assert.ok(result.daysSinceUpdate <= 1);
  });

  it("returns graceful result when git fails", () => {
    const { checkNvimPluginStaleness } = requireFresh(
      path.join(LIB, "upgrades.js"),
    );
    const result = checkNvimPluginStaleness("/nonexistent/path");
    assert.equal(result.stale, false);
    assert.equal(result.daysSinceUpdate, 0);
    assert.ok(result.error);
  });

  it("returns no-op when WORK_SKIP_UPGRADES is set", () => {
    process.env.WORK_SKIP_UPGRADES = "1";
    const { checkNvimPluginStaleness } = requireFresh(
      path.join(LIB, "upgrades.js"),
    );
    const result = checkNvimPluginStaleness(tmpDir);
    assert.equal(result.stale, false);
    assert.equal(result.daysSinceUpdate, 0);
    assert.equal(result.error, undefined);
  });
});

describe("checkUpgrades", () => {
  afterEach(() => {
    delete process.env.WORK_SKIP_UPGRADES;
  });

  it("returns no-op when WORK_SKIP_UPGRADES is set", () => {
    process.env.WORK_SKIP_UPGRADES = "1";
    const { checkUpgrades } = requireFresh(path.join(LIB, "upgrades.js"));
    const result = checkUpgrades();
    assert.equal(result.hasActionableItems, false);
    assert.equal(result.brew.count, 0);
    assert.equal(result.nvimPlugins.stale, false);
  });
});

describe("tick upgrade check integration", { concurrency: 1 }, () => {
  let tmpDir, origVault, origXdg;
  const workBin = path.join(__dirname, "..", "bin", "work");
  const { execFileSync } = require("node:child_process");

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrades-tick-"));
    fs.mkdirSync(path.join(tmpDir, "projects", "dotfiles"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmpDir, "projects", "work"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "config", "work"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "config", "work", "config.json"),
      JSON.stringify({}),
    );
    fs.writeFileSync(
      path.join(tmpDir, "projects", "work", "project.md"),
      "---\nstatus: evergreen\n---\n\n# Work\n\n## Tasks\n\n## Changelog\n",
    );
    origVault = process.env.WORK_VAULT;
    origXdg = process.env.XDG_CONFIG_HOME;
  }

  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origVault === undefined) delete process.env.WORK_VAULT;
    else process.env.WORK_VAULT = origVault;
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  }

  function runTick(extraEnv = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const dailyNote = `---\nid: "${today}"\ntags: [daily-notes]\n---\n\n## Reviews\n\n## Tasks\n\n## Log\n`;
    fs.writeFileSync(path.join(tmpDir, `${today}.md`), dailyNote);
    return execFileSync("node", [workBin, "tick", "--verbose"], {
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
      timeout: 30000,
    });
  }

  function dotfilesProjectPath() {
    return path.join(tmpDir, "projects", "dotfiles", "project.md");
  }

  beforeEach(setup);
  afterEach(teardown);

  it("tick logs 'no upgrades' when WORK_SKIP_UPGRADES is set", () => {
    fs.writeFileSync(
      dotfilesProjectPath(),
      "---\nstatus: evergreen\n---\n\n# Dotfiles\n\n## Tasks\n\n## Changelog\n",
    );
    const output = runTick({ WORK_SKIP_UPGRADES: "1" });
    assert.ok(
      output.includes("no upgrades") || output.includes("upgrade check"),
      `expected upgrade check log in: ${output}`,
    );
    const content = fs.readFileSync(dotfilesProjectPath(), "utf-8");
    assert.ok(!content.includes("Upgrades available"));
  });

  it("tick does not duplicate upgrade task if one exists", () => {
    fs.writeFileSync(
      dotfilesProjectPath(),
      "---\nstatus: evergreen\n---\n\n# Dotfiles\n\n## Tasks\n- [ ] Upgrades available (5 brew) — run `upgrade`\n\n## Changelog\n",
    );
    const output = runTick({ WORK_SKIP_UPGRADES: "" });
    const content = fs.readFileSync(dotfilesProjectPath(), "utf-8");
    const matches = content.match(/Upgrades available/g);
    assert.equal(matches.length, 1, "should not duplicate upgrade task");
  });
});
