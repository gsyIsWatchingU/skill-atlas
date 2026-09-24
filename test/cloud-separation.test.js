'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

test('Skill 社区和云同步拥有独立入口与页面', () => {
  assert.match(html, /data-view="community"/);
  assert.match(html, /data-view="cloud"/);
  assert.match(html, /id="view-community"/);
  assert.match(html, /id="view-cloud"/);
  assert.doesNotMatch(html, /id="cloud-tab-community"/);
  assert.doesNotMatch(html, /id="cloud-tab-mine"/);
});

test('两个模块共用登录态，但分别加载自己的数据范围', () => {
  assert.match(app, /cloudUser:\s*null/);
  assert.match(app, /communitySkills:\s*\[\]/);
  assert.match(app, /cloudSkills:\s*\[\]/);
  assert.match(app, /loadCloudScope\('community'\)/);
  assert.match(app, /loadCloudScope\('mine'\)/);
  assert.match(app, /for \(const prefix of \['community', 'cloud'\]\)/);
});
