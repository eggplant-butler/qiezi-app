// FIX8: 追加智慧透镜三函数到 app.js 末尾
const fs = require('fs');
const path = require('path');

// 三个函数的源代码（直接定义，不依赖转义）
const BLOCK = `// ============================================================
// 内容扩展：五重透镜 + 复利审计 + 危机框架
// 让用户面对任何事件，都能从哲学/鬼谷子/心理学/经济学/复利多维度审视
// ============================================================
var WISDOM_LENS_LIST = [
  { key: "philosophy",  icon: "🏛️", name: "哲学",   desc: "斯多葛·存在主义·东方无常" },
  { key: "guiguzi",     icon: "♟️", name: "鬼谷子", desc: "捭阖·反应·内揵·抵巇" },
  { key: "psychology",  icon: "🧠", name: "心理学", desc: "认知偏差·防御机制·归因" },
  { key: "economics",   icon: "💰", name: "经济学", desc: "机会成本·沉没成本·边际·激励" }
];

function openWisdomLens(){
  var html = '';
  html += '<div style="background:var(--c-accent,#EEF2FF);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">把同一件事，从不同维度看一遍。每个透镜会给你一个不一样的解法。留空内容则自动取最近一条记录。</div>';
  html += '<textarea id="wisdomContent" placeholder="写下你想审视的事（可选）..." style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--c-input-border,#F5F7FA);background:var(--c-surface);color:var(--c-fg);font-size:14px;font-family:inherit;min-height:70px;resize:vertical;box-sizing:border-box"></textarea>';
  html += '<div style="font-size:11px;color:var(--c-fg-3);margin:10px 0 6px">选择一个透镜：</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
  WISDOM_LENS_LIST.forEach(function(l){
    html += '<button onclick="runWisdomLens(\''+l.key+'\',\''+l.name+'\')" style="background:var(--c-surface);border:1px solid var(--c-input-border,#F5F7FA);border-radius:10px;padding:12px 10px;cursor:pointer;text-align:left">';
    html += '<div style="font-size:18px">'+l.icon+'</div><div style="font-size:13px;font-weight:600;color:var(--c-fg);margin-top:4px">'+l.name+'</div><div style="font-size:10px;color:var(--c-fg-3);margin-top:2px;line-height:1.4">'+l.desc+'</div>';
    html += '</button>';
  });
  html += '</div><div id="wisdomResult" style="margin-top:12px"></div>';
  openModal2('🔮 五重透镜', html);
}

async function runWisdomLens(lens, lensName){
  var el = document.getElementById('wisdomResult');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;color:var(--c-fg-3);padding:20px">'+lensName+'审视中...</div>';
  try {
    var content = (document.getElementById('wisdomContent') || {}).value || '';
    var body = { lens: lens };
    if (content.trim()) body.content = content.trim();
    var r = await fetch('/api/eng/wisdom-lens', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    var d = await r.json();
    if (d.success && d.reflection) {
      el.innerHTML = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;border-left:3px solid var(--c-primary)"><div style="font-size:13px;color:var(--c-fg);line-height:1.75;white-space:pre-wrap">'+escapeHtml(d.reflection)+'</div></div>';
    } else {
      el.innerHTML = '<div style="color:#EF4444;padding:14px;text-align:center;font-size:13px">'+(d.message||'分析失败')+'</div>';
    }
  } catch(e) {
    el.innerHTML = '<div style="color:#EF4444;padding:14px;text-align:center;font-size:13px">网络错误：'+e.message+'</div>';
  }
}

async function openCompoundingAudit(){
  openModal2('📈 复利审计', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">审计中...</div>');
  try {
    var r = await fetch('/api/eng/compounding', { headers: authHeaders() });
    var d = await r.json();
    if (d.success && d.reflection) {
      var html = '<div style="background:var(--c-accent,#EEF2FF);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563">基于 '+d.sampleSize+' 条记录 · 每天1%差异，10年后是11900倍鸿沟。</div>';
      html += '<div style="background:var(--c-surface);border-radius:12px;padding:14px;border-left:3px solid var(--c-primary)"><div style="font-size:13px;color:var(--c-fg);line-height:1.75;white-space:pre-wrap">'+escapeHtml(d.reflection)+'</div></div>';
      openModal2('📈 复利审计', html);
    } else {
      openModal2('📈 复利审计', '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px">'+(d.message||'数据不足')+'</div>');
    }
  } catch(e) {
    openModal2('📈 复利审计', '<div style="color:#EF4444;padding:20px;text-align:center">加载失败：'+e.message+'</div>');
  }
}

function openCrisisFramework(){
  var html = '<div style="background:#FEF3C7;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#92400E;line-height:1.6">遇到危机时，用这个框架一步步走——止血、区分、借力、意义、底线。</div>';
  html += '<textarea id="crisisContent" placeholder="简要描述你遇到的事（可选）..." style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--c-input-border,#F5F7FA);background:var(--c-surface);color:var(--c-fg);font-size:14px;font-family:inherit;min-height:80px;resize:vertical;box-sizing:border-box"></textarea>';
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

const APP_PATH = path.join(__dirname, 'frontend', 'app.js');
const s = fs.readFileSync(APP_PATH, 'utf8');
if (s.includes('function openWisdomLens')) {
  console.log('SKIP 函数已存在');
  process.exit(0);
}
fs.appendFileSync(APP_PATH, '\n\n' + BLOCK + '\n');
console.log('OK 智慧透镜三函数已追加到 app.js, 长度=' + BLOCK.length);
