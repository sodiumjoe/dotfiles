const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("archivePlans", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;
  let origXdg;

  function requireFresh() {
    const modPath = path.join(__dirname, "..", "lib", "project.js");
    delete require.cache[modPath];
    const pathsMod = path.join(__dirname, "..", "lib", "paths.js");
    delete require.cache[pathsMod];
    return require(modPath);
  }

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-plans-"));
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

  function writePlan(slug, filename, content) {
    const dir = path.join(tmpDir, "projects", slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content);
  }

  function readProject(slug) {
    return fs.readFileSync(
      path.join(tmpDir, "projects", slug, "project.md"),
      "utf-8",
    );
  }

  describe("core archiving", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("archives a plan with status: done from an evergreen project", () => {
      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[done-plan|Done Plan]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "done-plan.md",
        `---
status: done
project: [[projects/my-proj/project]]
---

# Done Plan`,
      );

      const { archivePlans } = requireFresh();
      const result = archivePlans({ quiet: true });

      assert.equal(result.length, 1);
      assert.equal(result[0].slug, "my-proj");
      assert.equal(result[0].basename, "done-plan");
      assert.ok(
        fs.existsSync(
          path.join(tmpDir, "archive", "projects", "my-proj", "done-plan.md"),
        ),
      );
      assert.ok(
        !fs.existsSync(
          path.join(tmpDir, "projects", "my-proj", "done-plan.md"),
        ),
      );
    });

    it("archives a plan with status: completed from an evergreen project", () => {
      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[completed-plan|Completed Plan]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "completed-plan.md",
        `---
status: completed
project: [[projects/my-proj/project]]
---

# Completed Plan`,
      );

      const { archivePlans } = requireFresh();
      const result = archivePlans({ quiet: true });

      assert.equal(result.length, 1);
      assert.equal(result[0].basename, "completed-plan");
      assert.ok(
        fs.existsSync(
          path.join(
            tmpDir,
            "archive",
            "projects",
            "my-proj",
            "completed-plan.md",
          ),
        ),
      );
    });

    it("skips plans with status: active", () => {
      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[active-plan|Active Plan]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "active-plan.md",
        `---
status: active
project: [[projects/my-proj/project]]
---

# Active Plan`,
      );

      const { archivePlans } = requireFresh();
      const result = archivePlans({ quiet: true });

      assert.equal(result.length, 0);
      assert.ok(
        fs.existsSync(
          path.join(tmpDir, "projects", "my-proj", "active-plan.md"),
        ),
      );
    });

    it("skips plans with no status field", () => {
      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[no-status|No Status]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "no-status.md",
        `---
project: [[projects/my-proj/project]]
---

# No Status Plan`,
      );

      const { archivePlans } = requireFresh();
      const result = archivePlans({ quiet: true });

      assert.equal(result.length, 0);
      assert.ok(
        fs.existsSync(path.join(tmpDir, "projects", "my-proj", "no-status.md")),
      );
    });

    it("skips non-evergreen projects entirely", () => {
      writeProject(
        "active-proj",
        `---
status: active
---

# Active Project

## Plans
- [[done-plan|Done Plan]]

## Tasks

## Changelog`,
      );
      writePlan(
        "active-proj",
        "done-plan.md",
        `---
status: done
project: [[projects/active-proj/project]]
---

# Done Plan`,
      );

      const { archivePlans } = requireFresh();
      const result = archivePlans({ quiet: true });

      assert.equal(result.length, 0);
      assert.ok(
        fs.existsSync(
          path.join(tmpDir, "projects", "active-proj", "done-plan.md"),
        ),
      );
    });
  });

  describe("plan link removal", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("removes only the archived plan link from Plans, keeps active plan links", () => {
      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[done-plan|Done Plan]]
- [[active-plan|Active Plan]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "done-plan.md",
        `---
status: done
---

# Done Plan`,
      );
      writePlan(
        "my-proj",
        "active-plan.md",
        `---
status: active
---

# Active Plan`,
      );

      const { archivePlans } = requireFresh();
      archivePlans({ quiet: true });

      const content = readProject("my-proj");
      assert.ok(!content.includes("[[done-plan"));
      assert.ok(content.includes("[[active-plan|Active Plan]]"));
    });

    it("removes stale archive/ links from previous runs", () => {
      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[archive/old-plan|Old Archived Plan]]
- [[archive/another-old|Another Old Plan]]
- [[active-plan|Active Plan]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "active-plan.md",
        `---
status: active
---

# Active Plan`,
      );

      const { archivePlans } = requireFresh();
      archivePlans({ quiet: true });

      const content = readProject("my-proj");
      assert.ok(!content.includes("[[archive/old-plan"));
      assert.ok(!content.includes("[[archive/another-old"));
      assert.ok(content.includes("[[active-plan|Active Plan]]"));
    });

    it("removes archive/ prefixed links for the archived plan basename", () => {
      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[archive/done-plan|Old Link]]
- [[done-plan|Done Plan]]
- [[active-plan|Active Plan]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "done-plan.md",
        `---
status: done
---

# Done Plan`,
      );
      writePlan(
        "my-proj",
        "active-plan.md",
        `---
status: active
---

# Active Plan`,
      );

      const { archivePlans } = requireFresh();
      archivePlans({ quiet: true });

      const content = readProject("my-proj");
      assert.ok(!content.includes("[[archive/done-plan"));
      assert.ok(!content.includes("[[done-plan"));
      assert.ok(content.includes("[[active-plan|Active Plan]]"));
    });
  });

  describe("edge cases", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("works when archive/projects/<slug>/ already exists", () => {
      const archiveDir = path.join(tmpDir, "archive", "projects", "my-proj");
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        path.join(archiveDir, "old-plan.md"),
        "# Old archived plan",
      );

      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[new-done|New Done]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "new-done.md",
        `---
status: done
---

# New Done`,
      );

      const { archivePlans } = requireFresh();
      const result = archivePlans({ quiet: true });

      assert.equal(result.length, 1);
      assert.ok(fs.existsSync(path.join(archiveDir, "new-done.md")));
      assert.ok(fs.existsSync(path.join(archiveDir, "old-plan.md")));
    });

    it("returns empty array when no plans are done", () => {
      writeProject(
        "my-proj",
        `---
status: evergreen
---

# My Project

## Plans
- [[active-plan|Active Plan]]

## Tasks

## Changelog`,
      );
      writePlan(
        "my-proj",
        "active-plan.md",
        `---
status: active
---

# Active Plan`,
      );

      const { archivePlans } = requireFresh();
      const result = archivePlans({ quiet: true });

      assert.deepEqual(result, []);
    });
  });
});
