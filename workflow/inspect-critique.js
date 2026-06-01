const fs = require('fs');
const parsed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const data = parsed.result || parsed;
const c = data.critique || {};
console.log('CRITIQUE KEYS:', JSON.stringify(Object.keys(c)));
for (const k of Object.keys(c)) {
  const v = c[k];
  if (Array.isArray(v)) console.log('\n[' + k + '] array len ' + v.length);
  else console.log('\n[' + k + '] (' + typeof v + ', len ' + String(v).length + '):\n' + String(v).slice(0, 600));
}
