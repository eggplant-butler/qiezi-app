// patch-bugfix.js — 修复 Bug 1-4
// 用法: node patch-bugfix.js  (在项目根目录运行，幂等可重复执行)
const fs = require('fs');
let changed = 0, skipped = 0;

function patch(file, oldStr, newStr, label, checkStr) {
  if (!fs.existsSync(file)) { console.log('  SKIP(no file):', file); skipped++; return; }
  let c = fs.readFileSync(file, 'utf8');
  var marker = checkStr || newStr.substring(newStr.length - 30);
  if (c.includes(marker)) { console.log('  SKIP(already):', label); skipped++; return; }
  if (!c.includes(oldStr)) { console.log('  SKIP(no anchor):', label); skipped++; return; }
  c = c.replace(oldStr, newStr);
  fs.writeFileSync(file, c, 'utf8');
  console.log('  OK:', label);
  changed++;
}

console.log('=== Bug 1-4 修复开始 ===\n');

// ---------- Bug 1: 闪念归类反馈取错字段 (frontend/app.js) ----------
// API 返回 d2.suggested，前端误读 d2.module → 归类名永远显示"闪念"
patch('frontend/app.js',
  "(d2.module || '闪念') + '</b>'",
  "(d2.suggested || '闪念') + '</b>'",
  'Bug1: d2.module -> d2.suggested',
  'd2.suggested');

// ---------- Bug 2: filterScenes 三元两分支相同 (frontend/app.js) ----------
// hits.length > 0 ? 'block' : 'block' 无意义，简化
patch('frontend/app.js',
  "sr.style.display = hits.length > 0 ? 'block' : 'block';",
  "sr.style.display = 'block';",
  'Bug2: filterScenes 三元简化',
  "sr.style.display = 'block';");

// ---------- Bug 3: isQuickNote 条件重复 (frontend/app.js) ----------
// !hasQuestion 出现两次
patch('frontend/app.js',
  'var isQuickNote = !hasQuestion || ans.length < 5 || !hasQuestion;',
  'var isQuickNote = !hasQuestion || ans.length < 5;',
  'Bug3: isQuickNote 去重',
  '|| ans.length < 5;');

// ---------- Bug 4: dashboard antifragile 永远为 null (server.js) ----------
// ENG.antifragile(item) 需要 0-10 评分的 item；原代码未传参 → return null
// 正确修复: 取 antifragile_logs 最新一次评估记录传入；无记录则 null
patch('server.js',
  "    try { result.sections.antifragile = ENG.antifragile(); } catch (e) { result.sections.antifragile = null; }",
  "    try {\n      const _afLogs = readData('antifragile_logs');\n      const _latestAf = _afLogs.length ? _afLogs.sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1))[0] : null;\n      result.sections.antifragile = _latestAf ? ENG.antifragile(_latestAf) : null;\n    } catch (e) { result.sections.antifragile = null; }",
  'Bug4: dashboard antifragile 取最新评估',
  '_latestAf ? ENG.antifragile');

console.log('\n=== 修复完成: ' + changed + ' changed, ' + skipped + ' skipped ===');
console.log('\n下一步:');
console.log('  1. 本地校验: node -c server.js && node -c frontend/app.js  (语法检查)');
console.log('  2. 重启服务: pm2 restart qiezi-app');
console.log('  3. 验证: curl -s http://localhost:3000/api/eng/dashboard -H "Authorization: Bearer <token>" | head -c 300');
