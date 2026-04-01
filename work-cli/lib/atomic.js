const fs = require('node:fs');
const path = require('node:path');

function atomicRewrite(filePath, transformFn) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const newContent = transformFn(content);
  if (newContent === content) return false;
  const tmp = path.join(path.dirname(filePath), `.work-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, newContent);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return true;
}

module.exports = { atomicRewrite };