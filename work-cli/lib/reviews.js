const { execFile, execFileSync } = require("node:child_process");

const GH_HOST = "git.corp.stripe.com";
const TIMEOUT_MS = 10_000;

function humanizeError(msg) {
  if (msg && msg.includes("invalid character '<'")) {
    return "GHE API returned HTML instead of JSON (possible auth/connectivity issue)";
  }
  return msg;
}

function fetchReviews() {
  if (process.env.WORK_SKIP_REVIEWS) return { reviews: [], error: null };
  try {
    const raw = execFileSync(
      "gh",
      [
        "api",
        "/search/issues?q=is:pr+is:open+assignee:@me",
        "--jq",
        ".items[] | {title: .title, url: .html_url, author: .user.login, number: .number, repository_url: .repository_url, updated_at: .updated_at}",
      ],
      {
        env: { ...process.env, GH_HOST },
        timeout: TIMEOUT_MS,
        encoding: "utf-8",
      },
    );
    return { reviews: parseReviewLines(raw), error: null };
  } catch (e) {
    return { reviews: [], error: humanizeError(e.message) };
  }
}

function parseReviewLines(raw) {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const obj = JSON.parse(line);
      const repo = obj.repository_url.replace(/.*\/repos\//, "");
      return {
        title: obj.title,
        url: obj.url,
        author: obj.author,
        repo,
        number: obj.number,
        updatedAt: obj.updated_at,
      };
    });
}

function fetchReviewsAsync() {
  if (process.env.WORK_SKIP_REVIEWS)
    return Promise.resolve({ reviews: [], error: null });
  return new Promise((resolve) => {
    execFile(
      "gh",
      [
        "api",
        "/search/issues?q=is:pr+is:open+assignee:@me",
        "--jq",
        ".items[] | {title: .title, url: .html_url, author: .user.login, number: .number, repository_url: .repository_url, updated_at: .updated_at}",
      ],
      {
        env: { ...process.env, GH_HOST },
        timeout: TIMEOUT_MS,
        encoding: "utf-8",
      },
      (err, stdout) => {
        if (err)
          return resolve({ reviews: [], error: humanizeError(err.message) });
        try {
          resolve({ reviews: parseReviewLines(stdout), error: null });
        } catch (e) {
          resolve({ reviews: [], error: humanizeError(e.message) });
        }
      },
    );
  });
}

function formatReviews(reviews) {
  if (reviews.length === 0) return [];
  const lines = [];
  for (const r of reviews) {
    lines.push(
      `- [${r.repo}#${r.number}](${r.url}) — ${r.title} (${r.author})`,
    );
  }
  return lines;
}

module.exports = {
  fetchReviews,
  fetchReviewsAsync,
  formatReviews,
  humanizeError,
};
