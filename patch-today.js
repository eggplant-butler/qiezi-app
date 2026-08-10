// patch-today.js — 今天必须修：reminders 持久化 + 7个死按钮 + closeDetail
// 用法: node patch-today.js  (项目根目录，幂等可重复)
const fs = require('fs');
let changed = 0, skipped = 0;

function patchAll(file, oldStr, newStr, label) {
  if (!fs.existsSync(file)) { console.log('  SKIP(no file):', file); skipped++; return; }
  let c = fs.readFileSync(file, 'utf8');
  if (!c.includes(oldStr)) { console.log('  SKIP(no anchor):', label); skipped++; return; }
  if (oldStr !== newStr && c.includes(newStr)) { console.log('  SKIP(already):', label); skipped++; return; }
  c = c.split(oldStr).join(newStr);
  fs.writeFileSync(file, c, 'utf8');
  console.log('  OK:', label);
  changed++;
}

console.log('=== 今天必须修 开始 ===\n');

// ========== 1. reminders 持久化：4处 apiFetch(POST) → apiSave ==========
patchAll('frontend/app.js',
  "apiFetch('reminder', { method: 'POST', body: JSON.stringify(reminders) });",
  "apiSave('reminder', reminders);",
  'reminders: apiFetch→apiSave (4处)');

