'use strict';

/**
 * 数据库 schema 初始化的**韧性契约测试**。
 *
 * 这组测试存在的唯一目的：防止 schema 初始化再退回「整批提交 + 单点故障」的形态。
 *
 * 背景（2026-09-18 实测）：某次提交给 schema 批次加了一条
 * `ALTER TABLE skills ADD COLUMN IF NOT EXISTS zh_summary ...`，部署随即失败三次。
 * 原因是初始化写成 `const initialized = pool.query(schemaSql)`（13 条语句一次提交），
 * 15 个仓储方法各自 `await initialized`。于是：
 *   - 任何一条语句报错或抢不到 ACCESS EXCLUSIVE 锁 → 整个批次失败或挂起
 *   - `initialized` reject / pending → **所有接口一起失效，包括 /api/health**
 *   - 部署后的健康检查因此重试 15 次耗尽（约 30 秒）→ 触发回滚
 * 表面症状是「部署失败」，真实原因是启动期数据库初始化没有降级路径。
 *
 * 修复后必须保持的三条性质：
 *   1. 语句逐条执行（单条失败不影响其余，且能定位到具体语句）
 *   2. 每条查询都带超时（抢不到锁时不能无限挂起）
 *   3. 所有仓储查询统一过 ready() 门卫（迁移未就绪时给出 503 与原因，而不是无限等待）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'cloud-api.js'),
  'utf8'
);

test('schema 语句逐条执行，而不是整批一次提交', () => {
  // 曾经的坏形态：pool.query(schemaSql) —— 15 条语句一起提交
  assert.doesNotMatch(
    SOURCE,
    /pool\.query\(\s*schemaSql\s*\)/,
    'schema 不能整批一次提交：一条失败会拖垮所有语句，且无法定位是哪条'
  );
  // 现在的形态：遍历切分好的语句数组逐条查询
  assert.match(
    SOURCE,
    /for \(const statement of schemaStatements\)/,
    '应按语句逐条执行 schema，便于单条失败时继续跑完并定位'
  );
});

test('SQL 语句按分号边界切分，而不是按数组元素', () => {
  // 这条是本组测试里最重要的一条。
  // 踩过的坑：schemaSql 的元素是**行片段**（一条 CREATE TABLE 跨多个元素，
  // 每个字段一行），直接逐元素执行会把一条完整语句拆成几十个语法错误片段，
  // 结果是 schema 全废、健康检查 503、部署失败 —— 而且因为 catch 吞了错误，
  // 服务照常启动，表面看只是"部署失败"，极难定位。
  assert.match(
    SOURCE,
    /const schemaStatements = \[\]/,
    '应先把行片段按语句边界组装成完整语句'
  );
  assert.match(
    SOURCE,
    /endsWith\(';'\)/,
    "切分边界必须看行尾分号（endsWith(';')），否则会把一条语句拆散"
  );

  // 端到端验证：用源码里的 schemaSql 跑一遍同样的切分逻辑，断言切出来的是完整语句
  const arraySource = SOURCE.match(/const schemaSql = \[([\s\S]*?)\n  \];/);
  assert.ok(arraySource, '应能取到 schemaSql 定义');

  const lines = (0, eval)('[' + arraySource[1] + ']');
  const statements = [];
  let buffer = [];
  for (const line of lines) {
    buffer.push(line);
    if (line.trimEnd().endsWith(';')) {
      statements.push(buffer.join('\n'));
      buffer = [];
    }
  }
  if (buffer.length) statements.push(buffer.join('\n'));

  // 切出来的每一条都必须是完整语句
  for (const statement of statements) {
    assert.ok(
      statement.trimEnd().endsWith(';'),
      `切分出的语句应以分号收尾：${statement.slice(0, 60)}`
    );
  }
  // 每条 CREATE TABLE 必须自带左括号与其后的字段定义，不能被拆开
  const createTables = statements.filter((s) => /^\s*CREATE TABLE/i.test(s));
  assert.ok(createTables.length > 0, '应切出 CREATE TABLE 语句');
  for (const statement of createTables) {
    assert.match(statement, /\(/, 'CREATE TABLE 语句必须包含左括号');
    assert.match(statement, /\)/, 'CREATE TABLE 语句必须包含右括号');
  }
  // 也不能把多条语句粘成一条（每段最多一个 "CREATE TABLE"）
  for (const statement of statements) {
    const count = (statement.match(/CREATE TABLE/g) || []).length;
    assert.ok(count <= 1, `单条语句里不应出现多个 CREATE TABLE：${statement.slice(0, 60)}`);
  }
});

test('schema 语句带查询超时，避免抢不到锁时无限挂起', () => {
  assert.match(
    SOURCE,
    /query_timeout:\s*\d+/,
    'schema 每条查询必须带 query_timeout：ALTER TABLE 抢不到 ACCESS EXCLUSIVE 锁时会一直等'
  );
  assert.match(
    SOURCE,
    /statement_timeout:\s*\d+/,
    'schema 每条查询必须带 statement_timeout'
  );
});

test('仓储查询统一过 ready() 门卫，而不是直接 await initialized', () => {
  // ready() 内部允许（且必须）await initialized —— 那是门卫的实现
  const readyBody = SOURCE.match(/async function ready\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(readyBody, '应存在 ready() 门卫函数');
  assert.match(readyBody[1], /await initialized/, 'ready() 内部应等待 initialized');

  // 除 ready() 自身外，不应再有裸的 await initialized
  const outsideReady = SOURCE.replace(readyBody[0], '');
  assert.doesNotMatch(
    outsideReady,
    /await initialized;/,
    '仓储方法应 await ready() 而不是裸 await initialized，否则迁移失败时无法返回可诊断错误'
  );
});

test('迁移失败时返回 503 并带出原因，而不是静默挂死', () => {
  // 失败状态可能是直接赋值，也可能是三元表达式赋 'failed'
  assert.match(
    SOURCE,
    /schemaState\s*=[^\n]*'failed'/,
    "应记录 schema 失败状态（schemaState 被赋为 'failed'）"
  );
  assert.match(
    SOURCE,
    /statusCode\s*=\s*503/,
    '结构未就绪时应返回 503，让健康检查能指出原因'
  );
  assert.match(
    SOURCE,
    /数据库结构未就绪/,
    '错误信息应说明是数据库结构问题，便于部署日志定位'
  );
});

test('单条 schema 语句失败不应让整批中止', () => {
  // 失败被吞在 catch 里、继续循环，而不是 throw 出 for 循环
  const loop = SOURCE.match(/for \(const statement of schemaStatements\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(loop, '应存在逐条执行的循环');
  assert.match(loop[1], /catch\s*\(/, '循环内应有 catch 兜住单条失败');
  assert.doesNotMatch(
    loop[1],
    /catch\s*\([^)]*\)\s*\{\s*throw/,
    '单条失败不应直接 throw，否则后面的幂等语句（CREATE TABLE IF NOT EXISTS 等）全都不再执行'
  );
});
