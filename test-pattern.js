const patterns = [
  /\{\s*ownerId\s*:\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*[,\}]/gi,
  /\{\s*ownerId\s*[,\}]/gi,  // shorthand property
  /ownerId\s*[,\}]/gi,  // simpler pattern
];

const line = '    body: JSON.stringify({ name: teamName, slug: teamSlug, ownerId, plan: "free" })';
console.log('Test line:', line);
for (const pattern of patterns) {
  console.log('Pattern:', pattern, 'test:', pattern.test(line));
}

// Test with the actual line from the file
const fs = require('fs');
const content = fs.readFileSync('ops/fixtures/stale-harness.js', 'utf8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  for (const pattern of patterns) {
    if (pattern.test(lines[i])) {
      console.log(`MATCH at line ${i + 1}: ${lines[i].trim()}`);
    }
  }
}