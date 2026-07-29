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
elif [[ "$1" == "api" && "$2" == "repos/{owner}/{repo}/pulls/7/reviews" ]]; then
  cat > "${tmpDir}/review-payload.json"
  printf '{}\\n'
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

  function writeComments(comments) {
    fs.writeFileSync(
      path.join(repoDir, ".nvim-comments.json"),
      JSON.stringify({ comments }, null, 2),
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

  it("fails PR entry rather than using a non-ancestor base", () => {
    git(["checkout", "--orphan", "unrelated"]);
    fs.rmSync(path.join(repoDir, "file.txt"), { force: true });
    fs.writeFileSync(path.join(repoDir, "other.txt"), "unrelated\n");
    git(["add", "-A"]);
    git(["commit", "-m", "unrelated"]);
    git(["push", "--force", "origin", "HEAD:refs/pull/7/head"]);
    git(["checkout", "main"]);

    const { enterPr, readSession } = require("../lib/code-review.js");
    assert.throws(() => enterPr(7, repoDir), /could not find merge-base/);
    assert.equal(git(["branch", "--show-current"]), "pr-7");
    assert.ok(readSession(repoDir));
  });

  it("maps only local pending comments to deterministic PR paths", () => {
    writeComments({
      "tmp-a": {
        actor: "moon",
        file: path.join(repoDir, "src/a/file.txt") + " (abc123)",
        line: 12,
        body: "absolute",
      },
      "tmp-b": {
        author: "moon",
        file: "src/b/file.txt (base)",
        line_end: 7,
        body: "relative",
      },
      "tmp-c": {
        actor: "moon",
        file: "src/c/file.txt",
        line_start: 4,
        body: "same basename",
      },
      "tmp-d": {
        actor: "other",
        file: "ignored.txt",
        line: 1,
        body: "other actor",
      },
      123: {
        actor: "moon",
        file: "existing.txt",
        line: 2,
        body: "github comment",
      },
      "tmp-e": {
        actor: "moon",
        file: "missing-line.txt",
        body: "missing line",
      },
    });

    const { localComments } = require("../lib/code-review.js");
    assert.deepEqual(localComments(repoDir, "moon"), [
      { path: "src/a/file.txt", line: 12, side: "RIGHT", body: "absolute" },
      { path: "src/b/file.txt", line: 7, side: "RIGHT", body: "relative" },
      { path: "src/c/file.txt", line: 4, side: "RIGHT", body: "same basename" },
    ]);
  });

  it("returns no local comments when the comments file is missing", () => {
    const { localComments } = require("../lib/code-review.js");
    assert.deepEqual(localComments(repoDir, "moon"), []);
  });

  it("submits a PR review with local comments and exits the session", () => {
    const { enterPr, submit } = require("../lib/code-review.js");
    enterPr(7, repoDir);
    writeComments({
      "tmp-a": {
        actor: "moon",
        file: "file.txt (abc123)",
        line: 1,
        body: "review note",
      },
    });

    assert.deepEqual(submit("REQUEST_CHANGES", "needs work", repoDir), {
      status: "submitted",
      pr: "7",
      event: "REQUEST_CHANGES",
    });

    const payload = JSON.parse(fs.readFileSync(path.join(tmpDir, "review-payload.json"), "utf-8"));
    assert.deepEqual(payload, {
      event: "REQUEST_CHANGES",
      body: "needs work",
      comments: [{ path: "file.txt", line: 1, side: "RIGHT", body: "review note" }],
    });
    assert.equal(git(["branch", "--show-current"]), "main");
    assert.ok(!fs.existsSync(path.join(repoDir, ".review")));
    assert.ok(!fs.existsSync(path.join(repoDir, ".nvim-comments.json")));
  });

  it("omits the review body when submitting with an empty body", () => {
    writeSession({
      mode: "pr",
      id: "7",
      previous_branch: "main",
      stash_ref: null,
      user: "moon",
    });

    const { submit } = require("../lib/code-review.js");
    assert.deepEqual(submit("APPROVE", "", repoDir), {
      status: "submitted",
      pr: "7",
      event: "APPROVE",
    });

    const payload = JSON.parse(fs.readFileSync(path.join(tmpDir, "review-payload.json"), "utf-8"));
    assert.deepEqual(payload, {
      event: "APPROVE",
      comments: [],
    });
    assert.ok(!("body" in payload));
  });
});