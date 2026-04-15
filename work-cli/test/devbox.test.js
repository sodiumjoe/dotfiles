const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("devbox", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devbox-test-"));
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
    if (origVault === undefined) delete process.env.WORK_VAULT;
    else process.env.WORK_VAULT = origVault;
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
  }

  function writeProject(slug, content) {
    const dir = path.join(tmpDir, "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.md"), content);
  }

  function readProject(slug) {
    return fs.readFileSync(
      path.join(tmpDir, "projects", slug, "project.md"),
      "utf-8",
    );
  }

  function requireFresh() {
    const libDir = path.join(__dirname, "..", "lib");
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
    process.env.WORK_VAULT = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "config");
    return require(path.join(libDir, "devbox.js"));
  }

  describe("parseDevboxLine", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("parses empty field", () => {
      const { parseDevboxLine } = requireFresh();
      assert.deepEqual(parseDevboxLine("devboxes:"), []);
    });

    it("parses single entry", () => {
      const { parseDevboxLine } = requireFresh();
      assert.deepEqual(parseDevboxLine("devboxes: [my-box]"), ["my-box"]);
    });

    it("parses multiple entries", () => {
      const { parseDevboxLine } = requireFresh();
      assert.deepEqual(parseDevboxLine("devboxes: [a, b, c]"), ["a", "b", "c"]);
    });

    it("returns empty for null input", () => {
      const { parseDevboxLine } = requireFresh();
      assert.deepEqual(parseDevboxLine(null), []);
    });
  });

  describe("link", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("adds devbox to empty field", () => {
      writeProject("proj", "---\nstatus: active\ndevboxes:\n---\n\n# Proj\n");
      const { link } = requireFresh();
      const pf = path.join(tmpDir, "projects", "proj", "project.md");
      link(pf, "my-box");
      assert.match(readProject("proj"), /devboxes: \[my-box\]/);
    });

    it("adds devbox to existing list", () => {
      writeProject(
        "proj",
        "---\nstatus: active\ndevboxes: [old-box]\n---\n\n# Proj\n",
      );
      const { link } = requireFresh();
      const pf = path.join(tmpDir, "projects", "proj", "project.md");
      link(pf, "new-box");
      assert.match(readProject("proj"), /devboxes: \[old-box, new-box\]/);
    });

    it("does not duplicate", () => {
      writeProject(
        "proj",
        "---\nstatus: active\ndevboxes: [my-box]\n---\n\n# Proj\n",
      );
      const { link } = requireFresh();
      const pf = path.join(tmpDir, "projects", "proj", "project.md");
      const changed = link(pf, "my-box");
      assert.equal(changed, false);
    });

    it("inserts field when missing", () => {
      writeProject("proj", "---\nstatus: active\n---\n\n# Proj\n");
      const { link } = requireFresh();
      const pf = path.join(tmpDir, "projects", "proj", "project.md");
      link(pf, "my-box");
      const content = readProject("proj");
      assert.match(content, /devboxes: \[my-box\]/);
      assert.match(content, /devboxes: \[my-box\]\n---/);
    });
  });

  describe("unlink", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("removes from multiple", () => {
      writeProject(
        "proj",
        "---\nstatus: active\ndevboxes: [a, b, c]\n---\n\n# Proj\n",
      );
      const { unlink } = requireFresh();
      const pf = path.join(tmpDir, "projects", "proj", "project.md");
      unlink(pf, "b");
      assert.match(readProject("proj"), /devboxes: \[a, c\]/);
    });

    it("removes last entry", () => {
      writeProject(
        "proj",
        "---\nstatus: active\ndevboxes: [only]\n---\n\n# Proj\n",
      );
      const { unlink } = requireFresh();
      const pf = path.join(tmpDir, "projects", "proj", "project.md");
      unlink(pf, "only");
      assert.match(readProject("proj"), /^devboxes:$/m);
    });

    it("no-op when not present", () => {
      writeProject(
        "proj",
        "---\nstatus: active\ndevboxes: [a]\n---\n\n# Proj\n",
      );
      const { unlink } = requireFresh();
      const pf = path.join(tmpDir, "projects", "proj", "project.md");
      const changed = unlink(pf, "nope");
      assert.equal(changed, false);
    });
  });

  describe("listAll", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("returns projects with devboxes", () => {
      writeProject("a", "---\nstatus: active\ndevboxes: [box1]\n---\n\n# A\n");
      writeProject(
        "b",
        "---\nstatus: active\ndevboxes: [box2, box3]\n---\n\n# B\n",
      );
      writeProject("c", "---\nstatus: active\n---\n\n# C\n");
      const { listAll } = requireFresh();
      const results = listAll(path.join(tmpDir, "projects"));
      assert.equal(results.length, 2);
      const a = results.find((r) => r.slug === "a");
      const b = results.find((r) => r.slug === "b");
      assert.deepEqual(a.remotes, ["box1"]);
      assert.deepEqual(b.remotes, ["box2", "box3"]);
    });

    it("skips projects with empty devboxes", () => {
      writeProject("a", "---\nstatus: active\ndevboxes:\n---\n\n# A\n");
      const { listAll } = requireFresh();
      const results = listAll(path.join(tmpDir, "projects"));
      assert.equal(results.length, 0);
    });
  });

  describe("round-trip", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("link then unlink restores original", () => {
      const original = "---\nstatus: active\ndevboxes:\n---\n\n# Proj\n";
      writeProject("proj", original);
      const { link, unlink } = requireFresh();
      const pf = path.join(tmpDir, "projects", "proj", "project.md");
      link(pf, "tmp-box");
      assert.match(readProject("proj"), /devboxes: \[tmp-box\]/);
      unlink(pf, "tmp-box");
      assert.equal(readProject("proj"), original);
    });
  });
});
