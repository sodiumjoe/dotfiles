const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let tmpDir;
let origVault;
let origXdg;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-test-'));
  fs.mkdirSync(path.join(tmpDir, 'projects'));
  fs.mkdirSync(path.join(tmpDir, 'plans'));
  fs.mkdirSync(path.join(tmpDir, 'config', 'work'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'config', 'work', 'config.json'),
    JSON.stringify({ plans: path.join(tmpDir, 'plans') })
  );
  origVault = process.env.WORK_VAULT;
  origXdg = process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origVault === undefined) {
    delete process.env.WORK_VAULT;
  } else {
    process.env.WORK_VAULT = origVault;
  }
  if (origXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = origXdg;
  }
});

function requireFresh(mod = 'reviews.js') {
  const libDir = path.join(__dirname, '..', 'lib');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libDir)) delete require.cache[key];
  }
  process.env.WORK_VAULT = tmpDir;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  return require(path.join(libDir, mod));
}

function writeDailyNote(dateStr, content) {
  fs.writeFileSync(path.join(tmpDir, `${dateStr}.md`), content);
}

function readDailyNote(dateStr) {
  return fs.readFileSync(path.join(tmpDir, `${dateStr}.md`), 'utf-8');
}

describe('formatReviews', () => {
  it('returns empty array for empty input', () => {
    const { formatReviews } = requireFresh();
    assert.deepStrictEqual(formatReviews([]), []);
  });

  it('formats PRs as markdown links', () => {
    const { formatReviews } = requireFresh();
    const reviews = [
      { title: 'Fix bug', url: 'https://gh.example.com/org/repo/pull/42', author: 'alice', repo: 'org/repo', number: 42 },
      { title: 'Add feature', url: 'https://gh.example.com/org/repo/pull/99', author: 'bob', repo: 'org/repo', number: 99 },
    ];
    const lines = formatReviews(reviews);
    assert.equal(lines[0], '- [org/repo#42](https://gh.example.com/org/repo/pull/42) — Fix bug (alice)');
    assert.equal(lines[1], '- [org/repo#99](https://gh.example.com/org/repo/pull/99) — Add feature (bob)');
    assert.equal(lines.length, 2);
  });
});

describe('injectReviews', () => {
  it('inserts Reviews section before Tasks when none exists', () => {
    const { injectReviews } = requireFresh('daily.js');
    const dateStr = '2026-01-01';
    writeDailyNote(dateStr, '---\nid: 2026-01-01\n---\n\n## Tasks\n\n## Log\n');
    const reviews = [
      { title: 'Fix bug', url: 'https://gh.example.com/org/repo/pull/42', author: 'alice', repo: 'org/repo', number: 42 },
    ];
    injectReviews(dateStr, reviews, { quiet: true });
    const content = readDailyNote(dateStr);
    assert.ok(content.indexOf('## Reviews') < content.indexOf('## Tasks'), 'Reviews should be before Tasks');
    assert.ok(content.includes('[org/repo#42]'));
  });

  it('replaces existing Reviews section', () => {
    const { injectReviews } = requireFresh('daily.js');
    const dateStr = '2026-01-01';
    writeDailyNote(dateStr, '---\nid: 2026-01-01\n---\n\n## Reviews\n\n- old content\n\n## Tasks\n\n## Log\n');
    const reviews = [
      { title: 'New PR', url: 'https://gh.example.com/org/repo/pull/7', author: 'carol', repo: 'org/repo', number: 7 },
    ];
    injectReviews(dateStr, reviews, { quiet: true });
    const content = readDailyNote(dateStr);
    assert.ok(!content.includes('old content'));
    assert.ok(content.includes('[org/repo#7]'));
  });

  it('clears Reviews section when reviews is empty', () => {
    const { injectReviews } = requireFresh('daily.js');
    const dateStr = '2026-01-01';
    writeDailyNote(dateStr, '---\nid: 2026-01-01\n---\n\n## Reviews\n\n- old content\n\n## Tasks\n\n## Log\n');
    injectReviews(dateStr, [], { quiet: true });
    const content = readDailyNote(dateStr);
    assert.ok(content.includes('## Reviews'));
    assert.ok(!content.includes('old content'));
  });

  it('creates Reviews section even when reviews is empty and section missing', () => {
    const { injectReviews } = requireFresh('daily.js');
    const dateStr = '2026-01-01';
    writeDailyNote(dateStr, '---\nid: 2026-01-01\n---\n\n## Tasks\n\n## Log\n');
    injectReviews(dateStr, [], { quiet: true });
    const content = readDailyNote(dateStr);
    assert.ok(content.includes('## Reviews'));
  });
});

describe('fetchReviews', () => {
  it('returns error when gh is not available', () => {
    const { fetchReviews } = requireFresh();
    const origPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const { reviews, error } = fetchReviews();
      assert.deepStrictEqual(reviews, []);
      assert.ok(error);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe('fetchReviewsAsync', () => {
  it('returns error when gh is not available', async () => {
    const { fetchReviewsAsync } = requireFresh();
    const origPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const { reviews, error } = await fetchReviewsAsync();
      assert.deepStrictEqual(reviews, []);
      assert.ok(error);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns empty when WORK_SKIP_REVIEWS is set', async () => {
    const origSkip = process.env.WORK_SKIP_REVIEWS;
    process.env.WORK_SKIP_REVIEWS = '1';
    try {
      const { fetchReviewsAsync } = requireFresh();
      const { reviews, error } = await fetchReviewsAsync();
      assert.deepStrictEqual(reviews, []);
      assert.strictEqual(error, null);
    } finally {
      if (origSkip === undefined) {
        delete process.env.WORK_SKIP_REVIEWS;
      } else {
        process.env.WORK_SKIP_REVIEWS = origSkip;
      }
    }
  });
});