function parseCheckboxItem(line, lineNum) {
  const match = line.match(/^- \[(.)\] (.*)$/);
  if (!match) return null;
  const state = match[1];
  let text = match[2];
  const wikilink = parseWikilink(text);
  if (wikilink) {
    text = text.replace(/ — \[\[.*\]\]$/, '');
  }
  let doneDate = null;
  const dateMatch = text.match(/ ✅ (\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) {
    doneDate = dateMatch[1];
  }
  return {
    state,
    text,
    wikilink,
    doneDate,
    rawLine: line,
    lineNum: lineNum ?? -1,
    continuation: [],
  };
}

function parseCheckboxItems(lines) {
  const items = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseCheckboxItem(lines[i], i);
    if (parsed) {
      if (current) items.push(current);
      current = parsed;
    } else if (current && /^\s/.test(lines[i]) && lines[i].trim() !== '') {
      current.continuation.push(lines[i]);
    } else {
      if (current) items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);
  return items;
}

function setState(line, newState) {
  return line.replace(/^(- \[).(])/, `$1${newState}$2`);
}

function parseWikilink(text) {
  const match = text.match(/\[\[([^\]]+)\]\]/);
  return match ? match[1] : null;
}

function formatWikilink(path, title) {
  return `[[${path}|${title}]]`;
}

function stripWikilinkSuffix(text) {
  return text.replace(/ — \[\[.*\]\]$/, '');
}

module.exports = {
  parseCheckboxItem,
  parseCheckboxItems,
  setState,
  parseWikilink,
  formatWikilink,
  stripWikilinkSuffix,
};