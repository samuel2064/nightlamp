const { parseChangelogMarkdown } = require('./src/connectors/changelog');
const md = `## [2.0.0]

feat!: this is a breaking change

fix(auth)!: also breaking

## [1.0.0]

feat: normal feature`;
const entries = parseChangelogMarkdown(md);
console.log('num entries:', entries.length);
entries.forEach((e, i) => console.log(`[${i}] version=${JSON.stringify(e.version)} breaking=${e.isBreaking} body=${JSON.stringify(e.body.slice(0, 60))}`));
