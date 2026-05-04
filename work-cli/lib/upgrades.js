const { execFileSync } = require("node:child_process");
const path = require("node:path");

const DEVBOX_GITHUB = {
  neovim: { repo: "neovim/neovim", tagPrefix: "v" },
  "lua-language-server": { repo: "LuaLS/lua-language-server", tagPrefix: "" },
  "efm-langserver": { repo: "mattn/efm-langserver", tagPrefix: "v" },
  unison: { repo: "bcpierce00/unison", tagPrefix: "v" },
};

function checkBrewOutdated() {
  if (process.env.WORK_SKIP_UPGRADES) {
    return { count: 0, formulae: [] };
  }
  try {
    const raw = execFileSync("brew", ["outdated", "--json=v2"], {
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });
    const data = JSON.parse(raw);
    const formulae = (data.formulae || []).map((f) => ({
      name: f.name,
      current: (f.installed_versions || []).join(", "),
      latest: f.current_version,
    }));
    return { count: formulae.length, formulae };
  } catch (e) {
    return { count: 0, formulae: [], error: e.message };
  }
}

function checkNpmOutdated() {
  if (process.env.WORK_SKIP_UPGRADES) {
    return { count: 0, packages: [] };
  }
  const nodeBinDir = path.join(__dirname, "..", "..", "node-bin");
  try {
    let raw;
    try {
      raw = execFileSync("npm", ["outdated", "--json"], {
        cwd: nodeBinDir,
        encoding: "utf-8",
        timeout: 30000,
      });
    } catch (e) {
      if (e.stdout) raw = e.stdout;
      else return { count: 0, packages: [], error: e.message };
    }
    const data = JSON.parse(raw || "{}");
    const packages = Object.entries(data).map(([name, info]) => ({
      name,
      current: info.current,
      latest: info.latest,
    }));
    return { count: packages.length, packages };
  } catch (e) {
    return { count: 0, packages: [], error: e.message };
  }
}

function checkGithubRelease(repo, tag) {
  try {
    execFileSync(
      "gh",
      ["release", "view", tag, "--repo", repo, "--json", "tagName"],
      {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

function filterDevboxAvailability(formulae) {
  return formulae.filter((f) => {
    const gh = DEVBOX_GITHUB[f.name];
    if (!gh) return true;
    const tag = `${gh.tagPrefix}${f.latest}`;
    return checkGithubRelease(gh.repo, tag);
  });
}

function checkUpgrades(opts = {}) {
  if (process.env.WORK_SKIP_UPGRADES) {
    return {
      brew: { count: 0, formulae: [] },
      npm: { count: 0, packages: [] },
      hasActionableItems: false,
    };
  }
  const brew = checkBrewOutdated();
  const npm = checkNpmOutdated();

  if (opts.checkDevboxAvailability !== false) {
    brew.formulae = filterDevboxAvailability(brew.formulae);
    brew.count = brew.formulae.length;
  }

  const hasActionableItems = brew.count > 0 || npm.count > 0;
  return { brew, npm, hasActionableItems };
}

function formatUpgradeLines(upgrades) {
  const lines = [];
  for (const f of upgrades.brew.formulae) {
    lines.push(`- [ ] ${f.name} ${f.current} → ${f.latest}`);
  }
  for (const p of upgrades.npm.packages) {
    lines.push(`- [ ] [npm] ${p.name} ${p.current} → ${p.latest}`);
  }
  return lines;
}

function parseUpgradeLine(line) {
  const npmMatch = line.match(/^- \[x\] \[npm\] (.+?) .+ → .+$/);
  if (npmMatch) {
    return { type: "npm", name: npmMatch[1] };
  }
  const brewMatch = line.match(/^- \[x\] (.+?) .+ → .+$/);
  if (brewMatch) {
    return { type: "brew", name: brewMatch[1] };
  }
  return null;
}

module.exports = {
  checkBrewOutdated,
  checkNpmOutdated,
  checkGithubRelease,
  filterDevboxAvailability,
  checkUpgrades,
  formatUpgradeLines,
  parseUpgradeLine,
  DEVBOX_GITHUB,
};
