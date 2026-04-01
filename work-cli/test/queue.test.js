const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

describe("queue", { concurrency: 1 }, () => {
  let tmpDir;
  let origVault;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
    origVault = process.env.WORK_VAULT;
  }

  function teardown() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origVault === undefined) {
      delete process.env.WORK_VAULT;
    } else {
      process.env.WORK_VAULT = origVault;
    }
  }

  function requireFresh() {
    const libDir = path.join(__dirname, "..", "lib");
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(libDir)) delete require.cache[key];
    }
    process.env.WORK_VAULT = tmpDir;
    return require(path.join(libDir, "queue.js"));
  }

  function writeDailyNote(dateStr, content) {
    fs.writeFileSync(path.join(tmpDir, `${dateStr}.md`), content);
  }

  function readDailyNote(dateStr) {
    return fs.readFileSync(path.join(tmpDir, `${dateStr}.md`), "utf-8");
  }

  describe("enqueue", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("adds items to an existing section", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Archive\n\n## Log\n");
      const { enqueue } = requireFresh();
      const count = enqueue("2026-03-10", "Archive", [
        {
          key: "projects/foo",
          label: "[[projects/foo|Foo]] — completed 2026-03-01",
        },
      ]);
      assert.equal(count, 1);
      const content = readDailyNote("2026-03-10");
      assert.ok(
        content.includes(
          "- [ ] [[projects/foo|Foo]] — completed 2026-03-01 <!-- key:projects/foo -->",
        ),
      );
    });

    it("creates section if missing", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { enqueue } = requireFresh();
      enqueue("2026-03-10", "Archive", [{ key: "projects/bar", label: "Bar" }]);
      const content = readDailyNote("2026-03-10");
      assert.ok(content.includes("## Archive"));
      assert.ok(content.includes("<!-- key:projects/bar -->"));
    });

    it("is idempotent - skips items already present", () => {
      writeDailyNote(
        "2026-03-10",
        "## Archive\n- [ ] old <!-- key:projects/foo -->\n",
      );
      const { enqueue } = requireFresh();
      const count = enqueue("2026-03-10", "Archive", [
        { key: "projects/foo", label: "Foo again" },
      ]);
      assert.equal(count, 0);
      const content = readDailyNote("2026-03-10");
      const matches = content.match(/key:projects\/foo/g);
      assert.equal(matches.length, 1);
    });

    it("adds only new items when some already exist", () => {
      writeDailyNote(
        "2026-03-10",
        "## Archive\n- [ ] old <!-- key:projects/foo -->\n",
      );
      const { enqueue } = requireFresh();
      const count = enqueue("2026-03-10", "Archive", [
        { key: "projects/foo", label: "Foo" },
        { key: "projects/bar", label: "Bar" },
      ]);
      assert.equal(count, 1);
      const content = readDailyNote("2026-03-10");
      assert.ok(content.includes("key:projects/bar"));
    });

    it("returns undefined when daily note does not exist", () => {
      const { enqueue } = requireFresh();
      const result = enqueue("2026-03-10", "Archive", [
        { key: "projects/foo", label: "Foo" },
      ]);
      assert.equal(result, undefined);
    });

    it("handles multiple items", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { enqueue } = requireFresh();
      const count = enqueue("2026-03-10", "Archive", [
        { key: "projects/a", label: "A" },
        { key: "projects/b", label: "B" },
        { key: "projects/c", label: "C" },
      ]);
      assert.equal(count, 3);
      const content = readDailyNote("2026-03-10");
      assert.ok(content.includes("key:projects/a"));
      assert.ok(content.includes("key:projects/b"));
      assert.ok(content.includes("key:projects/c"));
    });
  });

  describe("dequeue", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("returns checked items and removes them", () => {
      writeDailyNote(
        "2026-03-10",
        [
          "## Archive",
          "- [x] Foo <!-- key:projects/foo -->",
          "- [ ] Bar <!-- key:projects/bar -->",
          "",
          "## Log",
        ].join("\n"),
      );
      const { dequeue } = requireFresh();
      const items = dequeue("2026-03-10", "Archive");
      assert.equal(items.length, 1);
      assert.equal(items[0].key, "projects/foo");
      assert.equal(items[0].label, "Foo");
      const content = readDailyNote("2026-03-10");
      assert.ok(!content.includes("key:projects/foo"));
      assert.ok(content.includes("key:projects/bar"));
    });

    it("returns empty array when nothing checked", () => {
      writeDailyNote(
        "2026-03-10",
        ["## Archive", "- [ ] Foo <!-- key:projects/foo -->"].join("\n"),
      );
      const { dequeue } = requireFresh();
      const items = dequeue("2026-03-10", "Archive");
      assert.equal(items.length, 0);
    });

    it("returns empty array when daily note missing", () => {
      const { dequeue } = requireFresh();
      const items = dequeue("2026-03-10", "Archive");
      assert.deepEqual(items, []);
    });

    it("returns empty array when section missing", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { dequeue } = requireFresh();
      const items = dequeue("2026-03-10", "Archive");
      assert.deepEqual(items, []);
    });

    it("handles multiple checked items", () => {
      writeDailyNote(
        "2026-03-10",
        [
          "## Archive",
          "- [x] A <!-- key:a -->",
          "- [x] B <!-- key:b -->",
          "- [ ] C <!-- key:c -->",
        ].join("\n"),
      );
      const { dequeue } = requireFresh();
      const items = dequeue("2026-03-10", "Archive");
      assert.equal(items.length, 2);
      assert.equal(items[0].key, "a");
      assert.equal(items[1].key, "b");
      const content = readDailyNote("2026-03-10");
      assert.ok(!content.includes("key:a"));
      assert.ok(!content.includes("key:b"));
      assert.ok(content.includes("key:c"));
    });

    it("preserves other sections", () => {
      writeDailyNote(
        "2026-03-10",
        [
          "## Tasks",
          "- [ ] Do stuff",
          "",
          "## Archive",
          "- [x] Done <!-- key:done -->",
          "",
          "## Log",
          "- [x] Logged something",
        ].join("\n"),
      );
      const { dequeue } = requireFresh();
      dequeue("2026-03-10", "Archive");
      const content = readDailyNote("2026-03-10");
      assert.ok(content.includes("## Tasks"));
      assert.ok(content.includes("- [ ] Do stuff"));
      assert.ok(content.includes("## Log"));
      assert.ok(content.includes("- [x] Logged something"));
    });
  });

  describe("enqueue then dequeue roundtrip", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("full cycle: enqueue, check, dequeue", () => {
      writeDailyNote("2026-03-10", "## Tasks\n\n## Log\n");
      const { enqueue, dequeue } = requireFresh();
      enqueue("2026-03-10", "Archive", [
        {
          key: "projects/foo",
          label: "[[projects/foo|Foo]] — completed 2026-03-01",
        },
        {
          key: "projects/bar",
          label: "[[projects/bar|Bar]] — completed 2026-03-02",
        },
      ]);
      let content = readDailyNote("2026-03-10");
      content = content.replace(
        "- [ ] [[projects/foo|Foo]]",
        "- [x] [[projects/foo|Foo]]",
      );
      fs.writeFileSync(path.join(tmpDir, "2026-03-10.md"), content);
      const items = dequeue("2026-03-10", "Archive");
      assert.equal(items.length, 1);
      assert.equal(items[0].key, "projects/foo");
      const final = readDailyNote("2026-03-10");
      assert.ok(!final.includes("key:projects/foo"));
      assert.ok(final.includes("key:projects/bar"));
    });
  });
});