// ========== 2. 追加 7 个死按钮函数 + closeDetail ==========
const deadBtnFns = `
// ===== v6.9.25 修复：7 个死按钮函数 + closeDetail =====
function closeDetail(){
  var d = document.getElementById('detail');
  if(d) d.classList.remove('act');
}

async function openTrajectory(){
  openModal2('📈 轨迹分析', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/eng/trajectory?days=30'); var d = await r.json();
    var trend = d.trend || d.direction || '-';
    var trendText = trend === 'up' ? '↑ 上升' : trend === 'down' ? '↓ 下降' : '→ 平稳';
    var trendColor = trend === 'up' ? 'var(--c-success)' : trend === 'down' ? 'var(--c-danger)' : 'var(--c-fg-3)';
    var html = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;margin-bottom:12px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-size:13px;font-weight:600;color:var(--c-fg);">30天轨迹</span><span style="font-size:14px;font-weight:700;color:'+trendColor+';">'+trendText+'</span></div>';
    html += '<div style="font-size:11px;color:var(--c-fg-3);">样本量 '+d.sampleSize+' 条</div>';
    html += '</div>';
    if (d.summary) html += '<div style="font-size:12px;color:var(--c-fg-2);line-height:1.6;white-space:pre-wrap;margin-bottom:8px;">'+escapeHtml(d.summary)+'</div>';
    if (d.reflection) html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap;">'+escapeHtml(d.reflection)+'</div>';
    if (!d.summary && !d.reflection) html += '<div style="font-size:13px;color:var(--c-fg-3);text-align:center;padding:14px;">数据不足以分析轨迹</div>';
    openModal2('📈 轨迹分析', html);
  } catch(e) { openModal2('📈 轨迹分析', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function openMetacognition(){
  openModal2('🔄 元认知', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/eng/metacognition'); var d = await r.json();
    var score = d.score !== undefined ? d.score : '-';
    var html = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;margin-bottom:12px;text-align:center;">';
    html += '<div style="font-size:11px;color:var(--c-fg-2);">元认知得分</div>';
    html += '<div style="font-size:32px;font-weight:700;color:var(--c-primary);margin-top:4px;">'+score+'</div>';
    html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:4px;">样本量 '+d.sampleSize+' 条</div>';
    html += '</div>';
    if (d.reflection) html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap;">'+escapeHtml(d.reflection)+'</div>';
    else html += '<div style="font-size:13px;color:var(--c-fg-3);text-align:center;padding:14px;">数据不足以分析</div>';
    openModal2('🔄 元认知反思', html);
  } catch(e) { openModal2('🔄 元认知', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function openCognitiveBias(){
  openModal2('🎭 认知偏差检测', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/eng/cognitive-bias'); var d = await r.json();
    var score = d.score !== undefined ? d.score : '-';
    var html = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;margin-bottom:12px;text-align:center;">';
    html += '<div style="font-size:11px;color:var(--c-fg-2);">偏差检测得分</div>';
    html += '<div style="font-size:32px;font-weight:700;color:#F59E0B;margin-top:4px;">'+score+'</div>';
    html += '</div>';
    var biases = d.biases || d.items || [];
    if (biases.length) {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0 8px;">检测到 '+biases.length+' 项偏差</div>';
      biases.forEach(function(b){
        html += '<div style="background:var(--c-surface);border-radius:8px;padding:10px;margin-bottom:6px;border-left:3px solid #F59E0B;">';
        html += '<div style="font-size:13px;font-weight:600;color:var(--c-fg);">'+escapeHtml(b.name||b.type||b.title||'偏差')+'</div>';
        if (b.description||b.detail) html += '<div style="font-size:12px;color:var(--c-fg-2);margin-top:4px;line-height:1.5;">'+escapeHtml(b.description||b.detail)+'</div>';
        html += '</div>';
      });
    } else if (d.reflection) {
      html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap;">'+escapeHtml(d.reflection)+'</div>';
    } else {
      html += '<div style="font-size:13px;color:var(--c-fg-3);text-align:center;padding:14px;">未检测到明显偏差</div>';
    }
    openModal2('🎭 认知偏差检测', html);
  } catch(e) { openModal2('🎭 认知偏差检测', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function openAntiHuman(){
  openModal2('🚫 反人性检测', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/eng/anti-human-nature'); var d = await r.json();
    var score = d.score !== undefined ? d.score : '-';
    var html = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;margin-bottom:12px;text-align:center;">';
    html += '<div style="font-size:11px;color:var(--c-fg-2);">反人性得分</div>';
    html += '<div style="font-size:32px;font-weight:700;color:var(--c-primary-2);margin-top:4px;">'+score+'</div>';
    html += '</div>';
    if (d.summary) html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap;margin-bottom:10px;">'+escapeHtml(d.summary)+'</div>';
    var items = d.items || d.checks || [];
    if (items.length) {
      items.forEach(function(it){
        html += '<div style="background:var(--c-surface);border-radius:8px;padding:10px;margin-bottom:6px;border-left:3px solid var(--c-primary-2);">';
        html += '<div style="font-size:13px;font-weight:600;color:var(--c-fg);">'+escapeHtml(it.name||it.title||'')+'</div>';
        if (it.detail||it.description) html += '<div style="font-size:12px;color:var(--c-fg-2);margin-top:4px;line-height:1.5;">'+escapeHtml(it.detail||it.description)+'</div>';
        html += '</div>';
      });
    } else if (d.reflection) {
      html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap;">'+escapeHtml(d.reflection)+'</div>';
    }
    openModal2('🚫 反人性检测', html);
  } catch(e) { openModal2('🚫 反人性检测', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function openValues(){
  openModal2('🎯 价值观澄清', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/eng/values-clarification'); var d = await r.json();
    var score = d.score !== undefined ? d.score : '-';
    var html = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;margin-bottom:12px;text-align:center;">';
    html += '<div style="font-size:11px;color:var(--c-fg-2);">价值观清晰度</div>';
    html += '<div style="font-size:32px;font-weight:700;color:#EC4899;margin-top:4px;">'+score+'</div>';
    html += '</div>';
    if (d.reflection) html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap;">'+escapeHtml(d.reflection)+'</div>';
    else html += '<div style="font-size:13px;color:var(--c-fg-3);text-align:center;padding:14px;">数据不足以分析</div>';
    openModal2('🎯 价值观澄清', html);
  } catch(e) { openModal2('🎯 价值观澄清', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function openSecondOrder(){
  var html = '<div style="background:var(--c-surface);border-radius:12px;padding:14px;margin-bottom:12px;">';
  html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px;">输入一个行动，看看它的二阶效应（连锁后果）</div>';
  html += '<select id="soMid" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:8px;">';
  html += '<option value="work">工作</option><option value="finance">财务</option><option value="health">健康</option><option value="emotion">情绪</option><option value="relation">关系</option><option value="growth">成长</option></select>';
  html += '<input id="soAction" placeholder="如：辞职创业 / 每天跑步 / 搬家" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:8px;">';
  html += '<button onclick="submitSecondOrder()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#8B5CF6,#A855F7);color:#fff;font-weight:600;cursor:pointer;">⚡ 分析二阶效应</button>';
  html += '</div>';
  html += '<div id="soResult"></div>';
  openModal2('⚡ 二阶效应分析', html);
}

async function submitSecondOrder(){
  var mid = document.getElementById('soMid').value;
  var action = document.getElementById('soAction').value.trim();
  if (!action) { alert('请输入行动'); return; }
  var el = document.getElementById('soResult');
  if (el) el.innerHTML = '<div style="text-align:center;color:var(--c-fg-3);padding:20px">分析中...</div>';
  try {
    var r = await fetch('/api/eng/second-order', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mid:mid, action:action}) });
    var d = await r.json();
    if (!d.success) { if(el) el.innerHTML = '<div style="color:#EF4444;padding:14px;">'+escapeHtml(d.message||'分析失败')+'</div>'; return; }
    var html = '';
    if (d.score !== undefined) {
      html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px;margin-bottom:8px;text-align:center;"><div style="font-size:11px;color:var(--c-fg-2);">影响分</div><div style="font-size:24px;font-weight:700;color:#8B5CF6;">'+d.score+'</div></div>';
    }
    var chain = d.chain || d.effects || [];
    if (chain.length) {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0;">连锁效应链</div>';
      chain.forEach(function(c, i){
        html += '<div style="background:var(--c-surface);border-radius:8px;padding:10px;margin-bottom:6px;border-left:3px solid #8B5CF6;">';
        html += '<div style="font-size:11px;color:#8B5CF6;font-weight:600;">第'+(i+1)+'阶</div>';
        html += '<div style="font-size:12px;color:var(--c-fg);margin-top:2px;line-height:1.5;">'+escapeHtml(c.effect||c.description||c.title||'')+'</div>';
        html += '</div>';
      });
    } else if (d.reflection) {
      html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap;">'+escapeHtml(d.reflection)+'</div>';
    }
    if(el) el.innerHTML = html || '<div style="color:var(--c-fg-3);padding:14px;text-align:center;">暂无分析结果</div>';
  } catch(e) { if(el) el.innerHTML = '<div style="color:#EF4444;padding:14px;">网络错误：'+e.message+'</div>'; }
}
// ===== 死按钮修复结束 =====`;

(function(){
  if (!fs.existsSync('frontend/app.js')) { console.log('  SKIP(no file): frontend/app.js'); skipped++; return; }
  let c = fs.readFileSync('frontend/app.js', 'utf8');
  if (c.includes('function openTrajectory()')) { console.log('  SKIP(already): 7个死按钮函数'); skipped++; return; }
  c = c + '\n' + deadBtnFns;
  fs.writeFileSync('frontend/app.js', c, 'utf8');
  console.log('  OK: 追加 7 个死按钮函数 + closeDetail');
  changed++;
})();

console.log('\n=== 修复完成: ' + changed + ' changed, ' + skipped + ' skipped ===');
console.log('\n下一步: node -c frontend/app.js && pm2 restart eggplant');
