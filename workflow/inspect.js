const fs = require('fs');
const raw = fs.readFileSync(process.argv[2], 'utf8');
let d;
try { d = JSON.parse(raw); }
catch (e) { console.log('TOP-LEVEL PARSE FAILED:', e.message); console.log('first 200 chars:', raw.slice(0, 200)); process.exit(0); }
console.log('TOP TYPE:', Array.isArray(d) ? 'array' : typeof d);
if (d && typeof d === 'object') console.log('TOP KEYS:', JSON.stringify(Object.keys(d)));

function find(obj, key, pathStr, depth) {
  if (depth > 6 || obj == null || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (k === key) console.log('FOUND "' + key + '" at: ' + pathStr + '.' + k + '  (type ' + (Array.isArray(obj[k]) ? 'array len ' + obj[k].length : typeof obj[k]) + ')');
    find(obj[k], key, pathStr + '.' + k, depth + 1);
  }
}
find(d, 'docs', '$', 0);
find(d, 'winner', '$', 0);
find(d, 'briefText', '$', 0);
