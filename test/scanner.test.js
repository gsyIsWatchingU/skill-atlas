'use strict';

/**
 * 共享扫描内核的契约测试。
 *
 * 这组测试是**跨通道防漂移的凭据**：CLI 与桌面宿主都用 src/scanner，
 * 谁改了语义都会在这里红掉。重点覆盖 docs/solution.md §11.1 的四条不可让步约束：
 *   1. 默认跟随链接
 *   2. 不拒绝跳出扫描根的链接（但要如实记录）
 *   3. 哈希用逻辑路径而非 realpath
 *   4. 同一个链接在一次扫描里只记一次
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const scanner = require('../src/scanner');

const AGENTS_ROOT = {
  id: 'shared-agents',
  platform: 'shared',
  scope: 'user',
  label: '跨 Agent 共享 Skill',
  displayPath: '%USERPROFILE%\\.agents\\skills',
  segments: ['.agents', 'skills']
};

async function writeSkill(directory, name, description) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    'utf8'
  );
}

/**
 * 建目录链接：Windows 上目录 symlink 需要开发者模式，失败则退回 junction。
 * 两者对扫描器是同一件事（readdir 都报 isSymbolicLink）。
 */
async function linkDirectory(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, 'dir');
    return true;
  } catch (error) {
    if (process.platform !== 'win32') return false;
    try {
      await fs.symlink(target, linkPath, 'junction');
      return true;
    } catch {
      return false;
    }
  }
}

test('共享内核扫描默认根并解析 frontmatter', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeSkill(path.join(home, '.agents', 'skills', 'alpha'), 'alpha', '第一个技能');
  // 块标量描述：多行值应被拼成一段，而不是丢成空
  await fs.mkdir(path.join(home, '.agents', 'skills', 'beta'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.agents', 'skills', 'beta', 'SKILL.md'),
    '---\nname: beta\ndescription: >\n  第二行描述\n  拼在一起\n---\n',
    'utf8'
  );

  const result = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });

  assert.equal(result.roots[0].status, 'ready');
  assert.equal(result.skills.length, 2);
  const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]));
  assert.equal(byName.alpha.description, '第一个技能');
  assert.equal(byName.beta.description, '第二行描述 拼在一起');
  assert.equal(result.scannerVersion, scanner.SCANNER_VERSION);
});

test('凭据类文件不入哈希，只计 skippedSensitive', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const skill = path.join(home, '.agents', 'skills', 'secretive');
  await writeSkill(skill, 'secretive', '含凭据文件');
  await fs.writeFile(path.join(skill, '.env'), 'TOKEN=leak\n', 'utf8');
  await fs.writeFile(path.join(skill, 'id_rsa.key'), 'key\n', 'utf8');
  await fs.writeFile(path.join(skill, 'notes.md'), '# 说明\n', 'utf8');

  const result = await scanner.scanRoots({
    homeDirectory: home, roots: [AGENTS_ROOT], includeFiles: true
  });

  const [found] = result.skills;
  assert.equal(found.skippedSensitive, 2);
  assert.deepEqual(found.files.map((f) => f.path).sort(), ['SKILL.md', 'notes.md']);
  // 哈希里不能出现任何凭据内容
  assert.equal(found.versionHash, scanner.computeVersionHash(found.files));
});

test('默认跟随跳出扫描根的链接，并把它记进 outsideRoot（§11.1 约束 1+2）', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const central = path.join(home, 'central-repo', 'linked');
  await writeSkill(central, 'linked-skill', '中央仓库里的技能');
  await fs.mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
  const linkPath = path.join(home, '.agents', 'skills', 'linked');
  if (!await linkDirectory(central, linkPath)) {
    t.skip('本机无法创建目录链接');
    return;
  }

  const result = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });

  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'linked-skill');
  // 目标在扫描根之外 —— 隔离的正常形态，跟随但必须留痕
  assert.equal(result.links.outsideRoot.length, 1);
  assert.equal(result.links.followed.length, 0);
  assert.equal(result.followLinks, true);
  assert.equal(
    await fs.realpath(result.links.outsideRoot[0].target),
    await fs.realpath(central)
  );
});

