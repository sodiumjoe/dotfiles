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

describe("formatUpgradeLines", () => {
  it("formats brew and npm items as checkboxes", () => {
    const { formatUpgradeLines } = requireFresh(path.join(LIB, "upgrades.js"));
    const lines = formatUpgradeLines({
      brew: {
        count: 2,
        formulae: [
          { name: "neovim", current: "0.11.0", latest: "0.12.0" },
          { name: "ripgrep", current: "14.1.0", latest: "14.2.0" },
        ],
      },
      npm: {
        count: 1,
        packages: [
          { name: "@anthropic-ai/sdk", current: "1.2.0", latest: "1.3.0" },
        ],
      },
    });
    assert.deepEqual(lines, [
      "- [ ] neovim 0.11.0 → 0.12.0",
      "- [ ] ripgrep 14.1.0 → 14.2.0",
      "- [ ] [npm] @anthropic-ai/sdk 1.2.0 → 1.3.0",
    ]);
  });

  it("returns empty array when nothing outdated", () => {
    const { formatUpgradeLines } = requireFresh(path.join(LIB, "upgrades.js"));
    const lines = formatUpgradeLines({
      brew: { count: 0, formulae: [] },
      npm: { count: 0, packages: [] },
    });
    assert.deepEqual(lines, []);
  });
});

describe("parseUpgradeLine", () => {
  it("parses checked brew line", () => {
    const { parseUpgradeLine } = requireFresh(path.join(LIB, "upgrades.js"));
    const result = parseUpgradeLine("- [x] neovim 0.11.0 → 0.12.0");
    assert.deepEqual(result, { type: "brew", name: "neovim" });
  });

  it("parses checked npm line", () => {
    const { parseUpgradeLine } = requireFresh(path.join(LIB, "upgrades.js"));
    const result = parseUpgradeLine(
      "- [x] [npm] @anthropic-ai/sdk 1.2.0 → 1.3.0",
    );
    assert.deepEqual(result, { type: "npm", name: "@anthropic-ai/sdk" });
  });

  it("returns null for unchecked line", () => {
    const { parseUpgradeLine } = requireFresh(path.join(LIB, "upgrades.js"));
    const result = parseUpgradeLine("- [ ] neovim 0.11.0 → 0.12.0");
    assert.equal(result, null);
  });

  it("returns null for non-upgrade line", () => {
    const { parseUpgradeLine } = requireFresh(path.join(LIB, "upgrades.js"));
    const result = parseUpgradeLine("- [ ] some other task");
    assert.equal(result, null);
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
    assert.equal(result.npm.count, 0);
  });
});

describe("DEVBOX_GITHUB mapping", () => {
  it("has entries for all devbox-pinned tools", () => {
    const { DEVBOX_GITHUB } = requireFresh(path.join(LIB, "upgrades.js"));
    assert.ok(DEVBOX_GITHUB["neovim"]);
    assert.ok(DEVBOX_GITHUB["lua-language-server"]);
    assert.ok(DEVBOX_GITHUB["efm-langserver"]);
    assert.ok(DEVBOX_GITHUB["unison"]);
  });

  it("each entry has repo and tagPrefix", () => {
    const { DEVBOX_GITHUB } = requireFresh(path.join(LIB, "upgrades.js"));
    for (const [, val] of Object.entries(DEVBOX_GITHUB)) {
      assert.ok(typeof val.repo === "string");
      assert.ok(typeof val.tagPrefix === "string");
    }
  });
});

describe("tick upgrade integration", { concurrency: 1 }, () => {
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
    fs.writeFileSync(
      path.join(tmpDir, "projects", "dotfiles", "project.md"),
      "---\nstatus: evergreen\n---\n\n# Dotfiles\n\n## Tasks\n\n## Changelog\n",
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
    const dailyNote = `---\nid: "${today}"\ntags: [daily-notes]\n---\n\n## Reviews\n\n## Tasks\n\n## Log\n\n## Archive\n`;
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

  beforeEach(setup);
  afterEach(teardown);

  it("tick logs upgrade section when WORK_SKIP_UPGRADES is set", () => {
    const output = runTick({ WORK_SKIP_UPGRADES: "1" });
    assert.ok(
      output.includes("upgrades") || output.includes("no upgrades"),
      `expected upgrade log in: ${output}`,
    );
  });
});
