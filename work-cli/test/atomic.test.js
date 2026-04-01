const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { atomicRewrite } = require('../lib/atomic.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('atomicRewrite', () => {
  it('rewrites file content via transform function', () => {
    const f = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(f, 'hello');

    const result = atomicRewrite(f, c => c.replace('hello', 'world'));
    assert.equal(result, true);
    assert.equal(fs.readFileSync(f, 'utf-8'), 'world');
  });

  it('returns false when content unchanged', () => {
    const f = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(f, 'same');

    const result = atomicRewrite(f, c => c);
    assert.equal(result, false);
    assert.equal(fs.readFileSync(f, 'utf-8'), 'same');
  });

  it('does not leave temp files on success', () => {
    const f = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(f, 'before');

    atomicRewrite(f, () => 'after');

    const files = fs.readdirSync(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'test.txt');
  });

  it('preserves original file on transform error', () => {
    const f = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(f, 'original');

    assert.throws(() => {
      atomicRewrite(f, () => { throw new Error('transform failed'); });
    }, /transform failed/);

    assert.equal(fs.readFileSync(f, 'utf-8'), 'original');
  });
});