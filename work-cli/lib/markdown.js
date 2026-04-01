const fs = require('node:fs');

function parse(content) {
  const raw = content.split('\n');
  let i = 0;

  let frontmatter = null;
  if (raw[0] === '---') {
    for (let j = 1; j < raw.length; j++) {
      if (raw[j] === '---') {
        frontmatter = raw.slice(0, j + 1).join('\n');
        i = j + 1;
        break;
      }
    }
  }

  while (i < raw.length && raw[i].trim() === '') i++;

  let title = null;
  if (i < raw.length && /^# /.test(raw[i])) {
    title = raw[i].replace(/^# /, '');
    i++;
  }

  while (i < raw.length && raw[i].trim() === '') i++;

  const preamble = [];
  while (i < raw.length && !/^## /.test(raw[i])) {
    preamble.push(raw[i]);
    i++;
  }
  while (preamble.length > 0 && preamble[preamble.length - 1].trim() === '') preamble.pop();

  const sections = [];
  while (i < raw.length) {
    if (/^## /.test(raw[i])) {
      const name = raw[i].replace(/^## /, '').trim();
      i++;
      const lines = [];
      while (i < raw.length && !/^## /.test(raw[i])) {
        lines.push(raw[i]);
        i++;
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      while (lines.length > 0 && lines[0].trim() === '') lines.shift();
      sections.push({ name, lines });
    } else {
      i++;
    }
  }

  return { frontmatter, title, preamble, sections };
}

function serialize(doc) {
  const out = [];

  if (doc.frontmatter) {
    out.push(doc.frontmatter);
    out.push('');
  }

  if (doc.title) {
    out.push(`# ${doc.title}`);
    out.push('');
  }

  if (doc.preamble.length > 0) {
    out.push(...doc.preamble);
  }

  for (const section of doc.sections) {
    if (out.length > 0 && out[out.length - 1] !== '') {
      out.push('');
    }
    out.push(`## ${section.name}`);
    if (section.lines.length > 0) {
      out.push('');
      out.push(...section.lines);
    }
  }

  return out.join('\n');
}

function findSection(doc, name) {
  return doc.sections.find(s => s.name === name) || null;
}

function appendToSection(doc, name, lines) {
  const section = findSection(doc, name);
  if (!section) return;
  section.lines.push(...lines);
}

function replaceSection(doc, name, lines) {
  const section = findSection(doc, name);
  if (!section) return;
  section.lines = [...lines];
}

function mutateSection(doc, name, fn) {
  const section = findSection(doc, name);
  if (!section) return;
  section.lines = fn(section.lines);
}

function insertSectionBefore(doc, beforeName, name, lines) {
  const idx = doc.sections.findIndex(s => s.name === beforeName);
  const section = { name, lines: [...lines] };
  if (idx === -1) {
    doc.sections.push(section);
  } else {
    doc.sections.splice(idx, 0, section);
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSectionLineRange(lines, sectionName) {
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].match(new RegExp(`^##\\s+${escapeRegex(sectionName)}\\s*$`))) {
      start = i;
      continue;
    }
    if (start !== -1 && /^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return start === -1 ? null : { start, end };
}

function extractSection(content, sectionName) {
  const doc = parse(content);
  const section = findSection(doc, sectionName);
  return section ? [...section.lines] : [];
}

function extractSectionFromFile(filePath, sectionName) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return extractSection(content, sectionName);
}

function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return {};
  const result = {};
  let closed = false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { closed = true; break; }
    const match = lines[i].match(/^(\w+):\s*(.*)$/);
    if (match) {
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[match[1]] = val;
    }
  }
  return closed ? result : {};
}

function getTitle(content) {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1] : '';
}

module.exports = {
  parse,
  serialize,
  findSection,
  appendToSection,
  replaceSection,
  mutateSection,
  insertSectionBefore,
  findSectionLineRange,
  extractSection,
  extractSectionFromFile,
  parseFrontmatter,
  getTitle,
};