/* eslint-disable */
// ============================================================
// 内容扩展1·前端：智慧透镜 UI（五重透镜 + 复利审计 + 危机框架）
// 用法：cd /home/ubuntu/qiezi-app && node patch-frontend-wisdom.js
//       pm2 restart eggplant
// 作用：在瞭望Tab新增"🧭 智慧透镜"入口，调用后端 /api/eng/wisdom-lens 和 /api/eng/compounding
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, 'frontend', 'app.js');
const HTML = path.join(__dirname, 'frontend', 'index.html');

if (!fs.existsSync(APP)) { console.error('❌ 找不到 frontend/app.js'); process.exit(1); }
if (!fs.existsSync(HTML)) { console.error('❌ 找不到 frontend/index.html'); process.exit(1); }

let changes = 0;

// ---------- 1. app.js 末尾追加 3 个函数 ----------
let appSrc = fs.readFileSync(APP, 'utf8');

const APP_MARKER = "// v6.9.25 修复：authHeaders 定义（运维面板用）\nfunction authHeaders(){";
if (appSrc.indexOf('function openWisdomLens(') !== -1) {
  console.log('ℹ️  app.js 已包含 openWisdomLens，跳过');
} else {
  // 在 authHeaders 函数前插入新代码块
  const APP_BLOCK = `// ============================================================
// 内容扩展：五重透镜 + 复利审计 + 危机框架
// 让用户面对任何事件，都能从哲学/鬼谷子/心理学/经济学/复利多维度审视
// ============================================================
var WISDOM_LENS_LIST = [
  { key: 'philosophy',  icon: '🏛️', name: '哲学',   desc: '斯多葛·存在主义·东方无常' },
  { key: 'guiguzi',     icon: '♟️', name: '鬼谷子', desc: '捭阖·反应·内揵·抵巇' },
  { key: 'psychology',  icon: '🧠', name: '心理学', desc: '认知偏差·防御机制·归因' },
  { key: 'economics',   icon: '💰', name: '经济学', desc: '机会成本·沉没成本·边际·激励' }
];

function openWisdomLens(){
  var html = '';
  html += '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">把同一件事，从不同维度看一遍。每个透镜会给你一个不一样的解法。留空内容则自动取最近一条思考/日记记录。</div>';
  html += '<textarea id="wisdomContent" placeholder="写下你想审视的事（可选，留空自动取最近记录）..." style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--c-input-border,#F5F7FA);background:var(--c-surface);color:var(--c-fg);font-size:14px;font-family:inherit;min-height:70px;resize:vertical;box-sizing:border-box"></textarea>';
  html += '<div style="font-size:11px;color:var(--c-fg-3);margin:10px 0 6px">选择一个透镜开始审视：</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
  WISDOM_LENS_LIST.forEach(function(l){
    html += '<button onclick="runWisdomLens(\\''+l.key+'\\',\\''+l.name+'\\')" style="background:var(--c-surface);border:1px solid var(--c-input-border,#F5F7FA);border-radius:10px;padding:12px 10px;cursor:pointer;text-align:left">';
    html += '<div style="font-size:18px">'+l.icon+'</div>';
    html += '<div style="font-size:13px;font-weight:600;color:var(--c-fg);margin-top:4px">'+l.name+'</div>';
    html += '<div style="font-size:10px;color:var(--c-fg-3);margin-top:2px;line-height:1.4">'+l.desc+'</div>';
    html += '</button>';
  });
  html += '</div>';
  html += '<div id="wisdomResult" style="margin-top:12px"></div>';
  openModal2('🔮 五重透镜', html);
}

async function runWisdomLens(lens, lensName){
  var el = document.getElementById('wisdomResult');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;color:var(--c-fg-3);padding:20px">'+lensName+'透镜审视中...</div>';
  try {
    var content = (document.getElementById('wisdomContent') || {}).value || '';
    var body = { lens: lens };
    if (content.trim()) body.content = content.trim();
    var r = await fetch('/api/eng/wisdom-lens', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    var d = await r.json();
    if (d.success && d.reflection) {
      el.innerHTML = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;border-left:3px solid var(--c-primary)"><div style="font-size:12px;font-weight:600;color:var(--c-primary);margin-bottom:8px">'+lensName+'透镜</div><div style="font-size:13px;color:var(--c-fg);line-height:1.75;white-space:pre-wrap">'+escapeHtml(d.reflection)+'</div></div>';
    } else {
      el.innerHTML = '<div style="color:#EF4444;padding:14px;text-align:center;font-size:13px">'+(d.message || '分析失败')+'</div>';
    }
  } catch(e) {
    el.innerHTML = '<div style="color:#EF4444;padding:14px;text-align:center;font-size:13px">网络错误：'+e.message+'</div>';
  }
}

async function openCompoundingAudit(){
  openModal2('📈 复利审计', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">审计正/负复利中...</div>');
  try {
    var r = await fetch('/api/eng/compounding');
    var d = await r.json();
    if (d.success && d.reflection) {
      var html = '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">基于 '+d.sampleSize+' 条记录 · 每天1%的差异，10年后是11900倍的鸿沟。</div>';
      html += '<div style="background:var(--c-surface);border-radius:12px;padding:14px;border-left:3px solid var(--c-primary)"><div style="font-size:13px;color:var(--c-fg);line-height:1.75;white-space:pre-wrap">'+escapeHtml(d.reflection)+'</div></div>';
      openModal2('📈 复利审计', html);
    } else {
      openModal2('📈 复利审计', '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px">'+(d.message || '数据不足，请持续记录')+'</div>');
    }
  } catch(e) {
    openModal2('📈 复利审计', '<div style="color:#EF4444;padding:20px;text-align:center">加载失败：'+e.message+'</div>');
  }
}

function openCrisisFramework(){
  var html = '';
  html += '<div style="background:#FEF3C7;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#92400E;line-height:1.6">遇到突发事件、危机、或难以处理的问题时，用这个框架一步步走——止血、区分、借力、意义、底线。</div>';
  html += '<textarea id="crisisContent" placeholder="简要描述你遇到的事（可选，留空则审视当前整体状态）..." style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--c-input-border,#F5F7FA);background:var(--c-surface);color:var(--c-fg);font-size:14px;font-family:inherit;min-height:80px;resize:vertical;box-sizing:border-box"></textarea>';
  html += '<button onclick="runCrisisFramework()" style="width:100%;margin-top:10px;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,#EF4444,#F87171);color:#fff;font-weight:600;cursor:pointer">🛟 开始危机应对分析</button>';
  html += '<div id="crisisResult" style="margin-top:12px"></div>';
  openModal2('🛟 危机应对框架', html);
}

async function runCrisisFramework(){
  var el = document.getElementById('crisisResult');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;color:var(--c-fg-3);padding:20px">分析中...</div>';
  try {
    var content = (document.getElementById('crisisContent') || {}).value || '';
    var body = { lens: 'crisisFramework' };
    if (content.trim()) body.content = content.trim();
    var r = await fetch('/api/eng/wisdom-lens', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    var d = await r.json();
    if (d.success && d.reflection) {
      el.innerHTML = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;border-left:3px solid #EF4444"><div style="font-size:12px;font-weight:600;color:#EF4444;margin-bottom:8px">危机应对五步</div><div style="font-size:13px;color:var(--c-fg);line-height:1.75;white-space:pre-wrap">'+escapeHtml(d.reflection)+'</div></div>';
    } else {
      el.innerHTML = '<div style="color:#EF4444;padding:14px;text-align:center;font-size:13px">'+(d.message || '分析失败')+'</div>';
    }
  } catch(e) {
    el.innerHTML = '<div style="color:#EF4444;padding:14px;text-align:center;font-size:13px">网络错误：'+e.message+'</div>';
  }
}

`;
  appSrc = appSrc.replace(APP_MARKER, APP_BLOCK + APP_MARKER);
  fs.writeFileSync(APP, appSrc);
  changes++;
  console.log('✅ app.js 已追加智慧透镜函数');
}

