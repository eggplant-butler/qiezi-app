// patch-week.js — 本周修 6 项
// 用法: node patch-week.js  (项目根目录，幂等)
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

console.log('=== 本周修 6 项 开始 ===\n');

// ===== 1. cognitive-counts: entropy → entropy_logs =====
patch('server.js',
  "try { out.entropyScore = readData('entropy').slice(-1)[0]?.entropyScore || 0; } catch(e) { out.entropyScore = 0; }",
  "try { out.entropyScore = readData('entropy_logs').slice(-1)[0]?.entropyScore || 0; } catch(e) { out.entropyScore = 0; }",
  'cognitive-counts: entropy → entropy_logs',
  "readData('entropy_logs').slice");

// ===== 2. cognitive-counts: antifragile → antifragile_logs（含 score 字段修正）=====
// 原代码读 readData('antifragile') 且用 x.score，实际数据在 antifragile_logs，且字段是 financial/skill/.../mental（需算均分）
patch('server.js',
  "      const af = readData('antifragile');\n      if (af.length) {\n        const s = af.reduce((a,x)=>a+(parseFloat(x&&x.score)||0),0)/af.length;\n        out.antifragileAvg = s;",
  "      const af = readData('antifragile_logs');\n      if (af.length) {\n        const s = af.reduce((a,x)=>{ const dims=['financial','skill','social','health','mental']; const sum=dims.reduce((s,k)=>s+(parseFloat(x&&x[k])||0),0); return a+(sum/dims.length); },0)/af.length;\n        out.antifragileAvg = s;",
  'cognitive-counts: antifragile → antifragile_logs + 均分计算',
  "readData('antifragile_logs')");

// ===== 3. 独立 GET /api/antifragile 无参调用修复 =====
patch('server.js',
  "app.get('/api/antifragile', (req, res) => {\n  res.json(ENG.antifragile());\n});",
  "app.get('/api/antifragile', (req, res) => {\n  // v6.9.25 修复：取最新评估记录传入，无记录返回 null\n  const logs = readData('antifragile_logs');\n  const latest = logs.length ? logs.sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1))[0] : null;\n  res.json(latest ? ENG.antifragile(latest) : null);\n});",
  'GET /api/antifragile: 无参 → 取最新评估',
  'latest ? ENG.antifragile(latest)');

// ===== 4. dashboard 补 weeklyReview + dataCompare（与 insights-plus 对齐）=====
patch('server.js',
  "    try { result.sections.valuesClarification = ENG.valuesClarification(hist); } catch (e) { result.sections.valuesClarification = null; }\n  } catch (e) {",
  "    try { result.sections.valuesClarification = ENG.valuesClarification(hist); } catch (e) { result.sections.valuesClarification = null; }\n    // v6.9.25 补：与 insights-plus 对齐，避免刷新后卡片消失\n    try { result.sections.weeklyReview = ENG.weeklyReview(hist); } catch (e) { result.sections.weeklyReview = null; }\n    try { result.sections.dataCompare = ENG.dataCompare(hist); } catch (e) { result.sections.dataCompare = null; }\n  } catch (e) {",
  'dashboard: 补 weeklyReview + dataCompare',
  'result.sections.weeklyReview');

// ===== 5. authHeaders 定义（前端 app.js 追加）=====
const authHeadersFn = `
// v6.9.25 修复：authHeaders 定义（运维面板用）
function authHeaders(){
  var h = { 'Content-Type': 'application/json' };
  try { var t = localStorage.getItem('qzos_token'); if (t) h['Authorization'] = 'Bearer ' + t; } catch(e) {}
  return h;
}`;

(function(){
  if (!fs.existsSync('frontend/app.js')) { console.log('  SKIP(no file): frontend/app.js'); skipped++; return; }
  let c = fs.readFileSync('frontend/app.js', 'utf8');
  if (c.includes('function authHeaders()')) { console.log('  SKIP(already): authHeaders 定义'); skipped++; return; }
  c = c + '\n' + authHeadersFn;
  fs.writeFileSync('frontend/app.js', c, 'utf8');
  console.log('  OK: 追加 authHeaders 定义');
  changed++;
})();

// ===== 6. login 双监听器：移除内联 keydown（保留 app.js 的）=====
// index.html 内联第 387 行的 _pi.addEventListener('keydown'...) 会和 app.js:405 重复触发
// 修复：把内联的 keydown 监听器去掉（_inlineLogin 已通过 _b.onclick 绑定按钮，Enter 由 app.js 处理）
patch('frontend/index.html',
  "  if(_pi){_pi.addEventListener('keydown',function(e){if(e.key==='Enter')_inlineLogin();});}",
  "  // v6.9.25 移除：避免与 app.js 的 keydown 监听器重复触发 login（Enter 会请求两次）\n  // _inlineLogin 已通过 _b.onclick 绑定按钮，Enter 交给 app.js:405 的 login() 处理",
  'login: 移除内联 keydown 双监听器',
  '避免与 app.js 的 keydown 监听器重复触发');

console.log('\n=== 修复完成: ' + changed + ' changed, ' + skipped + ' skipped ===');
console.log('\n校验: node -c server.js && node -c frontend/app.js');
console.log('重启: pm2 restart eggplant');
