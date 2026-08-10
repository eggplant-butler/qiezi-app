// patch-today2.js — Bug 1 另一半 + DOM 累积 + CORS
// 用法: node patch-today2.js  (项目根目录，幂等)
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

console.log('=== Bug1另一半 + DOM累积 + CORS 修复 ===\n');

// ===== Bug 1 另一半：d2.suggested → d2.suggestedName（显示中文名）=====
patch('frontend/app.js',
  "(d2.suggested || '闪念') + '</b>'",
  "(d2.suggestedName || d2.suggested || '闪念') + '</b>'",
  'Bug1: d2.suggested -> d2.suggestedName',
  'd2.suggestedName || d2.suggested');

// ===== DOM 累积：补 favEl.id = 'recFavorites' =====
// 锚点：第 3820-3821 行之间，favEl.className 赋值后插入 id
patch('frontend/app.js',
  "      favEl = document.createElement('div');\n      favEl.className = 'rec-group';\n      favEl.innerHTML = '<div class=\"rg-title\">⭐ 常用场景",
  "      favEl = document.createElement('div');\n      favEl.id = 'recFavorites';\n      favEl.className = 'rec-group';\n      favEl.innerHTML = '<div class=\"rg-title\">⭐ 常用场景",
  'DOM累积: 补 favEl.id',
  "favEl.id = 'recFavorites'");

// ===== CORS 全开修复：白名单外不再无条件放行 =====
// 原代码（457-459行）:
//   if (!origin || allowed.some(r => r.test(origin))) return cb(null, true);
//   // 不在白名单但非浏览器请求（origin 缺失或自定义UA）→ 放行
//   cb(null, true);
// 修复后：白名单内或无 origin 放行；有 origin 但不在白名单 → 拒绝
patch('server.js',
  "    if (!origin || allowed.some(r => r.test(origin))) return cb(null, true);\n    // 不在白名单但非浏览器请求（origin 缺失或自定义UA）→ 放行，nginx/防火墙兜底\n    cb(null, true);",
  "    if (!origin || allowed.some(r => r.test(origin))) return cb(null, true);\n    // v6.9.25 修复 CORS 全开：有 origin 但不在白名单 → 拒绝（防止恶意站点跨域带凭据请求）\n    return cb(new Error('Origin ' + origin + ' not allowed by CORS'));",
  'CORS: 白名单外拒绝',
  'not allowed by CORS');

console.log('\n=== 修复完成: ' + changed + ' changed, ' + skipped + ' skipped ===');
console.log('\n校验: node -c server.js && node -c frontend/app.js');
console.log('重启: pm2 restart eggplant');
console.log('\n验证 CORS: curl -s -o /dev/null -w "%{http_code}" -H "Origin: https://evil.com" http://localhost:3000/api/health');
console.log('  期望 500（被拒）；无 Origin 时仍 200');