test('根内链接记 followed 而不是 outsideRoot', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = path.join(home, '.agents', 'skills-real', 'inner');
  await writeSkill(target, 'inner', '根内的技能');
  await fs.mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
  // 以整个 .agents 为扫描根，target 就落在根内
  const root = { ...AGENTS_ROOT, segments: ['.agents'] };
  if (!await linkDirectory(target, path.join(home, '.agents', 'inner-link'))) {
    t.skip('本机无法创建目录链接');
    return;
  }

  const result = await scanner.scanRoots({ homeDirectory: home, roots: [root] });

  assert.equal(result.links.followed.length, 1);
  assert.equal(result.links.outsideRoot.length, 0);

  // 这里会同时从两个逻辑路径发现同一个目录：
  //   .agents/inner-link（链接）与 .agents/skills-real/inner（真实路径）
  // 两者逻辑路径不同 —— 按约束 3，它们必须得到同一个版本哈希。
  assert.equal(result.skills.length, 2);
  assert.equal(new Set(result.skills.map((s) => s.versionHash)).size, 1);
  // 按物理目录去重后应只剩一个实例
  assert.equal(scanner.dedupeByDirectory(result.skills).length, 1);
});

test('followLinks=false 时链接记 notFollowed，而不是静默消失', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const central = path.join(home, 'central', 'linked');
  await writeSkill(central, 'linked-skill', '不应被扫到');
  await fs.mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
  if (!await linkDirectory(central, path.join(home, '.agents', 'skills', 'linked'))) {
    t.skip('本机无法创建目录链接');
    return;
  }

  const result = await scanner.scanRoots({
    homeDirectory: home, roots: [AGENTS_ROOT], followLinks: false
  });

  assert.equal(result.skills.length, 0);
  assert.equal(result.links.notFollowed.length, 1);
  assert.equal(result.followLinks, false);
});

test('失效链接与链接成环都不终止扫描（§11.1）', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const skillsRoot = path.join(home, '.agents', 'skills');
  await writeSkill(path.join(skillsRoot, 'healthy'), 'healthy', '正常技能');
  // 失效：指向不存在的目标
  const brokenOk = await linkDirectory(path.join(home, 'nowhere'), path.join(skillsRoot, 'dangling'));
  // 成环：目录链接指回扫描根本身
  const cycleOk = await linkDirectory(skillsRoot, path.join(skillsRoot, 'loop'));
  if (!brokenOk && !cycleOk) {
    t.skip('本机无法创建目录链接');
    return;
  }

  const result = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });

  // 扫描必须完成，健康技能仍被发现
  assert.equal(result.skills.some((s) => s.name === 'healthy'), true);
  if (brokenOk) assert.equal(result.links.broken.length >= 1, true);
  if (cycleOk) assert.equal(result.links.cycle.length >= 1, true);
  // 成环的链接不能被记成 followed（否则"跟随数"会虚高）
  assert.equal(result.links.followed.length, 0);
});

test('同一个链接只记一次（§11.1 约束 4）', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const central = path.join(home, 'central', 'once');
  await writeSkill(central, 'once', '只应记一次');
  const skillsRoot = path.join(home, '.agents', 'skills');
  const linkPath = path.join(skillsRoot, 'once');
  await fs.mkdir(skillsRoot, { recursive: true });
  if (!await linkDirectory(central, linkPath)) {
    t.skip('本机无法创建目录链接');
    return;
  }

  const result = await scanner.scanRoots({
    homeDirectory: home, roots: [AGENTS_ROOT], includeFiles: true
  });

  const occurrences = [
    ...result.links.followed, ...result.links.outsideRoot
  ].filter((item) => path.resolve(item.linkPath) === path.resolve(linkPath));
  assert.equal(occurrences.length, 1, '入口遍历与文件收集都会碰到这个链接，但只应有一份记录');
  assert.equal(result.skills.length, 1);
});

test('版本哈希用逻辑路径：同一内容从不同链接位置被发现得到同一哈希（§11.1 约束 3）', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const central = path.join(home, 'central', 'shared-skill');
  await writeSkill(central, 'shared-skill', '同一份内容');

  const rootA = path.join(home, 'rootA');
  const rootB = path.join(home, 'rootB', 'nested');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  if (!await linkDirectory(central, path.join(rootA, 'via-a'))) {
    t.skip('本机无法创建目录链接');
    return;
  }
  if (!await linkDirectory(central, path.join(rootB, 'via-b'))) {
    t.skip('本机无法创建目录链接');
    return;
  }

  const roots = [
    { id: 'a', platform: 'shared', scope: 'user', label: 'A', absolutePath: rootA },
    { id: 'b', platform: 'shared', scope: 'user', label: 'B', absolutePath: rootB }
  ];
  const result = await scanner.scanRoots({ homeDirectory: home, roots });

  assert.equal(result.skills.length, 2);
  // 逻辑路径下的相对路径都是 SKILL.md，所以哈希必须一致
  assert.equal(result.skills[0].versionHash, result.skills[1].versionHash);
});

