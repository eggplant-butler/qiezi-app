const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 数据目录初始化 - v5.0需要的11个模块
const MODULES = ['finance', 'sleep', 'exercise', 'emotion', 'diet', 'diary', 'learn', 'photo', 'think', 'inventory', 'space', 'work', 'home', 'travel', 'body', 'relation', 'time', 'growth', 'spirit'];
MODULES.forEach(m => {
  const file = path.join(DATA_DIR, m + '.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
});

// 健康检查（必须在通用路由前）
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '5.0', time: new Date().toISOString() }));

// 统计接口（必须在通用路由前）
app.get('/api/stats', (req, res) => {
  const stats = {};
  MODULES.forEach(m => {
    const file = path.join(DATA_DIR, m + '.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      stats[m] = Array.isArray(data) ? data.length : 0;
    } catch (e) {
      stats[m] = 0;
    }
  });
  res.json(stats);
});

// 通用CRUD API（必须放在具体路由之后）
app.get('/api/:module', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  if (!fs.existsSync(file)) return res.json([]);
  try {
    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    res.json([]);
  }
});

app.post('/api/:module', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  const data = req.body;
  if (!Array.isArray(data)) {
    // 单条记录追加
    let arr = [];
    if (fs.existsSync(file)) {
      try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { arr = []; }
    }
    if (!data.id) data.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!data.created) data.created = new Date().toISOString();
    arr.push(data);
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    res.json({ success: true, id: data.id });
  } else {
    // 整个数组覆盖
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    res.json({ success: true });
  }
});

app.put('/api/:module/:id', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  if (!fs.existsSync(file)) return res.json({ success: false });
  let data = [];
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = []; }
  const idx = data.findIndex(item => item.id === req.params.id);
  if (idx === -1) return res.json({ success: false });
  data[idx] = { ...data[idx], ...req.body, updated: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  res.json({ success: true });
});

app.delete('/api/:module/:id', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  if (!fs.existsSync(file)) return res.json({ success: false });
  let data = [];
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = []; }
  data = data.filter(item => item.id !== req.params.id);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  res.json({ success: true });
});

