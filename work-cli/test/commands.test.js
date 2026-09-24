const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DOTFILES_ROOT = path.resolve(__dirname, "..", "..");
const COMMANDS_DIR = path.join(DOTFILES_ROOT, "home", ".claude", "commands");
const SKILLS_DIR = path.join(DOTFILES_ROOT, "home", ".agents", "skills");
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

function supportHashes(frontmatter) {
  const hashes = [];
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "support_hashes:") continue;
    for (let j = i + 1; j < lines.length; j++) {
      const match = lines[j].match(/^  ([^:]+):\s*([a-f0-9]{64})$/);
      if (!match) break;
      hashes.push({ file: match[1], hash: match[2] });
    }
  }
  return hashes;
}

function compareVersions(left, right) {
  const pattern = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;
  const leftMatch = left.match(pattern);
  const rightMatch = right.match(pattern);
  if (!leftMatch || !rightMatch) {
    return left.localeCompare(right, undefined, { numeric: true });
  }
  for (let index = 1; index <= 3; index++) {
    const difference = Number(leftMatch[index] || 0) - Number(rightMatch[index] || 0);
    if (difference !== 0) return difference;
  }
  if (!leftMatch[4] && rightMatch[4]) return 1;
  if (leftMatch[4] && !rightMatch[4]) return -1;
  return (leftMatch[4] || "").localeCompare(rightMatch[4] || "", undefined, {
    numeric: true,
  });
}

function newestInstalledVersion(pluginDir) {
  if (!fs.existsSync(pluginDir)) return null;
  const versions = fs
    .readdirSync(pluginDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersions);
  return versions.at(-1) || null;
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
        `${file} body differs from home/.agents/skills/${slug}/SKILL.md — these should be kept in sync`,
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
        const [pluginName] = plugin.split("@");
        const pluginDir = path.join(PLUGIN_CACHE, pluginName);
        const version = newestInstalledVersion(pluginDir);
        if (!version) return;
        const upstreamPath = path.join(
          pluginDir,
          version,
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
          `upstream ${plugin}:${skillMatch[1].trim()} has changed in ${version} — ` +
            `run \`work check-upstream --diff\` to review`,
        );
      });

      it("support_hashes match installed plugin files", () => {
        const support = supportHashes(fm);
        if (support.length === 0) return;
        const plugin = pluginMatch[1].trim();
        const [pluginName] = plugin.split("@");
        const pluginDir = path.join(PLUGIN_CACHE, pluginName);
        const version = newestInstalledVersion(pluginDir);
        if (!version) return;
        const upstreamDir = path.join(
          pluginDir,
          version,
          "skills",
          skillMatch[1].trim(),
        );
        for (const item of support) {
          const localPath = path.join(SKILLS_DIR, dir.name, item.file);
          assert.ok(
            fs.existsSync(localPath),
            `${dir.name} tracks missing support file ${item.file}`,
          );
          const upstreamPath = path.join(upstreamDir, item.file);
          assert.ok(
            fs.existsSync(upstreamPath),
            `upstream support file missing: ${item.file}`,
          );
          const hash = crypto
            .createHash("sha256")
            .update(fs.readFileSync(upstreamPath, "utf-8"))
            .digest("hex");
          assert.equal(
            hash,
            item.hash,
            `upstream ${plugin}:${skillMatch[1].trim()}/${item.file} has changed — ` +
              `run \`work check-upstream --diff\` to review`,
          );
        }
      });
    });
  }
});

describe("local skill fork invariants", () => {
  it("executing-plans records plan completion through work complete", () => {
    const skillPath = path.join(SKILLS_DIR, "executing-plans", "SKILL.md");
    const content = fs.readFileSync(skillPath, "utf-8");

    assert.match(content, /Set `status: done` in the plan frontmatter/);
    assert.match(content, /work complete <project-slug-or-file> "<plan title>"/);
  });

  it("using-superpowers tracks referenced support files", () => {
    const skillPath = path.join(SKILLS_DIR, "using-superpowers", "SKILL.md");
    const content = fs.readFileSync(skillPath, "utf-8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/)[1];
    const tracked = new Set(supportHashes(fm).map((item) => item.file));
    const references = Array.from(
      content.matchAll(/`(references\/[^`]+)`/g),
      (match) => match[1],
    );

    assert.ok(references.length > 0);
    for (const file of references) {
      assert.ok(
        fs.existsSync(path.join(SKILLS_DIR, "using-superpowers", file)),
        `using-superpowers references missing local file ${file}`,
      );
      assert.ok(tracked.has(file), `${file} is missing from support_hashes`);
    }
  });
});