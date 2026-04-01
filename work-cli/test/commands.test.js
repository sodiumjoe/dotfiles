const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const COMMANDS_DIR = path.join(__dirname, "..", "commands");
const SKILLS_DIR = path.join(__dirname, "..", "skills");
const PLUGIN_CACHE = path.join(
  os.homedir(),
  ".claude",
  "plugins",
  "cache",
  "stripe-internal-marketplace",
);

function stripFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0] !== "---") return content.trim();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return lines
        .slice(i + 1)
        .join("\n")
        .trim();
    }
  }
  return content.trim();
}

describe("commands", () => {
  const commandFiles = fs
    .readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".md"));

  it("all command files exist and are non-empty", () => {
    assert.ok(commandFiles.length > 0, "no command files found");
    for (const file of commandFiles) {
      const content = fs.readFileSync(path.join(COMMANDS_DIR, file), "utf-8");
      assert.ok(content.trim().length > 0, `${file} is empty`);
    }
  });

  it("no command has disable-model-invocation", () => {
    for (const file of commandFiles) {
      const content = fs.readFileSync(path.join(COMMANDS_DIR, file), "utf-8");
      assert.ok(
        !content.includes("disable-model-invocation"),
        `${file} has disable-model-invocation — this prevents the Skill tool from loading it`,
      );
    }
  });

  it("no command is a self-referential stub", () => {
    for (const file of commandFiles) {
      const content = fs.readFileSync(path.join(COMMANDS_DIR, file), "utf-8");
      const body = stripFrontmatter(content);
      const lines = body.split("\n").filter((l) => l.trim().length > 0);
      assert.ok(
        lines.length > 3,
        `${file} has only ${lines.length} non-empty lines — likely a stub`,
      );
    }
  });

  it("commands with matching skills have the same body content", () => {
    for (const file of commandFiles) {
      const slug = file.replace(/\.md$/, "");
      const skillPath = path.join(SKILLS_DIR, slug, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const commandBody = stripFrontmatter(
        fs.readFileSync(path.join(COMMANDS_DIR, file), "utf-8"),
      );
      const skillBody = stripFrontmatter(fs.readFileSync(skillPath, "utf-8"));
      assert.equal(
        commandBody,
        skillBody,
        `${file} body differs from skills/${slug}/SKILL.md — these should be kept in sync`,
      );
    }
  });
});

describe("forked skills", () => {
  const skillDirs = fs.existsSync(SKILLS_DIR)
    ? fs
        .readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
    : [];

  for (const dir of skillDirs) {
    const skillPath = path.join(SKILLS_DIR, dir.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    const pluginMatch = fm.match(/plugin:\s*(.+)/);
    const hashMatch = fm.match(/content_hash:\s*(.+)/);
    const skillMatch = fm.match(/skill:\s*(.+)/);
    if (!pluginMatch || !hashMatch || !skillMatch) continue;

    describe(dir.name, () => {
      it("upstream content_hash matches installed plugin", () => {
        const plugin = pluginMatch[1].trim();
        const [pluginName, registry] = plugin.split("@");
        const pluginDir = path.join(PLUGIN_CACHE, pluginName);
        if (!fs.existsSync(pluginDir)) return;
        const versions = fs.readdirSync(pluginDir).sort();
        if (versions.length === 0) return;
        const upstreamPath = path.join(
          pluginDir,
          versions[versions.length - 1],
          "skills",
          skillMatch[1].trim(),
          "SKILL.md",
        );
        if (!fs.existsSync(upstreamPath)) return;
        const hash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(upstreamPath, "utf-8"))
          .digest("hex");
        assert.equal(
          hash,
          hashMatch[1].trim(),
          `upstream ${plugin}:${skillMatch[1].trim()} has changed — ` +
            `run \`work check-upstream --diff\` to review`,
        );
      });
    });
  }
});
