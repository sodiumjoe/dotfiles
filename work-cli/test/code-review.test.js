const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const workBin = path.join(__dirname, "..", "bin", "work");

describe("code review sessions", { concurrency: 1 }, () => {
  let tmpDir;
  let repoDir;
  let originDir;
  let origPath;
  let origFailPrDiff;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-test-"));
    repoDir = path.join(tmpDir, "repo");
    originDir = path.join(tmpDir, "origin.git");
    execFileSync("git", ["init", "--bare", originDir], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    fs.mkdirSync(repoDir);
    git(["init", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "base\n");
    git(["add", "file.txt"]);
    git(["commit", "-m", "initial"]);
    git(["remote", "add", "origin", originDir]);
    git(["push", "-u", "origin", "main"]);
    git(["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "pr change\n");
    git(["commit", "-am", "pr change"]);
    git(["push", "origin", "HEAD:refs/pull/7/head"]);
    git(["checkout", "main"]);
    git(["branch", "-D", "feature"]);
    origPath = process.env.PATH;
    origFailPrDiff = process.env.GH_FAIL_PR_DIFF;
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${tmpDir}/gh.log"
if [[ "$1" == "pr" && "$2" == "view" && "$3" == "7" && "$4" == "--json" && "$5" == "baseRefName" ]]; then
  printf '{"baseRefName":"main"}\\n'
elif [[ "$1" == "api" && "$2" == "user" ]]; then
  printf 'moon\\n'
elif [[ "$1" == "pr" && "$2" == "diff" && "$3" == "7" && "\${4:-}" == "--name-only" ]]; then
  printf 'file.txt\\n'
elif [[ "$1" == "pr" && "$2" == "diff" && "$3" == "7" ]]; then
  if [[ "\${GH_FAIL_PR_DIFF:-}" == "1" ]]; then exit 1; fi
  printf 'diff --git a/file.txt b/file.txt\\n'
elif [[ "$1" == "pr" && "$2" == "view" && "$3" == "7" && "$4" == "--json" && "$5" == "commits" ]]; then
  printf 'abc123 pr change\\n'
elif [[ "$1" == "api" && "$2" == "repos/{owner}/{repo}/pulls/7/comments" ]]; then
  printf '[]\\n'
else
  printf 'unexpected gh args: %s\\n' "$*" >&2
  exit 99
fi`,
    );
    fs.chmodSync(path.join(binDir, "gh"), 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
    delete process.env.GH_FAIL_PR_DIFF;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = origPath;
    }
    if (origFailPrDiff === undefined) {
      delete process.env.GH_FAIL_PR_DIFF;
    } else {
      process.env.GH_FAIL_PR_DIFF = origFailPrDiff;
    }
  });

  function git(args) {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }

  function writeSession(session) {
    fs.mkdirSync(path.join(repoDir, ".review"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".review", "session.json"),
      JSON.stringify(session, null, 2),
    );
  }

  it("exits idempotently and only pops the session stash by SHA", () => {
    fs.writeFileSync(path.join(repoDir, "file.txt"), "session dirty\n");
    git(["stash", "push", "-m", "session"]);
    const sessionStash = git(["stash", "list", "--format=%H"]).split("\n")[0];

    git(["checkout", "-b", "pr-1"]);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "decoy dirty\n");
    git(["stash", "push", "-m", "decoy"]);
    const decoyStash = git(["stash", "list", "--format=%H"]).split("\n")[0];

    writeSession({
      mode: "pr",
      id: "1",
      previous_branch: "main",
      stash_ref: sessionStash,
    });

    const { exitSession } = require("../lib/code-review.js");
    assert.deepEqual(exitSession(repoDir), { status: "exited" });
    assert.equal(git(["branch", "--show-current"]), "main");
    assert.equal(fs.readFileSync(path.join(repoDir, "file.txt"), "utf-8"), "session dirty\n");
    assert.ok(!fs.existsSync(path.join(repoDir, ".review")));

    const stashList = git(["stash", "list", "--format=%H"]);
    assert.match(stashList, new RegExp(decoyStash));
    assert.doesNotMatch(stashList, new RegExp(sessionStash));
    assert.deepEqual(exitSession(repoDir), { status: "no_session" });
  });

  it("dispatches work review exit", () => {
    const output = execFileSync("node", [workBin, "review", "exit"], {
      cwd: repoDir,
      encoding: "utf-8",
    });
    assert.deepEqual(JSON.parse(output), { status: "no_session" });
  });

  it("enters a PR review by writing a recoverable session and cached files", () => {
    fs.writeFileSync(path.join(repoDir, "file.txt"), "dirty local\n");
    const base = git(["rev-parse", "main"]);

    const { enterPr, readSession } = require("../lib/code-review.js");
    const result = enterPr(7, repoDir);

    assert.equal(result.mode, "pr");
    assert.equal(result.id, "7");
    assert.equal(result.base_ref, base);
    assert.equal(result.head_ref, "pr-7");
    assert.equal(git(["branch", "--show-current"]), "pr-7");

    const session = readSession(repoDir);
    assert.equal(session.previous_branch, "main");
    assert.ok(session.stash_ref);
    assert.equal(session.user, "moon");
    assert.deepEqual(session.reviewed, []);

    for (const file of ["diff", "files", "commits", "pr-comments.json"]) {
      assert.ok(fs.existsSync(path.join(repoDir, ".review", file)), file);
    }
    assert.equal(fs.readFileSync(path.join(repoDir, ".review", "files"), "utf-8"), "file.txt\n");
  });

  it("leaves a recoverable session when PR cache writing fails", () => {
    fs.writeFileSync(path.join(repoDir, "file.txt"), "dirty local\n");
    process.env.GH_FAIL_PR_DIFF = "1";

    const { enterPr, exitSession, readSession } = require("../lib/code-review.js");
    assert.throws(() => enterPr(7, repoDir));
    assert.ok(readSession(repoDir));
    assert.equal(git(["branch", "--show-current"]), "pr-7");

    assert.deepEqual(exitSession(repoDir), { status: "exited" });
    assert.equal(git(["branch", "--show-current"]), "main");
    assert.equal(fs.readFileSync(path.join(repoDir, "file.txt"), "utf-8"), "dirty local\n");
    assert.ok(!fs.existsSync(path.join(repoDir, ".review")));
  });
});