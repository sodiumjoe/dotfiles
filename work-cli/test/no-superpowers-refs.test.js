const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ROOT = path.join(__dirname, "..");

const ALLOWED = new Set([
  "skills/using-superpowers/SKILL.md",
  "commands/create-project.md",
]);

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      results.push(...walk(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

describe("no superpowers references", () => {
  it("skill and command files do not reference superpowers namespace", () => {
    const dirs = [
      "skills",
      "commands",
      "agents",
      "hooks",
      ".claude-plugin",
    ].map((d) => path.join(PLUGIN_ROOT, d));
    const files = dirs.flatMap((d) => (fs.existsSync(d) ? walk(d) : []));
    const violations = [];

    for (const file of files) {
      const rel = path.relative(PLUGIN_ROOT, file);
      if (ALLOWED.has(rel)) continue;
      if (!file.endsWith(".md") && !file.endsWith(".json")) continue;
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/superpowers/i.test(lines[i])) {
          violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      `Found superpowers references:\n${violations.join("\n")}`,
    );
  });

  it("test fixtures may reference superpowers as upstream source", () => {
    const testDir = path.join(PLUGIN_ROOT, "test");
    const files = walk(testDir).filter((f) => f.endsWith(".test.js"));
    for (const file of files) {
      const rel = path.relative(PLUGIN_ROOT, file);
      if (rel === "test/no-superpowers-refs.test.js") continue;
      const content = fs.readFileSync(file, "utf8");
      if (/superpowers:((?!writing-plans)[a-z-]+)/.test(content)) {
        assert.fail(
          `${rel} references superpowers: namespace for non-upstream use`,
        );
      }
    }
  });
});
