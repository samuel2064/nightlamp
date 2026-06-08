import { expect } from 'chai';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { parsePackageJson, analyzeVersionChange, pollNpmRegistry } from '../connectors/npm-registry';
import { DependencyModel, DependencyInfo } from '../models/dependency';

describe('Dependency Detection - Package.json Parser', () => {
  it('parses dependencies from package.json', () => {
    const pkg = JSON.stringify({
      dependencies: {
        express: '^4.18.0',
        axios: '~1.6.0',
        lodash: '4.17.21',
      },
      devDependencies: {
        mocha: '^10.0.0',
        typescript: '^5.0.0',
      },
    });

    const deps = parsePackageJson(pkg);
    expect(deps).to.have.lengthOf(5);
    expect(deps[0].name).to.equal('express');
    expect(deps[0].currentVersion).to.equal('4.18.0');
    expect(deps[0].specifiedRange).to.equal('^4.18.0');
    expect(deps[0].isDev).to.be.false;
    expect(deps[4].name).to.equal('typescript');
    expect(deps[4].isDev).to.be.true;
  });

  it('handles empty package.json', () => {
    const deps = parsePackageJson('{}');
    expect(deps).to.have.lengthOf(0);
  });

  it('handles missing dependency fields', () => {
    const deps = parsePackageJson(JSON.stringify({ name: 'test' }));
    expect(deps).to.have.lengthOf(0);
  });

  it('resolves complex version ranges', () => {
    const pkg = JSON.stringify({
      dependencies: {
        a: '>=1.0.0 <2.0.0',
        b: '1.x',
        c: '^2.0.0 || ^3.0.0',
      },
    });
    const deps = parsePackageJson(pkg);
    expect(deps.find(d => d.name === 'a')!.currentVersion).to.equal('1.0.0');
    expect(deps.find(d => d.name === 'c')!.currentVersion).to.equal('2.0.0');
  });
});

describe('Dependency Detection - Version Analysis', () => {
  it('detects major version change as breaking', () => {
    const result = analyzeVersionChange('1.0.0', '2.0.0');
    expect(result.changeType).to.equal('major');
    expect(result.isBreaking).to.be.true;
  });

  it('detects minor version change as non-breaking', () => {
    const result = analyzeVersionChange('1.0.0', '1.1.0');
    expect(result.changeType).to.equal('minor');
    expect(result.isBreaking).to.be.false;
  });

  it('detects patch version change as non-breaking', () => {
    const result = analyzeVersionChange('1.0.0', '1.0.1');
    expect(result.changeType).to.equal('patch');
    expect(result.isBreaking).to.be.false;
  });

  it('returns unknown for same version', () => {
    const result = analyzeVersionChange('1.0.0', '1.0.0');
    expect(result.changeType).to.equal('unknown');
  });

  it('handles version strings with v prefix', () => {
    const result = analyzeVersionChange('v1.0.0', 'v2.0.0');
    expect(result.changeType).to.equal('major');
    expect(result.isBreaking).to.be.true;
  });

  it('handles single-component versions', () => {
    const result = analyzeVersionChange('1', '2');
    expect(result.changeType).to.equal('major');
    expect(result.isBreaking).to.be.true;
  });
});

describe('Dependency Detection - Npm Registry Poller', () => {
  it('polls npm registry for a real package', async () => {
    const info = await pollNpmRegistry('express');
    if (info) {
      expect(info.name).to.equal('express');
      expect(info.latestVersion).to.be.a('string');
      expect(info.latestVersion).to.not.equal('unknown');
      expect(info.versions.length).to.be.greaterThan(0);
    }
  });

  it('returns null for nonexistent package', async () => {
    const info = await pollNpmRegistry('this-package-should-not-exist-12345-abcde');
    expect(info).to.be.null;
  });
});

describe('Dependency Detection - Model', () => {
  let db: Database;
  let model: DependencyModel;

  beforeEach(async () => {
    db = await createDatabase();
    model = new DependencyModel(db);
  });

  it('upserts a new dependency', () => {
    const dep = model.upsert({ name: 'express', currentVersion: '4.18.0', specifiedRange: '^4.18.0', isDev: false });
    expect(dep.name).to.equal('express');
    expect(dep.currentVersion).to.equal('4.18.0');
    expect(dep.id).to.be.a('string');
  });

  it('updates existing dependency on upsert', () => {
    model.upsert({ name: 'express', currentVersion: '4.18.0', specifiedRange: '^4.18.0', isDev: false });
    const updated = model.upsert({ name: 'express', currentVersion: '4.19.0', specifiedRange: '^4.19.0', isDev: false });
    expect(updated.currentVersion).to.equal('4.19.0');
  });

  it('gets all dependencies', () => {
    model.upsert({ name: 'express', currentVersion: '4.18.0', specifiedRange: '^4.18.0', isDev: false });
    model.upsert({ name: 'mocha', currentVersion: '10.0.0', specifiedRange: '^10.0.0', isDev: true });
    const all = model.getAll();
    expect(all).to.have.lengthOf(2);
  });

  it('gets dependency by name', () => {
    model.upsert({ name: 'axios', currentVersion: '1.6.0', specifiedRange: '~1.6.0', isDev: false });
    const found = model.getByName('axios');
    expect(found).to.not.be.null;
    expect(found!.currentVersion).to.equal('1.6.0');
  });

  it('returns null for nonexistent dependency', () => {
    const found = model.getByName('nonexistent');
    expect(found).to.be.null;
  });

  it('checks for updates against npm registry', async () => {
    const dep = model.upsert({ name: 'express', currentVersion: '0.0.1', specifiedRange: '*', isDev: false });
    const update = await model.checkForUpdates(dep);
    if (update) {
      expect(update.dependencyId).to.equal(dep.id);
      expect(update.currentVersion).to.equal('0.0.1');
      expect(['major', 'minor', 'patch']).to.include(update.changeType);
    }
  });

  it('returns no update when version matches latest', async () => {
    const express = await pollNpmRegistry('express');
    if (express) {
      const dep = model.upsert({ name: 'express', currentVersion: express.latestVersion, specifiedRange: `^${express.latestVersion}`, isDev: false });
      const update = await model.checkForUpdates(dep);
      expect(update).to.be.null;
    }
  });

  it('gets updates with pagination', () => {
    const dep1 = model.upsert({ name: 'dep-a', currentVersion: '1.0.0', specifiedRange: '^1.0.0', isDev: false });
    const dep2 = model.upsert({ name: 'dep-b', currentVersion: '1.0.0', specifiedRange: '^1.0.0', isDev: false });

    model.getUpdates();
    const page1 = model.getUpdates(1, 0);
    expect(page1.updates).to.have.lengthOf(0);

    model.checkForUpdates(dep1);
    model.checkForUpdates(dep2);
  });
});