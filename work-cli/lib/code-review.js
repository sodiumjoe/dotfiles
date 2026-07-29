const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const NVIM_LUA = path.join(__dirname, "..", "..", "skills", "neovim", "scripts", "nvim-lua");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function gh(cwd, args, input) {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    ...(input != null ? { input } : {}),
  });
}

function nvimCall(lua) {
  try {
    execFileSync(NVIM_LUA, [lua], { stdio: "ignore" });
  } catch {}
}

function toplevelOf(cwd) {
  const toplevel = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) throw new Error("not a git repository");
  return toplevel;
}

function reviewDir(toplevel) {
  return path.join(toplevel, ".review");
}

function sessionPath(toplevel) {
  return path.join(reviewDir(toplevel), "session.json");
}

function readSession(toplevel) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(toplevel), "utf-8"));
  } catch {
    return null;
  }
}

function writeSession(toplevel, session) {
  fs.mkdirSync(reviewDir(toplevel), { recursive: true });
  fs.writeFileSync(sessionPath(toplevel), JSON.stringify(session, null, 2));
}

function exitSession(cwd = process.cwd()) {
  const toplevel = toplevelOf(cwd);
  const session = readSession(toplevel);
  if (!session) {
    fs.rmSync(reviewDir(toplevel), { recursive: true, force: true });
    return { status: "no_session" };
  }

  if (session.previous_branch && session.previous_branch !== "HEAD") {
    if (tryGit(toplevel, ["checkout", session.previous_branch]) === null) {
      console.error(`warning: could not restore branch '${session.previous_branch}'`);
    }
  }

  if (session.stash_ref) {
    const entry = (tryGit(toplevel, ["stash", "list", "--format=%gd %H"]) || "")
      .split("\n")
      .map((line) => line.split(" "))
      .find(([, sha]) => sha === session.stash_ref);
    if (entry && tryGit(toplevel, ["stash", "pop", entry[0]]) === null) {
      console.error(`warning: stash pop failed; changes remain in ${entry[0]}`);
    }
  }

  fs.rmSync(reviewDir(toplevel), { recursive: true, force: true });
  fs.rmSync(path.join(toplevel, ".nvim-comments.json"), { force: true });
  nvimCall("pcall(vim.cmd, 'CommentRefresh') require('sodium.review').reset() return 0");
  return { status: "exited" };
}

module.exports = {
  exitSession,
  gh,
  git,
  readSession,
  sessionPath,
  toplevelOf,
  tryGit,
  writeSession,
};