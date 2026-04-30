const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_STALE_DAYS = 14;

const NODE_BIN_PKG = path.join(
  __dirname,
  "..",
  "..",
  "node-bin",
  "package.json",
);
const DEVBOX_NPM_PACKAGES = Object.keys(
  JSON.parse(fs.readFileSync(NODE_BIN_PKG, "utf-8")).dependencies,
);

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

function checkNvimPluginStaleness(dotfilesRoot) {
  if (process.env.WORK_SKIP_UPGRADES) {
    return { stale: false, daysSinceUpdate: 0 };
  }
  const cwd =
    dotfilesRoot ||
    process.env.DOTFILES_ROOT ||
    path.join(process.env.HOME, ".dotfiles");
  try {
    const ts = execFileSync(
      "git",
      ["log", "-1", "--format=%ct", "lazy-lock.json"],
      {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
      },
    ).trim();
    const epochSec = parseInt(ts, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    const daysSinceUpdate = Math.floor((nowSec - epochSec) / 86400);
    return { stale: daysSinceUpdate > PLUGIN_STALE_DAYS, daysSinceUpdate };
  } catch (e) {
    return { stale: false, daysSinceUpdate: 0, error: e.message };
  }
}

function checkNpmOutdated() {
  if (process.env.WORK_SKIP_UPGRADES) {
    return { count: 0, packages: [] };
  }
  try {
    let raw;
    try {
      raw = execFileSync("npm", ["outdated", "-g", "--json"], {
        encoding: "utf-8",
        timeout: 30000,
      });
    } catch (e) {
      // npm outdated exits non-zero when packages are outdated
      if (e.stdout) raw = e.stdout;
      else return { count: 0, packages: [], error: e.message };
    }
    const data = JSON.parse(raw || "{}");
    const packages = Object.entries(data)
      .filter(([name]) => DEVBOX_NPM_PACKAGES.includes(name))
      .map(([name, info]) => ({
        name,
        current: info.current,
        latest: info.latest,
      }));
    return { count: packages.length, packages };
  } catch (e) {
    return { count: 0, packages: [], error: e.message };
  }
}

function checkUpgrades(opts = {}) {
  if (process.env.WORK_SKIP_UPGRADES) {
    return {
      brew: { count: 0, formulae: [] },
      npm: { count: 0, packages: [] },
      nvimPlugins: { stale: false, daysSinceUpdate: 0 },
      hasActionableItems: false,
    };
  }
  const brew = checkBrewOutdated();
  const npm = checkNpmOutdated();
  const nvimPlugins = checkNvimPluginStaleness(opts.dotfilesRoot);
  const hasActionableItems =
    brew.count > 0 || npm.count > 0 || nvimPlugins.stale;
  return { brew, npm, nvimPlugins, hasActionableItems };
}

module.exports = {
  checkBrewOutdated,
  checkNpmOutdated,
  checkNvimPluginStaleness,
  checkUpgrades,
  PLUGIN_STALE_DAYS,
  DEVBOX_NPM_PACKAGES,
};
