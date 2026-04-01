const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parse, serialize, findSection, appendToSection, replaceSection, mutateSection, insertSectionBefore, extractSection, parseFrontmatter, getTitle } = require('../lib/markdown.js');

describe('parse', () => {
  it('parses frontmatter', () => {
    const doc = parse('---\nstatus: active\n---\n\n## Tasks\n\n- item');
    assert.equal(doc.frontmatter, '---\nstatus: active\n---');
    assert.equal(doc.title, null);
    assert.equal(doc.sections.length, 1);
    assert.equal(doc.sections[0].name, 'Tasks');
    assert.deepEqual(doc.sections[0].lines, ['- item']);
  });

  it('parses title', () => {
    const doc = parse('# My Project\n\n## Tasks\n\n- item');
    assert.equal(doc.title, 'My Project');
    assert.equal(doc.sections[0].name, 'Tasks');
  });

  it('parses frontmatter and title', () => {
    const doc = parse('---\nstatus: active\n---\n\n# My Project\n\n## Tasks\n\n- item');
    assert.equal(doc.frontmatter, '---\nstatus: active\n---');
    assert.equal(doc.title, 'My Project');
  });

  it('parses multiple sections', () => {
    const doc = parse('## Tasks\n\n- a\n\n## Log\n\n- b\n\n## Notes\n\n- c');
    assert.equal(doc.sections.length, 3);
    assert.equal(doc.sections[0].name, 'Tasks');
    assert.equal(doc.sections[1].name, 'Log');
    assert.equal(doc.sections[2].name, 'Notes');
  });

  it('strips leading and trailing blank lines from section content', () => {
    const doc = parse('## Tasks\n\n- a\n- b\n\n\n## Log');
    assert.deepEqual(doc.sections[0].lines, ['- a', '- b']);
  });

  it('preserves internal blank lines in section content', () => {
    const doc = parse('## Tasks\n\n- a\n\n- b');
    assert.deepEqual(doc.sections[0].lines, ['- a', '', '- b']);
  });

  it('handles empty sections', () => {
    const doc = parse('## Tasks\n\n## Log');
    assert.deepEqual(doc.sections[0].lines, []);
    assert.deepEqual(doc.sections[1].lines, []);
  });

  it('handles section with no trailing heading', () => {
    const doc = parse('## Log\n\n- a\n- b');
    assert.deepEqual(doc.sections[0].lines, ['- a', '- b']);
  });

  it('handles preamble between title and first section', () => {
    const doc = parse('# Title\n\nSome preamble text\n\n## Tasks');
    assert.deepEqual(doc.preamble, ['Some preamble text']);
  });
});

describe('serialize', () => {
  it('round-trips a full document', () => {
    const input = '---\nstatus: active\n---\n\n# Project\n\n## Tasks\n\n- a\n\n## Log\n\n- b\n\n## Notes';
    assert.equal(serialize(parse(input)), input);
  });

  it('round-trips sections-only document', () => {
    const input = '## Tasks\n\n- a\n\n## Log\n\n- b';
    assert.equal(serialize(parse(input)), input);
  });

  it('normalizes missing blank lines between sections', () => {
    const input = '## Tasks\n- a\n## Log\n- b';
    const output = serialize(parse(input));
    assert.equal(output, '## Tasks\n\n- a\n\n## Log\n\n- b');
  });

  it('normalizes double blank lines', () => {
    const input = '## Tasks\n- a\n\n\n## Log\n- b';
    const output = serialize(parse(input));
    assert.equal(output, '## Tasks\n\n- a\n\n## Log\n\n- b');
  });

  it('serializes empty sections without content lines', () => {
    const output = serialize(parse('## Tasks\n\n## Log'));
    assert.equal(output, '## Tasks\n\n## Log');
  });

  it('is idempotent', () => {
    const inputs = [
      '---\nid: test\n---\n\n## Tasks\n\n- a\n\n## Log\n\n- b',
      '## Tasks\n\n## Log',
      '# Title\n\n## Tasks\n\n- a',
      '---\nstatus: active\n---\n\n# Title\n\n## Tasks\n\n- a\n- b\n\n## Changelog\n\n- [x] done\n\n## Notes',
    ];
    for (const input of inputs) {
      const once = serialize(parse(input));
      const twice = serialize(parse(once));
      assert.equal(once, twice, `not idempotent for: ${input}`);
    }
  });

  it('produces blank line after frontmatter', () => {
    const doc = { frontmatter: '---\nid: x\n---', title: null, preamble: [], sections: [{ name: 'Tasks', lines: ['- a'] }] };
    assert.equal(serialize(doc), '---\nid: x\n---\n\n## Tasks\n\n- a');
  });
});

describe('findSection', () => {
  it('finds existing section', () => {
    const doc = parse('## Tasks\n\n- a\n\n## Log\n\n- b');
    const section = findSection(doc, 'Log');
    assert.ok(section);
    assert.equal(section.name, 'Log');
    assert.deepEqual(section.lines, ['- b']);
  });

  it('returns null for missing section', () => {
    const doc = parse('## Tasks\n\n- a');
    assert.equal(findSection(doc, 'Log'), null);
  });
});

