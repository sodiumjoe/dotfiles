const fs = require('node:fs');
const { notePath } = require('./paths.js');
const { parse, serialize, findSection, appendToSection, extractSection } = require('./markdown.js');
const { atomicRewrite } = require('./atomic.js');

function enqueue(dateStr, section, items) {
  const np = notePath(dateStr);
  if (!fs.existsSync(np)) return;
  const content = fs.readFileSync(np, 'utf-8');
  const existing = extractSection(content, section).join('\n');
  const toAdd = items.filter(item => !existing.includes(item.key));
  if (toAdd.length === 0) return 0;
  const lines = toAdd.map(item => `- [ ] ${item.label} <!-- key:${item.key} -->`);
  atomicRewrite(np, c => {
    const doc = parse(c);
    if (!findSection(doc, section)) {
      doc.sections.push({ name: section, lines: [] });
    }
    appendToSection(doc, section, lines);
    return serialize(doc);
  });
  return toAdd.length;
}

function dequeue(dateStr, section) {
  const np = notePath(dateStr);
  if (!fs.existsSync(np)) return [];
  const content = fs.readFileSync(np, 'utf-8');
  const sectionLines = extractSection(content, section);
  const checked = [];
  for (const line of sectionLines) {
    const match = line.match(/^- \[x\] .+<!-- key:(.+?) -->/);
    if (match) {
      checked.push({ key: match[1], label: line.replace(/<!-- key:.+? -->/, '').replace(/^- \[x\] /, '').trim() });
    }
  }
  if (checked.length === 0) return [];
  const keysToRemove = new Set(checked.map(c => c.key));
  atomicRewrite(np, c => {
    const lines = c.split('\n');
    const filtered = lines.filter(line => {
      const m = line.match(/<!-- key:(.+?) -->/);
      return !(m && keysToRemove.has(m[1]) && /^- \[x\]/.test(line));
    });
    return filtered.join('\n');
  });
  return checked;
}

module.exports = { enqueue, dequeue };