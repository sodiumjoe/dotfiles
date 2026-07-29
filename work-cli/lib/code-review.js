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

function enterPr(pr, cwd = process.cwd()) {
  const toplevel = toplevelOf(cwd);
  if (readSession(toplevel)) exitSession(cwd);

  const prNumber = String(pr);
  const { baseRefName } = JSON.parse(gh(toplevel, ["pr", "view", prNumber, "--json", "baseRefName"]));
  const user = gh(toplevel, ["api", "user", "--jq", ".login"]).trim();
  const headRef = `pr-${prNumber}`;
  const previousBranch = git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const session = {
    mode: "pr",
    id: prNumber,
    base_ref: "",
    head_ref: headRef,
    toplevel,
    previous_branch: previousBranch,
    stash_ref: null,
    user,
    reviewed: [],
  };

  writeSession(toplevel, session);

  if (git(toplevel, ["status", "--porcelain"]) !== "") {
    git(toplevel, ["stash", "push", "-m", `work review auto-stash (pr-${prNumber})`]);
    session.stash_ref = git(toplevel, ["rev-parse", "stash@{0}"]);
    writeSession(toplevel, session);
  }

  if (git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]) === headRef) {
    git(toplevel, ["checkout", "--detach", "HEAD"]);
  }
  tryGit(toplevel, ["branch", "-D", headRef]);
  git(toplevel, ["fetch", "origin", `pull/${prNumber}/head:${headRef}`]);
  git(toplevel, ["checkout", headRef]);
  tryGit(toplevel, ["fetch", "origin", baseRefName]);

  session.base_ref = tryGit(toplevel, ["merge-base", `origin/${baseRefName}`, headRef]) || `origin/${baseRefName}`;
  writeSession(toplevel, session);

  const rdir = reviewDir(toplevel);
  fs.writeFileSync(path.join(rdir, "diff"), gh(toplevel, ["pr", "diff", prNumber]));
  fs.writeFileSync(path.join(rdir, "files"), gh(toplevel, ["pr", "diff", prNumber, "--name-only"]));
  fs.writeFileSync(
    path.join(rdir, "commits"),
    gh(toplevel, [
      "pr",
      "view",
      prNumber,
      "--json",
      "commits",
      "--jq",
      '.commits[] | "\\(.oid) \\(.messageHeadline)"',
    ]),
  );
  let comments = "[]";
  try {
    comments = gh(toplevel, ["api", `repos/{owner}/{repo}/pulls/${prNumber}/comments`, "--paginate"]);
  } catch {}
  fs.writeFileSync(path.join(rdir, "pr-comments.json"), comments);

  nvimCall("require('sodium.review').load() return 0");
  const { mode, id, base_ref, head_ref } = session;
  return { mode, id, base_ref, head_ref, toplevel };
}

function localComments(toplevel, user) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(toplevel, ".nvim-comments.json"), "utf-8"));
  } catch {
    return [];
  }

  return Object.entries(data.comments || {})
    .filter(([id, comment]) => (comment.actor === user || comment.author === user) && !/^\d+$/.test(id))
    .map(([, comment]) => {
      let file = (comment.file || "").replace(/ \([^)]*\)$/, "");
      if (file.startsWith(toplevel + "/")) file = file.slice(toplevel.length + 1);
      const line = comment.line ?? comment.line_end ?? comment.line_start;
      return { path: file, line, side: "RIGHT", body: comment.body };
    })
    .filter((comment) => comment.line != null);
}

function submit(event, body = "", cwd = process.cwd()) {
  const toplevel = toplevelOf(cwd);
  const session = readSession(toplevel);
  if (!session) throw new Error("no review session");
  if (session.mode !== "pr") throw new Error("not a PR session");

  const payload = { event, comments: localComments(toplevel, session.user) };
  if (body) payload.body = body;
  gh(
    toplevel,
    ["api", `repos/{owner}/{repo}/pulls/${session.id}/reviews`, "-X", "POST", "--input", "-"],
    JSON.stringify(payload),
  );
  exitSession(cwd);
  return { status: "submitted", pr: session.id, event };
}

module.exports = {
  enterPr,
  exitSession,
  gh,
  git,
  localComments,
  readSession,
  sessionPath,
  submit,
  toplevelOf,
  tryGit,
  writeSession,
};