describe('appendToSection', () => {
  it('appends to populated section', () => {
    const doc = parse('## Log\n\n- a\n\n## Queue\n\n- b');
    appendToSection(doc, 'Log', ['- c']);
    assert.equal(serialize(doc), '## Log\n\n- a\n- c\n\n## Queue\n\n- b');
  });

  it('appends to empty section', () => {
    const doc = parse('## Log\n\n## Queue\n\n- b');
    appendToSection(doc, 'Log', ['- c']);
    assert.equal(serialize(doc), '## Log\n\n- c\n\n## Queue\n\n- b');
  });

  it('appends to last section', () => {
    const doc = parse('## Log\n\n- a');
    appendToSection(doc, 'Log', ['- c']);
    assert.equal(serialize(doc), '## Log\n\n- a\n- c');
  });

  it('no-op for missing section', () => {
    const doc = parse('## Log\n\n- a');
    appendToSection(doc, 'Missing', ['- c']);
    assert.equal(serialize(doc), '## Log\n\n- a');
  });
});

describe('replaceSection', () => {
  it('replaces section content', () => {
    const doc = parse('## Tasks\n\nold content\n\n## Log');
    replaceSection(doc, 'Tasks', ['new content']);
    assert.equal(serialize(doc), '## Tasks\n\nnew content\n\n## Log');
  });

  it('replaces with empty', () => {
    const doc = parse('## Tasks\n\n- a\n\n## Log');
    replaceSection(doc, 'Tasks', []);
    assert.equal(serialize(doc), '## Tasks\n\n## Log');
  });
});

describe('mutateSection', () => {
  it('transforms section lines', () => {
    const doc = parse('## Tasks\n\n- [ ] a\n- [ ] b');
    mutateSection(doc, 'Tasks', lines =>
      lines.map(l => l.includes('a') ? l.replace('[ ]', '[x]') : l)
    );
    assert.equal(serialize(doc), '## Tasks\n\n- [x] a\n- [ ] b');
  });

  it('can filter lines', () => {
    const doc = parse('## Tasks\n\n- [ ] a\n- [x] b\n- [ ] c');
    mutateSection(doc, 'Tasks', lines => lines.filter(l => !/\[x\]/.test(l)));
    assert.equal(serialize(doc), '## Tasks\n\n- [ ] a\n- [ ] c');
  });
});

describe('insertSectionBefore', () => {
  it('inserts before existing section', () => {
    const doc = parse('## Tasks\n\n- a\n\n## Notes');
    insertSectionBefore(doc, 'Notes', 'Changelog', ['- done']);
    assert.equal(serialize(doc), '## Tasks\n\n- a\n\n## Changelog\n\n- done\n\n## Notes');
  });

  it('appends when target not found', () => {
    const doc = parse('## Tasks\n\n- a');
    insertSectionBefore(doc, 'Missing', 'Changelog', ['- done']);
    assert.equal(serialize(doc), '## Tasks\n\n- a\n\n## Changelog\n\n- done');
  });
});

describe('extractSection', () => {
  it('extracts lines between headings', () => {
    const content = '## Queue\n\n- [ ] task1\n- [x] task2\n\n## Log\n\n- done';
    const result = extractSection(content, 'Queue');
    assert.deepEqual(result, ['- [ ] task1', '- [x] task2']);
  });

  it('returns empty for missing section', () => {
    const result = extractSection('## Other\n\nstuff', 'Queue');
    assert.deepEqual(result, []);
  });

  it('handles last section with no trailing heading', () => {
    const result = extractSection('## Queue\n\n- item1\n- item2', 'Queue');
    assert.deepEqual(result, ['- item1', '- item2']);
  });

  it('handles empty section', () => {
    const result = extractSection('## Queue\n\n## Log\n\n- done', 'Queue');
    assert.deepEqual(result, []);
  });

  it('preserves blank lines', () => {
    const result = extractSection('## Queue\n\n- a\n\n- b\n\n## Log', 'Queue');
    assert.deepEqual(result, ['- a', '', '- b']);
  });

  it('handles adjacent sections', () => {
    const content = '## A\n\na1\n\n## B\n\nb1\n\n## C\n\nc1';
    assert.deepEqual(extractSection(content, 'A'), ['a1']);
    assert.deepEqual(extractSection(content, 'B'), ['b1']);
    assert.deepEqual(extractSection(content, 'C'), ['c1']);
  });
});

describe('parseFrontmatter', () => {
  it('parses key-value pairs', () => {
    const content = '---\nstatus: active\nproject: "[[projects/foo|Foo]]"\n---\n# Title';
    const fm = parseFrontmatter(content);
    assert.equal(fm.status, 'active');
    assert.equal(fm.project, '[[projects/foo|Foo]]');
  });

  it('returns empty for no frontmatter', () => {
    const fm = parseFrontmatter('# Title\nstuff');
    assert.deepEqual(fm, {});
  });

  it('returns empty for empty frontmatter', () => {
    const fm = parseFrontmatter('---\n---\n# Title');
    assert.deepEqual(fm, {});
  });

  it('returns empty for unclosed frontmatter', () => {
    const fm = parseFrontmatter('---\nstatus: active\n# Title\nstuff');
    assert.deepEqual(fm, {});
  });
});

describe('getTitle', () => {
  it('extracts h1', () => {
    assert.equal(getTitle('---\nstatus: active\n---\n\n# My Title\n\nstuff'), 'My Title');
  });

  it('returns empty for no h1', () => {
    assert.equal(getTitle('no heading'), '');
  });
});