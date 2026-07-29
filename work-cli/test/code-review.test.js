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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-test-"));
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir);
    git(["init", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "base\n");
    git(["add", "file.txt"]);
    git(["commit", "-m", "initial"]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
});