// v5.0 前端
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>茄子管家 · v5.0</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
body{background:#0F0A1E;color:#E2E8F0;min-height:100vh;padding-bottom:80px}
#lock{position:fixed;inset:0;background:#0F0A1E;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px}
#lock input{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px 20px;width:280px;color:#fff;font-size:18px;text-align:center;outline:none}
#lock input:focus{border-color:#8B5CF6}
#lock button{background:linear-gradient(135deg,#8B5CF6,#EC4899);border:none;border-radius:12px;padding:14px 30px;color:#fff;font-size:18px;font-weight:600;cursor:pointer;margin-top:16px}
#lock .err{color:#EF4444;margin-top:8px;display:none}
#app{display:none;max-width:480px;margin:0 auto;padding:16px 16px 80px}
.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.hd h1{font-size:20px;font-weight:700;background:linear-gradient(to right,#fff,#C4B5FD);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hd-r{display:flex;gap:8px;align-items:center}
.hd-r .badge{background:#EF4444;color:#fff;font-size:10px;border-radius:10px;padding:0 8px;line-height:18px}
.hd-r button{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:6px 12px;color:#CBD5E1;font-size:14px;cursor:pointer}
.greet{background:rgba(255,255,255,0.04);border-radius:14px;padding:14px 18px;margin-bottom:16px;border-left:4px solid #8B5CF6}
.greet .d{font-size:13px;color:#94A3B8}
.greet .t{font-size:15px;color:#E2E8F0;margin-top:4px;display:flex;justify-content:space-between;align-items:center}
.greet .t strong{color:#fff}
.greet .t .remind-badge{background:#EF4444;color:#fff;font-size:10px;border-radius:10px;padding:0 10px;line-height:20px;cursor:pointer}
.overview{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.overview-card{background:rgba(255,255,255,0.04);border-radius:12px;padding:12px 14px;border:1px solid rgba(255,255,255,0.04)}
.overview-card .num{font-size:24px;font-weight:700;color:#A78BFA}
.overview-card .label{font-size:11px;color:#94A3B8;margin-top:2px}
.overview-card .sub{font-size:11px;color:#64748B;margin-top:2px}
.input-area{background:rgba(255,255,255,0.04);border-radius:14px;padding:10px 14px;margin-bottom:16px;display:flex;gap:10px;align-items:center;border:1px solid rgba(255,255,255,0.06)}
.input-area input{flex:1;background:transparent;border:none;color:#F1F5F9;font-size:15px;outline:none;padding:6px 0}
.input-area input::placeholder{color:#64748B}
.input-area button{background:linear-gradient(135deg,#8B5CF6,#EC4899);border:none;border-radius:10px;padding:8px 16px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}
.focus-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.focus-card{background:rgba(255,255,255,0.04);border-radius:12px;padding:12px 14px;border:1px solid rgba(255,255,255,0.04);cursor:pointer;transition:0.15s}
.focus-card:active{transform:scale(0.96)}
.focus-card .top{display:flex;justify-content:space-between;align-items:center}
.focus-card .ic{font-size:18px}
.focus-card .nm{font-size:13px;font-weight:600;color:#F1F5F9}
.focus-card .br{font-size:10px;color:#94A3B8;margin-top:2px}
.focus-card .progress{height:3px;background:rgba(255,255,255,0.06);border-radius:4px;margin-top:8px;overflow:hidden}
.focus-card .progress .fill{height:100%;border-radius:4px;background:linear-gradient(90deg,#8B5CF6,#EC4899);transition:width 0.5s}
.focus-card .status{font-size:10px;padding:2px 8px;border-radius:10px}
.focus-card .status.active{background:rgba(34,197,94,0.2);color:#22C55E}
.focus-card .status.steady{background:rgba(251,191,36,0.2);color:#FBBF24}
.focus-card .status.learning{background:rgba(139,92,246,0.2);color:#A78BFA}
.focus-card .status.paused{background:rgba(148,163,184,0.2);color:#94A3B8}
.quick-modules{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:16px}
.quick-module{background:rgba(255,255,255,0.03);border-radius:10px;padding:10px 4px;text-align:center;border:1px solid rgba(255,255,255,0.03);cursor:pointer;transition:0.15s}
.quick-module:active{transform:scale(0.94)}
.quick-module .ic{font-size:18px}
.quick-module .nm{font-size:10px;color:#94A3B8;margin-top:2px}
.quick-module .cnt{font-size:9px;color:#64748B}
.bar{position:fixed;bottom:0;left:0;right:0;background:rgba(15,10,30,0.92);backdrop-filter:blur(20px);border-top:1px solid rgba(255,255,255,0.04);display:flex;padding:6px 0 14px;max-width:480px;margin:0 auto;z-index:100}
.tab{flex:1;text-align:center;color:#64748B;font-size:10px;cursor:pointer;padding:2px 0}
.tab .ic{font-size:20px;display:block}
.tab.act{color:#A78BFA}
.pg{display:none}
.pg.act{display:block}
.detail{display:none;padding-bottom:80px}
.detail.act{display:block}
.back{background:transparent;border:none;color:#A78BFA;font-size:16px;cursor:pointer;margin-bottom:12px}
.rec{background:rgba(255,255,255,0.03);border-radius:10px;padding:10px 14px;margin-bottom:6px;border:1px solid rgba(255,255,255,0.04);display:flex;justify-content:space-between;align-items:center}
.rec .tt{font-size:13px;color:#F1F5F9}
.rec .sb{font-size:10px;color:#94A3B8;margin-top:2px}
.rec .ac button{background:transparent;border:none;color:#64748B;cursor:pointer;padding:0 4px;font-size:14px}
.rec .ac .dl{color:#EF4444}
.rec .tag{font-size:9px;background:rgba(139,92,246,0.15);color:#A78BFA;border-radius:8px;padding:0 8px;line-height:18px;display:inline-block}
.add{position:fixed;bottom:80px;right:20px;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#8B5CF6,#EC4899);border:none;color:#fff;font-size:28px;box-shadow:0 4px 16px rgba(139,92,246,0.4);cursor:pointer;z-index:50;display:flex;align-items:center;justify-content:center}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:200;justify-content:center;align-items:center;padding:20px;backdrop-filter:blur(8px)}
.modal.act{display:flex}
.modal-b{background:#1E1B4B;border-radius:16px;padding:24px;max-width:420px;width:100%;max-height:80vh;overflow-y:auto}
.modal-b h3{font-size:16px;margin-bottom:12px;color:#F1F5F9}
.modal-b label{display:block;font-size:12px;color:#94A3B8;margin-bottom:4px;margin-top:10px}
.modal-b input,.modal-b select,.modal-b textarea{width:100%;padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.04);color:#F1F5F9;font-size:14px;font-family:inherit;margin-bottom:4px}
.modal-b textarea{min-height:50px;resize:vertical}
.modal-b .row{display:flex;gap:8px;margin-top:12px}
.modal-b .row button{flex:1;padding:10px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer}
.modal-b .sv{background:linear-gradient(135deg,#8B5CF6,#EC4899);color:#fff}
.modal-b .cn{background:rgba(255,255,255,0.06);color:#94A3B8}
.ins{background:rgba(167,139,250,0.08);border-radius:12px;padding:12px 16px;margin:8px 0;border-left:3px solid #A78BFA;font-size:13px;color:#CBD5E1}
.ins .strong{color:#F1F5F9}
.empty{text-align:center;padding:30px 0;color:#64748B}
.empty .ic{font-size:36px;display:block;margin-bottom:8px}
.space-item{background:rgba(255,255,255,0.03);border-radius:12px;padding:12px 14px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.04);cursor:pointer}
.space-item .top{display:flex;justify-content:space-between;align-items:center}
.space-item .nm{font-size:14px;font-weight:600;color:#F1F5F9}
.space-item .cnt{font-size:12px;color:#94A3B8}
.space-item .sub{font-size:11px;color:#64748B;margin-top:2px}
.area-item{background:rgba(255,255,255,0.02);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:2px solid rgba(139,92,246,0.3);cursor:pointer}
.area-item .nm{font-size:13px;color:#F1F5F9}
.area-item .cnt{font-size:11px;color:#94A3B8}
</style>
</head>
<body>
<div id="lock">
<div style="text-align:center;max-width:320px">
<h1 style="font-size:28px;font-weight:700;background:linear-gradient(to right,#fff,#C4B5FD);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px">🍆 茄子管家</h1>
<p style="color:#94A3B8;margin-bottom:24px">输入密码进入你的空间</p>
<input type="password" id="pwdI" placeholder="请输入密码">
<button onclick="login()">进入</button>
<div class="err" id="pwdErr">密码错误</div>
</div>
</div>
<div id="app">
<div class="hd"><h1>🍆 茄子管家</h1><div class="hd-r"><span class="badge" id="remindBadge" style="display:none">•</span><button onclick="togglePrivacy()">👁️</button><button onclick="switchTab('me')">⚙️</button></div></div>
<div class="greet"><div class="d" id="todayD"></div><div class="t"><span id="greetT">加载中...</span><span class="remind-badge" id="remindEntry" onclick="switchTab('insight')" style="display:none">1条提醒</span></div></div>

<div class="pg act" id="pgHome">
<div class="overview"><div class="overview-card"><div class="num" id="ovSleep">-</div><div class="label">平均睡眠</div><div class="sub">近7天</div></div><div class="overview-card"><div class="num" id="ovMood">-</div><div class="label">平均情绪</div><div class="sub">近7天</div></div></div>
<div class="input-area"><input type="text" id="nlInput" placeholder="说一句话记录... 如：中午吃了鸡胸肉沙拉"><button onclick="nlSubmit()">发送</button></div>
<div class="focus-grid" id="focusGrid"></div>
<div class="quick-modules" id="quickModules"></div>
</div>

<div class="pg" id="pgRecord"><div id="recordList"></div></div>
<div class="pg" id="pgInsight"><div id="insightContent"></div></div>
<div class="pg" id="pgMe"><div id="meContent"></div></div>

<div class="detail" id="detail"><button class="back" onclick="closeDetail()">‹ 返回</button><h2 id="detailTitle"></h2><div id="detailContent"></div><button class="add" onclick="openAdd()">+</button></div>
<div class="modal" id="modal"><div class="modal-b"><h3 id="modalTitle">添加记录</h3><div id="modalBody"></div><div class="row"><button class="sv" onclick="saveRecord()">保存</button><button class="cn" onclick="closeModal()">取消</button></div></div></div>
<div class="bar"><div class="tab act" onclick="switchTab('home')"><span class="ic">🏠</span>首页</div><div class="tab" onclick="switchTab('record')"><span class="ic">📋</span>记录</div><div class="tab" onclick="switchTab('insight')"><span class="ic">🔮</span>洞察</div><div class="tab" onclick="switchTab('me')"><span class="ic">👤</span>我</div></div>
</div>

<script>
var PWD='eggplant';
var TODAY=new Date().toISOString().split('T')[0];
var curScene=null,editId=null,privacyOn=false;
var SCENES=[
{id:'work',name:'我的工作',icon:'💼',brief:'职业·收入·意义'},
{id:'home',name:'我的居住',icon:'🏠',brief:'空间·物品·安全'},
{id:'travel',name:'我的出行',icon:'🛵',brief:'通勤·自由·掌控'},
{id:'body',name:'我的身体',icon:'💪',brief:'睡眠·锻炼·饮食'},
{id:'relation',name:'我的关系',icon:'👥',brief:'父母·同事·朋友'},
{id:'time',name:'我的时间',icon:'⏰',brief:'分配·频率·充实'},
{id:'growth',name:'我的成长',icon:'🌱',brief:'学习·技能·方向'},
{id:'spirit',name:'我的精神',icon:'🧠',brief:'日志·信念·价值'}
];
var FOCUS=[
{id:'work',label:'工作收入',icon:'💼',desc:'稳定收入·增长路径',status:'active'},
{id:'photo',label:'摄影能力',icon:'📷',desc:'技能积累·表达出口',status:'learning'},
{id:'body',label:'身体健康',icon:'💪',desc:'能量基础·一切前提',status:'steady'},
{id:'think',label:'认知思考',icon:'🧠',desc:'决策质量·成长引擎',status:'learning'}
];
var CORE_MODULES=[
{id:'finance',label:'财务',icon:'💰'},{id:'sleep',label:'睡眠',icon:'😴'},
{id:'exercise',label:'锻炼',icon:'🏃'},{id:'emotion',label:'情绪',icon:'😊'},
{id:'diet',label:'饮食',icon:'🥗'},{id:'diary',label:'日记',icon:'📖'},
{id:'learn',label:'学习复盘',icon:'📚'},{id:'photo',label:'摄影',icon:'📷'},
{id:'think',label:'认知思考',icon:'🧠'},{id:'inventory',label:'库存',icon:'📦'},
{id:'space',label:'空间物品',icon:'🏠'}
];

// API调用
async function apiGet(module){
  try{var r=await fetch('/api/'+module);return await r.json()}catch(e){return[]}
}
async function apiPost(module,data){
  try{var r=await fetch('/api/'+module,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return await r.json()}catch(e){return{success:false}}
}
async function apiPut(module,id,data){
  try{var r=await fetch('/api/'+module+'/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return await r.json()}catch(e){return{success:false}}
}
async function apiDel(module,id){
  try{var r=await fetch('/api/'+module+'/'+id,{method:'DELETE'});return await r.json()}catch(e){return{success:false}}
}
async function getStats(){
  try{var r=await fetch('/api/stats');return await r.json()}catch(e){return{}}
}

var dataCache={};
async function loadData(module){
  if(!dataCache[module]){
    var d=await apiGet(module);
    dataCache[module]=Array.isArray(d)?d:[];
  }
  return dataCache[module];
}
function clearCache(module){if(module)delete dataCache[module];else dataCache={}}

// 登录
function login(){
  var p=document.getElementById('pwdI').value;
  if(p===PWD){
    document.getElementById('lock').style.display='none';
    document.getElementById('app').style.display='block';
    initApp();
  }else{
    document.getElementById('pwdErr').style.display='block';
  }
}
document.getElementById('pwdI').addEventListener('keydown',function(e){if(e.key==='Enter')login()});

async function initApp(){
  var stats=await getStats();
  for(var m in stats) await loadData(m);
  renderHome();
}

// 渲染首页
async function renderHome(){
  var g=document.getElementById('focusGrid');
  var html='';
  for(var i=0;i<FOCUS.length;i++){
    var f=FOCUS[i];
    var data=await loadData(f.id)||[];
    var progress=Math.min(100,data.length*5);
    var statusMap={active:'活跃',learning:'学习中',steady:'稳定',paused:'暂停'};
    html+='<div class="focus-card" data-sid="'+f.id+'"><div class="top"><span class="ic">'+f.icon+'</span><span class="status '+f.status+'">'+statusMap[f.status]+'</span></div><div class="nm">'+f.label+'</div><div class="br">'+f.desc+' · '+data.length+'条</div><div class="progress"><div class="fill" style="width:'+progress+'%"></div></div></div>';
  }
  g.innerHTML=html;
  g.querySelectorAll('.focus-card').forEach(function(el){el.onclick=function(){openScene(this.dataset.sid)}});
  
  var m=document.getElementById('quickModules');
  var mhtml='';
  for(var j=0;j<CORE_MODULES.length;j++){
    var mod=CORE_MODULES[j];
    var d=await loadData(mod.id)||[];
    mhtml+='<div class="quick-module" data-mid="'+mod.id+'"><span class="ic">'+mod.icon+'</span><div class="nm">'+mod.label+'</div><div class="cnt">'+d.length+'条</div></div>';
  }
  m.innerHTML=mhtml;
  m.querySelectorAll('.quick-module').forEach(function(el){el.onclick=function(){openScene(this.dataset.mid)}});
  
  var n=new Date();
  document.getElementById('todayD').textContent=n.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
  var h=n.getHours();
  document.getElementById('greetT').innerHTML=(h<6?'深夜':h<9?'早安':h<12?'上午好':h<14?'午安':h<18?'下午好':h<21?'晚上好':'夜深了')+' · 今天状态如何？';
  
  await renderOverview();
}

async function renderOverview(){
  var sleep=await loadData('sleep')||[];
  var emotion=await loadData('emotion')||[];
  var sl=0,em=0;
  sleep.slice(-7).forEach(function(s){sl+=parseFloat(s.hours)||0});
  emotion.slice(-7).forEach(function(e){em+=parseFloat(e.rating)||0});
  document.getElementById('ovSleep').textContent=(sleep.length?(sl/Math.min(7,sleep.length)).toFixed(1):'-')+'h';
  document.getElementById('ovMood').textContent=(emotion.length?(em/Math.min(7,emotion.length)).toFixed(1):'-')+'/10';
}

// 自然语言提交
async function nlSubmit(){
  var text=document.getElementById('nlInput').value.trim();
  if(!text){alert('请输入内容');return;}
  var msg=await parseNL(text);
  alert(msg);
  document.getElementById('nlInput').value='';
  clearCache();
  await renderHome();
  if(curScene)await renderDetail(curScene);
}

async function parseNL(text){
  var modules={
    finance:['花了','买了','消费','支出','收入','工资','提成','吃饭花了','付了'],
    sleep:['睡了','醒','困','失眠','做梦','作息','熬夜'],
    exercise:['跑了','走了','跳了','练了','运动','力量','瑜伽','健身','出汗','拉伸'],
    emotion:['感觉','心情','开心','焦虑','平静','烦躁','情绪','状态','难过','兴奋'],
    diet:['吃了','喝了','早餐','午餐','晚餐','加餐','水果','零食','咖啡','饮'],
    photo:['拍了','相机','镜头','快门','光圈','街拍','人像','构图','调色','摄影'],
    think:['想了','复盘','决定','判断','认为','反思','方向','目标','纠结','思考'],
    diary:['发生','经历','今天','昨天','早上','下午','晚上']
  };
  var target='diary';
  for(var mod in modules){
    for(var i=0;i<modules[mod].length;i++){
      if(text.indexOf(modules[mod][i])!==-1){target=mod;break;}
    }
  }
  var obj={content:text,date:TODAY,created:new Date().toISOString()};
  await apiPost(target,obj);
  var names={finance:'财务',sleep:'睡眠',exercise:'锻炼',emotion:'情绪',diet:'饮食',photo:'摄影',think:'认知思考',diary:'日记'};
  return '✅ 已存入「'+(names[target]||target)+'」';
}

// 切换Tab
async function switchTab(t){
  document.querySelectorAll('.tab').forEach(function(el){el.classList.remove('act')});
  document.querySelectorAll('.pg').forEach(function(el){el.classList.remove('act')});
  document.getElementById('detail').classList.remove('act');
  curScene=null;
  var tabNames={home:'首页',record:'记录',insight:'洞察',me:'我'};
  document.querySelectorAll('.tab').forEach(function(el){
    if(el.textContent.trim().indexOf(tabNames[t])!==-1)el.classList.add('act');
  });
  if(t==='home'){document.getElementById('pgHome').classList.add('act');await renderHome();}
  else if(t==='record'){document.getElementById('pgRecord').classList.add('act');await renderRecord();}
  else if(t==='insight'){document.getElementById('pgInsight').classList.add('act');await renderInsight();}
  else if(t==='me'){document.getElementById('pgMe').classList.add('act');await renderMe();}
}

// 场景详情
async function openScene(id){
  curScene=id;
  var s=SCENES.find(function(x){return x.id===id})||CORE_MODULES.find(function(x){return x.id===id})||{};
  var name=s.name||s.label||id;
  var icon=s.icon||'📄';
  document.getElementById('detailTitle').textContent=icon+' '+name;
  document.getElementById('detail').classList.add('act');
  await renderDetail(id);
}
function closeDetail(){document.getElementById('detail').classList.remove('act');curScene=null;}

async function renderDetail(id){
  var data=await loadData(id)||[];
  var c=document.getElementById('detailContent');
  if(!data.length){c.innerHTML='<div class="empty"><span class="ic">📭</span>还没有记录，点 + 添加</div>';return;}
  c.innerHTML='<div>'+data.slice().reverse().map(function(item){
    var l=item.content||item.name||'记录';
    var s=item.date||'';
    if(item.amount)l+=' ¥'+item.amount;
    if(item.rating)s+=' · 评分'+item.rating;
    if(item.status)s+=' · '+item.status;
    return '<div class="rec" data-rid="'+item.id+'"><div><div class="tt">'+l+'</div><div class="sb">'+s+'</div></div><div class="ac"><button class="edit-btn">✏️</button><button class="dl del-btn">🗑️</button></div></div>';
  }).join('')+'</div>';
  c.querySelectorAll('.rec').forEach(function(el){
    var rid=el.dataset.rid;
    el.querySelector('.edit-btn').onclick=function(){editRec(id,rid)};
    el.querySelector('.del-btn').onclick=function(){delRec(id,rid)};
  });
}

function openAdd(){
  editId=null;
  document.getElementById('modalTitle').textContent='添加记录';
  document.getElementById('modalBody').innerHTML='<label>内容</label><input id="f_c" placeholder="记录内容"><label>日期</label><input type="date" id="f_d" value="'+TODAY+'"><label>评分(可选)</label><select id="f_r"><option value="">无</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select><label>备注</label><textarea id="f_n" rows="2"></textarea>';
  document.getElementById('modal').classList.add('act');
}

async function editRec(sceneId,recId){
  var data=await loadData(sceneId)||[];
  var item=data.find(function(x){return x.id===recId});
  if(!item)return;
  editId=recId;
  document.getElementById('modalTitle').textContent='编辑记录';
  document.getElementById('modalBody').innerHTML='<label>内容</label><input id="f_c" value="'+(item.content||item.name||'')+'"><label>日期</label><input type="date" id="f_d" value="'+(item.date||TODAY)+'"><label>评分</label><select id="f_r"><option value="">无</option>'+[1,2,3,4,5].map(function(r){return '<option '+(item.rating==r?'selected':'')+'>'+r+'</option>';}).join('')+'</select><label>备注</label><textarea id="f_n" rows="2">'+(item.note||'')+'</textarea>';
  document.getElementById('modal').classList.add('act');
}

async function saveRecord(){
  var c=document.getElementById('f_c').value.trim();
  if(!c){alert('请填写内容');return;}
  var d=document.getElementById('f_d').value;
  var r=document.getElementById('f_r').value;
  var n=document.getElementById('f_n').value;
  
  if(editId){
    await apiPut(curScene,editId,{content:c,date:d,rating:r,note:n});
  }else{
    await apiPost(curScene,{content:c,date:d,rating:r,note:n});
  }
  clearCache(curScene);
  closeModal();
  await renderDetail(curScene);
}

async function delRec(sceneId,recId){
  if(!confirm('确定删除？'))return;
  await apiDel(sceneId,recId);
  clearCache(sceneId);
  await renderDetail(sceneId);
}

function closeModal(){document.getElementById('modal').classList.remove('act');editId=null;}

// 记录页
async function renderRecord(){
  var c=document.getElementById('recordList');
  var html='';
  for(var i=0;i<SCENES.length;i++){
    var s=SCENES[i];
    var data=await loadData(s.id)||[];
    html+='<div class="space-item" data-rid="'+s.id+'"><div class="top"><span class="nm">'+s.icon+' '+s.name+'</span><span class="cnt">'+data.length+'条</span></div><div class="sub">'+s.brief+'</div></div>';
  }
  c.innerHTML=html;
  c.querySelectorAll('.space-item').forEach(function(el){el.onclick=function(){openScene(el.dataset.rid)}});
}

// 洞察页
async function renderInsight(){
  var c=document.getElementById('insightContent');
  var total=0;
  var allData={};
  for(var i=0;i<SCENES.length;i++){
    var d=await loadData(SCENES[i].id)||[];
    allData[SCENES[i].id]=d;
    total+=d.length;
  }
  var html='<div class="ins">📊 总记录：'+total+' 条</div>';
  
  var sleep=allData['sleep']||[];
  var emotion=allData['emotion']||[];
  
  if(sleep.length>2&&emotion.length>2){
    var good=0,bad=0,ge=0,be=0;
    emotion.forEach(function(e){
      var s=sleep.find(function(si){return si.date===e.date});
      if(s){
        var h=parseFloat(s.hours)||0;
        if(h>=7){good++;ge+=parseFloat(e.rating)||0;}
        else if(h>0){bad++;be+=parseFloat(e.rating)||0;}
      }
    });
    if(good>0||bad>0){
      html+='<div class="ins">💤 睡眠≥7h时情绪 '+(good?(ge/good).toFixed(1):'无')+' 分，睡眠<7h时 '+(bad?(be/bad).toFixed(1):'无')+' 分</div>';
    }
  }
  
  var exercise=allData['exercise']||[];
  if(exercise.length>2&&emotion.length>2){
    var exDates={};
    exercise.forEach(function(e){exDates[e.date]=true});
    var exE=0,noE=0,exC=0,noC=0;
    emotion.forEach(function(e){
      if(exDates[e.date]){exC++;exE+=parseFloat(e.rating)||0;}
      else{noC++;noE+=parseFloat(e.rating)||0;}
    });
    if(exC>0||noC>0){
      html+='<div class="ins">🏃 锻炼日情绪 '+(exC?(exE/exC).toFixed(1):'无')+' 分，非锻炼日 '+(noC?(noE/noC).toFixed(1):'无')+' 分</div>';
    }
  }
  
  var diet=allData['diet']||[];
  if(diet.length>0){
    var veg=diet.filter(function(d){return d.content&&(d.content.indexOf('蔬菜')!==-1||d.content.indexOf('青菜')!==-1||d.content.indexOf('沙拉')!==-1)});
    var meat=diet.filter(function(d){return d.content&&(d.content.indexOf('肉')!==-1||d.content.indexOf('鸡胸')!==-1||d.content.indexOf('牛肉')!==-1)});
    var carb=diet.filter(function(d){return d.content&&(d.content.indexOf('饭')!==-1||d.content.indexOf('面')!==-1||d.content.indexOf('馒头')!==-1||d.content.indexOf('面包')!==-1)});
    html+='<div class="ins">🥗 近7天：蔬菜'+veg.length+'次 · 肉类'+meat.length+'次 · 碳水'+carb.length+'次</div>';
  }
  c.innerHTML=html;
}

// 我的页
async function renderMe(){
  var total=0;
  for(var i=0;i<SCENES.length;i++){
    var d=await loadData(SCENES[i].id)||[];
    total+=d.length;
  }
  var c=document.getElementById('meContent');
  c.innerHTML='<div style="margin-top:12px"><div style="background:rgba(255,255,255,0.03);border-radius:12px;padding:16px;margin-bottom:12px"><div style="font-weight:600;font-size:16px">👤 个人信息</div><div style="font-size:13px;color:#94A3B8">总记录：'+total+' 条</div><div style="font-size:13px;color:#94A3B8">版本：v5.0 (数据持久化版)</div></div><div style="background:rgba(255,255,255,0.03);border-radius:12px;padding:16px;margin-bottom:12px"><div style="font-weight:600;font-size:16px">🔐 密码</div><div style="display:flex;gap:8px;margin-top:8px"><input id="newPwd" placeholder="新密码" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.04);color:#fff"><button onclick="changePwd()" style="background:#8B5CF6;border:none;border-radius:8px;padding:8px 16px;color:#fff;cursor:pointer">修改</button></div></div><div style="background:rgba(255,255,255,0.03);border-radius:12px;padding:16px;margin-bottom:12px"><div style="font-weight:600;font-size:16px">💾 数据</div><button onclick="exportData()" style="background:#10B981;border:none;border-radius:8px;padding:8px 16px;color:#fff;cursor:pointer;margin-top:8px">导出备份</button><button onclick="clearAll()" style="background:#EF4444;border:none;border-radius:8px;padding:8px 16px;color:#fff;cursor:pointer;margin-left:8px">清空</button></div></div>';
}

function changePwd(){
  var np=document.getElementById('newPwd').value;
  if(np.length<4){alert('至少4位');return;}
  PWD=np;
  localStorage.setItem('qzos_pwd',np);
  alert('密码已修改');
}

async function exportData(){
  var all={};
  for(var i=0;i<SCENES.length;i++){
    all[SCENES[i].id]=await loadData(SCENES[i].id)||[];
  }
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(all,null,2)],{type:'application/json'}));
  a.download='qiezi_backup_'+TODAY+'.json';
  a.click();
}

async function clearAll(){
  if(!confirm('确定清空全部数据？不可恢复！'))return;
  for(var i=0;i<SCENES.length;i++){
    await apiPost(SCENES[i],[]);
  }
  clearCache();
  alert('已清空');
  await renderMe();
}

function togglePrivacy(){
  privacyOn=!privacyOn;
  alert(privacyOn?'👁️ 隐私模式已开启':'👁️ 隐私模式已关闭');
}

(function(){
  var s=localStorage.getItem('qzos_pwd');
  if(s)PWD=s;
  document.getElementById('pwdI').focus();
})();
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log('🍆 茄子管家 v5.0 运行在端口 ' + PORT));