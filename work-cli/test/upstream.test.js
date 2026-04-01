const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

function requireFresh(mod) {
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

describe("checkUpstream", () => {
  let tmpDir, savedConfig;
  const LIB = path.join(__dirname, "..", "lib");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-test-"));
    savedConfig = process.env.WORK_UPSTREAM_CONFIG;
  });

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.WORK_UPSTREAM_CONFIG;
    else process.env.WORK_UPSTREAM_CONFIG = savedConfig;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupFakeEnv(skills, upstreamSkills) {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const [name, content] of Object.entries(skills)) {
      const dir = path.join(skillsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), content);
    }
    const upstreamDir = path.join(tmpDir, "upstream");
    if (upstreamSkills) {
      const upstreamSkillsDir = path.join(upstreamDir, "skills");
      for (const [name, content] of Object.entries(upstreamSkills)) {
        const dir = path.join(upstreamSkillsDir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), content);
      }
    }
    const configPath = path.join(tmpDir, "upstream-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        upstreams: {
          "superpowers@stripe-internal-marketplace": upstreamDir,
        },
      }),
    );
    process.env.WORK_UPSTREAM_CONFIG = configPath;
    return skillsDir;
  }

  function hash(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  function makeFrontmatter(name, upstreamContent) {
    return `---\nname: ${name}\ndescription: test skill\nplugin: superpowers@stripe-internal-marketplace\nversion: 1.0.1\nskill: ${name}\ncontent_hash: ${hash(upstreamContent)}\n---\n\n# ${name}`;
  }

  it("detects up-to-date skills", () => {
    const upstream = "---\nname: foo\n---\n# foo";
    const skillsDir = setupFakeEnv(
      { foo: makeFrontmatter("foo", upstream) },
      { foo: upstream },
    );
    const { checkUpstream } = requireFresh(path.join(LIB, "upstream.js"));
    const results = checkUpstream(skillsDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].skill, "foo");
    assert.equal(results[0].status, "up-to-date");
  });

  it("detects drifted skills", () => {
    const originalUpstream = "---\nname: bar\n---\n# bar v1";
    const newUpstream = "---\nname: bar\n---\n# bar v2 changed";
    const skillsDir = setupFakeEnv(
      { bar: makeFrontmatter("bar", originalUpstream) },
      { bar: newUpstream },
    );
    const { checkUpstream } = requireFresh(path.join(LIB, "upstream.js"));
    const results = checkUpstream(skillsDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].skill, "bar");
    assert.equal(results[0].status, "drifted");
    assert.equal(results[0].storedHash, hash(originalUpstream));
    assert.equal(results[0].currentHash, hash(newUpstream));
    assert.equal(results[0].forkedVersion, "1.0.1");
    assert.ok(results[0].upstreamFile.endsWith("SKILL.md"));
    assert.ok(results[0].localFile.endsWith("SKILL.md"));
  });

  it("handles missing upstream path gracefully", () => {
    const upstream = "---\nname: baz\n---\n# baz";
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "baz"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "baz", "SKILL.md"),
      makeFrontmatter("baz", upstream),
    );
    const configPath = path.join(tmpDir, "upstream-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        upstreams: {
          "superpowers@stripe-internal-marketplace": path.join(
            tmpDir,
            "nonexistent-upstream",
          ),
        },
      }),
    );
    process.env.WORK_UPSTREAM_CONFIG = configPath;
    const { checkUpstream } = requireFresh(path.join(LIB, "upstream.js"));
    const results = checkUpstream(skillsDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].skill, "baz");
    assert.equal(results[0].status, "no-cache");
    assert.ok(results[0].message.includes("upstream path not found"));
  });

  it("skips skills without tracking frontmatter", () => {
    const skillsDir = setupFakeEnv(
      { qux: "---\nname: qux\ndescription: no tracking\n---\n# qux" },
      { qux: "---\nname: qux\n---\n# qux" },
    );
    const { checkUpstream } = requireFresh(path.join(LIB, "upstream.js"));
    const results = checkUpstream(skillsDir);
    assert.equal(results.length, 0);
  });

  it("returns empty for nonexistent skills directory", () => {
    const { checkUpstream } = requireFresh(path.join(LIB, "upstream.js"));
    const results = checkUpstream(path.join(tmpDir, "nonexistent"));
    assert.equal(results.length, 0);
  });

  it("reports no-upstream when skill missing from upstream repo", () => {
    const upstream = "---\nname: missing\n---\n# missing";
    const skillsDir = setupFakeEnv(
      { missing: makeFrontmatter("missing", upstream) },
      { "other-skill": upstream },
    );
    const { checkUpstream } = requireFresh(path.join(LIB, "upstream.js"));
    const results = checkUpstream(skillsDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].skill, "missing");
    assert.equal(results[0].status, "no-upstream");
  });

  it("reports no-upstream-config for unknown plugin", () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(path.join(skillsDir, "unknown"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "unknown", "SKILL.md"),
      "---\nname: unknown\nplugin: other-plugin@other-registry\nskill: unknown\ncontent_hash: abc123\n---\n\n# unknown",
    );
    const configPath = path.join(tmpDir, "upstream-config.json");
    fs.writeFileSync(configPath, JSON.stringify({ upstreams: {} }));
    process.env.WORK_UPSTREAM_CONFIG = configPath;
    const { checkUpstream } = requireFresh(path.join(LIB, "upstream.js"));
    const results = checkUpstream(skillsDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].skill, "unknown");
    assert.equal(results[0].status, "no-upstream-config");
    assert.ok(results[0].message.includes("no upstream configured"));
  });

  it("handles multiple skills with mixed statuses", () => {
    const upA = "---\nname: a\n---\n# a";
    const upB = "---\nname: b\n---\n# b v1";
    const upBNew = "---\nname: b\n---\n# b v2";
    const skillsDir = setupFakeEnv(
      {
        a: makeFrontmatter("a", upA),
        b: makeFrontmatter("b", upB),
        c: "---\nname: c\n---\n# no tracking",
      },
      { a: upA, b: upBNew, c: "---\nname: c\n---\n# c" },
    );
    const { checkUpstream } = requireFresh(path.join(LIB, "upstream.js"));
    const results = checkUpstream(skillsDir);
    const bySkill = Object.fromEntries(results.map((r) => [r.skill, r]));
    assert.equal(bySkill.a.status, "up-to-date");
    assert.equal(bySkill.b.status, "drifted");
    assert.equal(bySkill.c, undefined);
  });
});

