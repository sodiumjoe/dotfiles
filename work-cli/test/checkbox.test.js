const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseCheckboxItem, parseCheckboxItems, setState, parseWikilink, formatWikilink, stripWikilinkSuffix } = require('../lib/checkbox.js');

describe('parseCheckboxItem', () => {
  it('parses unchecked item', () => {
    const item = parseCheckboxItem('- [ ] some task', 0);
    assert.equal(item.state, ' ');
    assert.equal(item.text, 'some task');
    assert.equal(item.wikilink, null);
    assert.equal(item.doneDate, null);
  });

  it('parses in-progress item', () => {
    const item = parseCheckboxItem('- [/] some task', 5);
    assert.equal(item.state, '/');
    assert.equal(item.lineNum, 5);
  });

  it('parses completed item with done date', () => {
    const item = parseCheckboxItem('- [x] finished task ✅ 2026-03-05', 0);
    assert.equal(item.state, 'x');
    assert.equal(item.doneDate, '2026-03-05');
  });

  it('parses item with wikilink', () => {
    const item = parseCheckboxItem('- [ ] do thing — [[projects/foo|Foo Project]]', 0);
    assert.equal(item.text, 'do thing');
    assert.equal(item.wikilink, 'projects/foo|Foo Project');
  });

  it('returns null for non-checkbox line', () => {
    assert.equal(parseCheckboxItem('not a checkbox', 0), null);
    assert.equal(parseCheckboxItem('## Heading', 0), null);
  });
});

describe('parseCheckboxItems', () => {
  it('groups continuation lines', () => {
    const lines = ['- [ ] main task', '  continuation line', '  another line', '- [x] other'];
    const items = parseCheckboxItems(lines);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0].continuation, ['  continuation line', '  another line']);
    assert.deepEqual(items[1].continuation, []);
  });

  it('handles empty input', () => {
    assert.deepEqual(parseCheckboxItems([]), []);
  });
});

describe('setState', () => {
  it('changes state character', () => {
    assert.equal(setState('- [ ] task', '/'), '- [/] task');
    assert.equal(setState('- [/] task', 'x'), '- [x] task');
    assert.equal(setState('- [x] task', ' '), '- [ ] task');
  });
});

describe('parseWikilink', () => {
  it('extracts wikilink', () => {
    assert.equal(parseWikilink('text — [[projects/foo|Foo]]'), 'projects/foo|Foo');
  });

  it('returns null when no wikilink', () => {
    assert.equal(parseWikilink('plain text'), null);
  });
});

describe('formatWikilink', () => {
  it('formats correctly', () => {
    assert.equal(formatWikilink('projects/foo', 'Foo'), '[[projects/foo|Foo]]');
  });
});

describe('stripWikilinkSuffix', () => {
  it('strips wikilink suffix', () => {
    assert.equal(stripWikilinkSuffix('task — [[projects/foo|Foo]]'), 'task');
  });

  it('returns original if no suffix', () => {
    assert.equal(stripWikilinkSuffix('plain task'), 'plain task');
  });
});