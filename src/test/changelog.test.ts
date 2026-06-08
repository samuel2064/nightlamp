import { expect } from 'chai';
import {
  parseChangelogMarkdown,
  analyzeChangelogForBreaking,
  classifyChangeSeverity,
  ChangelogEntry,
} from '../connectors/changelog';

describe('Changelog Parser', () => {
  it('parses a standard changelog with versions and dates', () => {
    const md = `# Changelog

## [2.0.0] - 2024-03-15

### Breaking Changes
- BREAKING CHANGE: Removed deprecated API v1

### Features
- Added new API v2 endpoint

## [1.1.0] - 2024-02-01

### Features
- Added pagination support

## [1.0.1] - 2024-01-15

### Bug Fixes
- Fixed timeout issue

## [1.0.0] - 2024-01-01

### Initial Release
- First release
`;

    const entries = parseChangelogMarkdown(md);
    expect(entries).to.have.lengthOf(4);

    expect(entries[0].version).to.equal('2.0.0');
    expect(entries[0].date).to.equal('2024-03-15');
    expect(entries[0].isBreaking).to.be.true;

    expect(entries[1].version).to.equal('1.1.0');
    expect(entries[1].isBreaking).to.be.false;

    expect(entries[3].version).to.equal('1.0.0');
    expect(entries[3].date).to.equal('2024-01-01');
  });

  it('parses changelogs without brackets in version headers', () => {
    const md = `## 3.0.0 (2024-06-01)

BREAKING CHANGE: Complete rewrite

## 2.0.0

Minor updates`;

    const entries = parseChangelogMarkdown(md);
    expect(entries).to.have.lengthOf(2);
    expect(entries[0].version).to.equal('3.0.0');
    expect(entries[0].isBreaking).to.be.true;
    expect(entries[1].version).to.equal('2.0.0');
  });

  it('detects breaking changes via !() syntax', () => {
    const md = `## [2.0.0]

feat!: this is a breaking change

fix(auth)!: also breaking

## [1.0.0]

feat: normal feature
`;

    const entries = parseChangelogMarkdown(md);
    expect(entries[0].isBreaking).to.be.true;
    expect(entries[1].isBreaking).to.be.false;
  });

  it('handles empty changelog', () => {
    const entries = parseChangelogMarkdown('');
    expect(entries).to.have.lengthOf(0);
  });

  it('handles changelog with no version headers', () => {
    const entries = parseChangelogMarkdown('Some free text\n\nNo versions here');
    expect(entries).to.have.lengthOf(0);
  });
});

describe('Changelog Breaking Analysis', () => {
  const sampleEntries: ChangelogEntry[] = [
    { version: '3.0.0', title: '3.0.0', body: 'BREAKING CHANGE: Major rewrite', isBreaking: true, date: '2024-06-01' },
    { version: '2.1.0', title: '2.1.0', body: 'feat: added new feature', isBreaking: false, date: '2024-05-01' },
    { version: '2.0.0', title: '2.0.0', body: 'BREAKING CHANGE: API restructured', isBreaking: true, date: '2024-04-01' },
    { version: '1.0.0', title: '1.0.0', body: 'Initial release', isBreaking: false, date: '2024-01-01' },
  ];

  it('detects breaking changes between versions', () => {
    const result = analyzeChangelogForBreaking('1.0.0', '3.0.0', sampleEntries);
    expect(result.breakingCount).to.equal(2);
    expect(result.latestBreakingVersion).to.equal('3.0.0');
  });

  it('finds breaking changes in minor range', () => {
    const result = analyzeChangelogForBreaking('1.0.0', '2.1.0', sampleEntries);
    expect(result.breakingCount).to.equal(1);
    expect(result.latestBreakingVersion).to.equal('2.0.0');
  });

  it('returns zero changes for same version', () => {
    const result = analyzeChangelogForBreaking('2.1.0', '2.1.0', sampleEntries);
    expect(result.breakingCount).to.equal(0);
    expect(result.latestBreakingVersion).to.be.null;
  });

  it('handles unknown versions gracefully', () => {
    const result = analyzeChangelogForBreaking('0.1.0', '5.0.0', sampleEntries);
    expect(result.breakingCount).to.equal(0);
    expect(result.latestBreakingVersion).to.be.null;
  });
});

describe('Change Severity Classification', () => {
  const noBreaks: any = { entries: [], latestBreakingVersion: null, breakingCount: 0 };
  const withBreaks: any = { entries: [], latestBreakingVersion: '3.0.0', breakingCount: 1 };

  it('classifies major + breaking as critical', () => {
    const result = classifyChangeSeverity('1.0.0', '2.0.0', withBreaks);
    expect(result.severity).to.equal('critical');
    expect(result.reasons.length).to.be.greaterThan(0);
  });

  it('classifies major without changelog as high', () => {
    const result = classifyChangeSeverity('1.0.0', '2.0.0', noBreaks);
    expect(result.severity).to.equal('high');
  });

  it('classifies breaking in same major as high', () => {
    const result = classifyChangeSeverity('1.1.0', '1.2.0', withBreaks);
    expect(result.severity).to.equal('high');
  });

  it('classifies minor bump as medium', () => {
    const result = classifyChangeSeverity('1.0.0', '1.1.0', noBreaks);
    expect(result.severity).to.equal('medium');
  });

  it('classifies patch bump as low', () => {
    const result = classifyChangeSeverity('1.0.0', '1.0.1', noBreaks);
    expect(result.severity).to.equal('low');
  });

  it('returns none for same version', () => {
    const result = classifyChangeSeverity('1.0.0', '1.0.0', noBreaks);
    expect(result.severity).to.equal('none');
  });

  it('handles v-prefixed versions', () => {
    const result = classifyChangeSeverity('v1.0.0', 'v2.0.0', noBreaks);
    expect(result.severity).to.equal('high');
  });

  it('handles single-component versions', () => {
    const result = classifyChangeSeverity('1', '2', noBreaks);
    expect(result.severity).to.equal('high');
  });
});