describe("tick upstream drift integration", { concurrency: 1 }, () => {
  let tmpDir, origVault, origXdg, origConfig;
  const workBin = path.join(__dirname, "..", "bin", "work");
  const { execFileSync } = require("node:child_process");

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-tick-"));
    fs.mkdirSync(path.join(tmpDir, "projects", "work"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "config", "work"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "config", "work", "config.json"),
      JSON.stringify({}),
    );
    origVault = process.env.WORK_VAULT;
    origXdg = process.env.XDG_CONFIG_HOME;
    origConfig = process.env.WORK_UPSTREAM_CONFIG;
  }

  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origVault === undefined) delete process.env.WORK_VAULT;
    else process.env.WORK_VAULT = origVault;
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    if (origConfig === undefined) delete process.env.WORK_UPSTREAM_CONFIG;
    else process.env.WORK_UPSTREAM_CONFIG = origConfig;
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
        CLAUDECODE: "",
        ...extraEnv,
      },
      encoding: "utf-8",
      timeout: 10000,
    });
  }

  function projectPath() {
    return path.join(tmpDir, "projects", "work", "project.md");
  }

  beforeEach(setup);
  afterEach(teardown);

  it("tick logs 'all skills up to date' when no drift", () => {
    fs.writeFileSync(
      projectPath(),
      "---\nstatus: evergreen\n---\n\n# Work\n\n## Tasks\n\n## Changelog\n",
    );
    const output = runTick();
    assert.ok(
      output.includes("all skills up to date"),
      `expected "all skills up to date" in: ${output}`,
    );
    const content = fs.readFileSync(projectPath(), "utf-8");
    assert.ok(!content.includes("Review upstream skill drift"));
  });

  it("tick appends drift task when drift detected and no task exists", () => {
    fs.writeFileSync(
      projectPath(),
      "---\nstatus: evergreen\n---\n\n# Work\n\n## Tasks\n\n## Changelog\n",
    );
    const skillsDir = path.join(tmpDir, "fakeskills");
    const upstreamContent =
      "---\nname: test-skill\n---\n# test-skill v2 changed";
    const originalContent = "---\nname: test-skill\n---\n# test-skill v1";
    const storedHash = crypto
      .createHash("sha256")
      .update(originalContent)
      .digest("hex");
    fs.mkdirSync(path.join(skillsDir, "test-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "test-skill", "SKILL.md"),
      `---\nname: test-skill\nplugin: superpowers@stripe-internal-marketplace\nversion: 1.0.1\nskill: test-skill\ncontent_hash: ${storedHash}\n---\n\n# test-skill`,
    );
    const upstreamDir = path.join(tmpDir, "fake-upstream");
    fs.mkdirSync(path.join(upstreamDir, "skills", "test-skill"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(upstreamDir, "skills", "test-skill", "SKILL.md"),
      upstreamContent,
    );
    const configPath = path.join(tmpDir, "upstream-config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        upstreams: {
          "superpowers@stripe-internal-marketplace": upstreamDir,
        },
      }),
    );
    const output = runTick({
      WORK_UPSTREAM_CONFIG: configPath,
      WORK_SKILLS_DIR: skillsDir,
    });
    assert.ok(
      output.includes("drift detected"),
      `expected "drift detected" in: ${output}`,
    );
    const content = fs.readFileSync(projectPath(), "utf-8");
    assert.ok(
      content.includes("Review upstream skill drift: test-skill"),
      `expected drift task in project file: ${content}`,
    );
  });

  it("tick does not duplicate drift task if one exists", () => {
    fs.writeFileSync(
      projectPath(),
      "---\nstatus: evergreen\n---\n\n# Work\n\n## Tasks\n- [ ] Review upstream skill drift: foo — run `work check-upstream --diff`\n\n## Changelog\n",
    );
    const output = runTick();
    const content = fs.readFileSync(projectPath(), "utf-8");
    const matches = content.match(/Review upstream skill drift/g);
    assert.equal(matches.length, 1, "should not duplicate drift task");
  });

  it("tick does not duplicate drift task if one is in-progress", () => {
    fs.writeFileSync(
      projectPath(),
      "---\nstatus: evergreen\n---\n\n# Work\n\n## Tasks\n- [/] Review upstream skill drift: foo — run `work check-upstream --diff`\n\n## Changelog\n",
    );
    const output = runTick();
    const content = fs.readFileSync(projectPath(), "utf-8");
    const matches = content.match(/Review upstream skill drift/g);
    assert.equal(
      matches.length,
      1,
      "should not duplicate in-progress drift task",
    );
  });
});