// ---------- 2. index.html 瞭望Tab 新增入口 ----------
let htmlSrc = fs.readFileSync(HTML, 'utf8');

const HTML_ANCHOR = `<div class="tool-item" onclick="openPlan()">
<div class="t-ic">📋</div><div class="t-nm">周月计划</div><div class="t-cnt" id="planCnt">0</div>
</div>
</div>
</div>

</div>`;

const HTML_NEW = `<div class="tool-item" onclick="openPlan()">
<div class="t-ic">📋</div><div class="t-nm">周月计划</div><div class="t-cnt" id="planCnt">0</div>
</div>
</div>
</div>

<div class="tool-section">
<div class="ts-title">🧭 智慧透镜 <span class="ts-sub">哲学·鬼谷子·心理·经济·复利·危机</span></div>
<div class="tool-grid">
<div class="tool-item primary" onclick="openWisdomLens()"><div class="t-ic">🔮</div><div class="t-nm">五重透镜</div><div class="t-cnt">新</div></div>
<div class="tool-item primary" onclick="openCompoundingAudit()"><div class="t-ic">📈</div><div class="t-nm">复利审计</div><div class="t-cnt">新</div></div>
<div class="tool-item" onclick="openCrisisFramework()"><div class="t-ic">🛟</div><div class="t-nm">危机框架</div><div class="t-cnt">新</div></div>
</div>
</div>

</div>`;

if (htmlSrc.indexOf('openWisdomLens()') !== -1) {
  console.log('ℹ️  index.html 已包含智慧透镜入口，跳过');
} else if (htmlSrc.indexOf(HTML_ANCHOR) === -1) {
  console.warn('⚠️  index.html 未匹配到锚点（openPlan 区块），请手动添加智慧透镜入口');
} else {
  htmlSrc = htmlSrc.replace(HTML_ANCHOR, HTML_NEW);
  fs.writeFileSync(HTML, htmlSrc);
  changes++;
  console.log('✅ index.html 已新增智慧透镜入口');
}

if (changes === 0) {
  console.log('ℹ️  无变更');
} else {
  console.log('\n📋 后续：pm2 restart eggplant，然后在瞭望Tab底部可见"🧭 智慧透镜"');
}
