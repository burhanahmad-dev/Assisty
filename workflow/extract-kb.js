const fs = require('fs');
const path = require('path');
const OUT = process.argv[2];
const DEST = process.argv[3] || 'D:\\Assisty';
const parsed = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const data = parsed.result || parsed;

// 1) Write the Knowledge Base doc
if (data.kb && data.kb.markdown) {
  const target = path.join(DEST, data.kb.filename || 'docs/08-knowledge-base.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data.kb.markdown.endsWith('\n') ? data.kb.markdown : data.kb.markdown + '\n', 'utf8');
  console.log('WROTE: ' + target + '  (' + data.kb.markdown.length + ' chars)');
} else {
  console.log('NO KB MARKDOWN FOUND');
}

// 2) If any editor returned full markdown (could not edit in place), write it
const edits = Array.isArray(data.edits) ? data.edits : [];
console.log('\nMIGRATION SUMMARY (' + edits.length + ' editors reported):');
for (const e of edits) {
  if (!e) continue;
  const tag = e.couldEditInPlace ? 'in-place' : 'RETURNED-MARKDOWN';
  console.log('  - ' + (e.file || '?') + '  [' + tag + ']  edits=' + (e.editsApplied || 0) + '  staleLeft=' + (e.remainingStaleRefs == null ? '?' : e.remainingStaleRefs));
  if (e.couldEditInPlace === false && e.markdown && e.file) {
    try {
      fs.writeFileSync(e.file, e.markdown.endsWith('\n') ? e.markdown : e.markdown + '\n', 'utf8');
      console.log('      ^ wrote returned markdown to disk');
    } catch (err) { console.log('      ^ FAILED to write: ' + err.message); }
  }
}