test('同名 Skill 不合并，只按物理目录去重（§6）', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeSkill(path.join(home, '.agents', 'skills', 'same-one'), 'duplicate-name', '第一个');
  await writeSkill(path.join(home, '.agents', 'skills', 'same-two'), 'duplicate-name', '第二个');

  const result = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });

  assert.equal(result.skills.length, 2, 'Codex 不合并同名 Skill，两个都要留在结果里');
  assert.equal(new Set(result.skills.map((s) => s.name)).size, 1);
  assert.equal(scanner.dedupeByDirectory(result.skills).length, 2);
});

test('.unify-backup 备份目录不当作 Skill 扫描', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeSkill(path.join(home, '.agents', 'skills', 'alpha'), 'alpha', '正本');
  // 模拟 unify 执行后的备份副本（removed-duplicates / central-conflict）
  await writeSkill(path.join(home, '.agents', 'skills', '.unify-backup', '2026-09-20', 'removed-duplicates', 'alpha'), 'alpha', '备份副本');

  const result = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });

  assert.equal(result.skills.length, 1, '备份目录里的副本不应被扫成 Skill');
  assert.equal(result.skills[0].name, 'alpha');
});

test('dedupeByDirectory 去掉同一物理目录的重复实例', () => {
  const skills = [
    // 同一个目录的两个逻辑路径（一个是链接、一个是真实路径）
    { name: 'a', directoryPath: 'C:\\x\\link', realDirectoryPath: 'C:\\real\\a' },
    { name: 'a', directoryPath: 'C:\\real\\a', realDirectoryPath: 'C:\\real\\a' },
    { name: 'b', directoryPath: 'C:\\x\\b', realDirectoryPath: 'C:\\x\\b' }
  ];
  assert.equal(scanner.dedupeByDirectory(skills).length, 2);
  // 没有 realDirectoryPath 时退回逻辑路径，大小写不敏感地合并
  assert.equal(scanner.dedupeByDirectory([
    { name: 'a', directoryPath: 'C:\\x\\a' },
    { name: 'a', directoryPath: 'C:\\X\\A' }
  ]).length, 1);
});

test('includeFiles 默认关闭：扫描结果不携带文件内容', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeSkill(path.join(home, '.agents', 'skills', 'lean'), 'lean', '不外传内容');

  const result = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });

  assert.equal(result.skills[0].files, undefined, '默认不返回文件内容，扫描结果只留内存');
  assert.equal(result.skills[0].fileCount, 1);
});

test('缺失的扫描根报 missing，不影响其他根（§7 最小授权：不臆造 home 级扫描）', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeSkill(path.join(home, '.agents', 'skills', 'only'), 'only', '唯一');

  const result = await scanner.scanRoots({ homeDirectory: home, roots: scanner.DEFAULT_ROOTS });

  const agents = result.roots.find((root) => root.id === 'shared-agents');
  const workbuddy = result.roots.find((root) => root.id === 'workbuddy-user');
  assert.equal(agents.status, 'ready');
  assert.equal(workbuddy.status, 'missing');
  assert.equal(workbuddy.skillCount, 0);
});

test('base: localAppData 的根解析到 %LOCALAPPDATA%，而非用户主目录', () => {
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = 'C:\\FakeLocalAppData';
  try {
    const roots = scanner.resolveRoots('C:\\Users\\tester', [
      { id: 'doubao-user', platform: 'doubao', base: 'localAppData', segments: ['Doubao', 'skills'] },
      { id: 'codex-user', platform: 'codex', segments: ['.codex', 'skills'] }
    ]);
    // 用 path.join 拼期望值：CI 跑在 Ubuntu，path.join 产出 '/'，
    // 断言只关心「基准取 LOCALAPPDATA 而非主目录」，不关心分隔符。
    assert.equal(roots[0].absolutePath, path.join('C:\\FakeLocalAppData', 'Doubao', 'skills'));
    assert.equal(roots[1].absolutePath, path.join('C:\\Users\\tester', '.codex', 'skills'));
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  }
});

test('扫描器是纯函数式的：两次扫描结果一致且不写磁盘', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-packer-core-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await writeSkill(path.join(home, '.agents', 'skills', 'stable'), 'stable', '稳定');

  const first = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });
  const second = await scanner.scanRoots({ homeDirectory: home, roots: [AGENTS_ROOT] });

  assert.equal(first.skills[0].versionHash, second.skills[0].versionHash);
  assert.deepEqual(scanner.summarizeLinks(first.links), scanner.summarizeLinks(second.links));
  // 目录里不应出现扫描器自己写的任何东西
  const entries = await fs.readdir(path.join(home, '.agents', 'skills'));
  assert.deepEqual(entries, ['stable']);
});
