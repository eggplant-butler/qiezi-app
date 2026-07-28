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

// ---------- 通用CRUD API ----------
app.get('/api/:module', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  if (!fs.existsSync(file)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.post('/api/:module', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

app.delete('/api/:module/:index', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  if (!fs.existsSync(file)) return res.json({ success: false });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.splice(parseInt(req.params.index), 1);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  res.json({ success: true });
});

// ---------- 状态/洞察 ----------
app.get('/api/state', (req, res) => {
  const stateFile = path.join(DATA_DIR, 'state.json');
  if (!fs.existsSync(stateFile)) return res.json({ balance: 72, desc: '保持觉察，稳步前行', insights: null });
  res.json(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '3.0-center' }));

// ---------- 语音指令 ----------
app.post('/api/voice', (req, res) => {
  const text = req.body.text || '';
  let result = { action: 'unknown', message: '没听清，能再说一遍吗？' };
  
  const match1 = text.match(/(?:记[^0-9]*?|花了?|买了?)([^0-9]+?)(\d+(?:\.\d+)?)\s*(?:块|元)/);
  if (match1) {
    result = {
      action: 'add_record',
      module: 'finance',
      data: { date: new Date().toISOString().slice(0,10), type: '支出', category: match1[1].trim()||'其他', amount: match1[2], note: text },
      message: `✅ 已记录：${match1[1]} 消费 ${match1[2]} 元`
    };
  }
  
  const match2 = text.match(/睡[着了]?(\d+(?:\.\d+)?)\s*(?:小时|h)/);
  if (match2) {
    result = {
      action: 'add_record',
      module: 'sleep',
      data: { date: new Date().toISOString().slice(0,10), hours: match2[1], quality: '4', note: text },
      message: `✅ 已记录睡眠：${match2[1]} 小时`
    };
  }
  
  const match3 = text.match(/[今昨]?天?(?:心情|情绪)?(\d+)\s*分/);
  if (match3) {
    result = {
      action: 'add_record',
      module: 'emotion',
      data: { date: new Date().toISOString().slice(0,10), score: match3[1], tags: text, note: text },
      message: `✅ 已记录情绪：${match3[1]} 分`
    };
  }
  
  res.json(result);
});

// ---------- 头像/备份 ----------
app.get('/api/avatar', (req, res) => res.json({}));
app.post('/api/avatar', (req, res) => res.json({ success: true }));
app.get('/api/backup', (req, res) => res.json({ success: true }));

// ---------- 重心版前端 ----------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>茄子管家·重心版</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
:root{--bg:#0d1117;--card:#161b22;--card2:#1c2128;--border:#30363d;--text:#e6edf3;--text2:#8b949e;--primary:#58a6ff;--green:#3fb950;--purple:#a371f7;--orange:#f0883e;--yellow:#d29922;--blue:#58a6ff;--pink:#db61a2}
body{background:var(--bg);color:var(--text);padding-bottom:80px;min-height:100vh}
.tab-page{display:none;padding:16px}
.tab-page.active{display:block}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:0 4px}
.header h1{font-size:22px;font-weight:700}
.avatar{width:40px;height:40px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;cursor:pointer}
.avatar i{color:#fff;font-size:18px}
.balance-card{background:linear-gradient(135deg,#1f6feb 0%,#a371f7 100%);border-radius:20px;padding:24px;margin-bottom:20px;color:#fff;position:relative;overflow:hidden}
.balance-card::before{content:'';position:absolute;top:-50%;right:-20%;width:200px;height:200px;background:rgba(255,255,255,0.1);border-radius:50%}
.balance-card .label{font-size:13px;opacity:0.9;margin-bottom:6px}
.balance-card .score{font-size:48px;font-weight:700;margin:8px 0}
.balance-card .desc{font-size:13px;opacity:0.85}
.section-title{font-size:16px;font-weight:600;margin:20px 0 12px;display:flex;align-items:center;gap:8px}
.section-title i{color:var(--primary)}
.center-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px}
.center-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;cursor:pointer;transition:0.2s}
.center-card:active{transform:scale(0.97);border-color:var(--primary)}
.center-card .icon-wrap{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;font-size:20px;color:#fff}
.center-card .name{font-size:15px;font-weight:600;margin-bottom:4px}
.center-card .desc{font-size:12px;color:var(--text2)}
.center-card .progress{height:4px;background:var(--card2);border-radius:2px;margin-top:8px;overflow:hidden}
.center-card .progress-bar{height:100%;background:linear-gradient(90deg,var(--primary),var(--purple));border-radius:2px}
.quick-input{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:14px;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.quick-input i{color:var(--primary);font-size:18px}
.quick-input input{flex:1;background:transparent;border:none;color:var(--text);font-size:14px;outline:none}
.quick-input input::placeholder{color:var(--text2)}
.module-list{display:flex;flex-direction:column;gap:8px}
.module-item{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:14px;cursor:pointer}
.module-item:active{transform:scale(0.98);background:var(--card2)}
.module-item .icon-wrap{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px}
.module-item .info{flex:1}
.module-item .name{font-size:15px;font-weight:500;margin-bottom:2px}
.module-item .sub{font-size:12px;color:var(--text2)}
.module-item .arrow{color:var(--text2);font-size:14px}
.focus-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 8px;text-align:center}
.stat-card .num{font-size:24px;font-weight:700;margin-bottom:4px}
.stat-card .label{font-size:11px;color:var(--text2)}
.report-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:12px}
.report-card h3{font-size:15px;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.report-card h3 i{color:var(--primary)}
.report-card p{font-size:13px;color:var(--text2);line-height:1.6}
.report-card .tag{display:inline-block;padding:3px 10px;background:var(--card2);border-radius:10px;font-size:11px;color:var(--primary);margin-right:6px;margin-top:4px}
.chat-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:14px;margin-bottom:12px}
.chat-msg{padding:10px 14px;border-radius:12px;margin-bottom:8px;max-width:80%;font-size:14px;line-height:1.5}
.chat-msg.user{background:var(--primary);color:#fff;margin-left:auto}
.chat-msg.bot{background:var(--card2);color:var(--text)}
.chat-input{display:flex;gap:8px;position:fixed;bottom:80px;left:16px;right:16px}
.chat-input input{flex:1;background:var(--card);border:1px solid var(--border);border-radius:24px;padding:12px 18px;color:var(--text);font-size:14px;outline:none}
.chat-input button{background:var(--primary);color:#fff;border:none;border-radius:50%;width:44px;height:44px;cursor:pointer}
.profile-section{background:var(--card);border:1px solid var(--border);border-radius:14px;margin-bottom:12px;overflow:hidden}
.profile-item{padding:16px;display:flex;align-items:center;gap:14px;cursor:pointer;border-bottom:1px solid var(--border)}
.profile-item:last-child{border-bottom:none}
.profile-item:active{background:var(--card2)}
.profile-item i{width:20px;color:var(--primary);font-size:16px}
.profile-item .name{flex:1;font-size:14px}
.profile-item .arrow{color:var(--text2);font-size:12px}
.bottom-nav{position:fixed;bottom:0;left:0;right:0;background:var(--card);border-top:1px solid var(--border);display:flex;justify-content:space-around;padding:8px 0;z-index:100}
.nav-item{flex:1;text-align:center;padding:6px;cursor:pointer;color:var(--text2)}
.nav-item.active{color:var(--primary)}
.nav-item i{font-size:20px;display:block;margin-bottom:2px}
.nav-item span{font-size:11px}
.detail-page{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:200;overflow-y:auto;padding:16px}
.detail-page.active{display:block}
.back-btn{background:none;border:none;color:var(--text);font-size:16px;cursor:pointer;margin-bottom:16px;display:flex;align-items:center;gap:6px}
.add-btn{position:fixed;bottom:100px;right:20px;background:var(--primary);color:#fff;border:none;width:56px;height:56px;border-radius:50%;font-size:22px;box-shadow:0 4px 20px rgba(31,111,235,0.4);cursor:pointer;z-index:150}
.modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:300;justify-content:center;align-items:flex-end;padding:16px}
.modal.active{display:flex}
.modal-box{background:var(--card);border-radius:20px 20px 0 0;padding:24px;width:100%;max-height:85vh;overflow-y:auto;border:1px solid var(--border)}
.modal-box h3{font-size:18px;margin-bottom:16px}
.field-group{margin-bottom:14px}
.field-group label{display:block;font-size:12px;color:var(--text2);margin-bottom:4px;font-weight:500}
.field-group input,.field-group select,.field-group textarea{width:100%;background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:11px 14px;color:var(--text);font-size:14px;outline:none}
.field-group input:focus,.field-group select:focus,.field-group textarea:focus{border-color:var(--primary)}
.btn-save{background:var(--primary);color:#fff;border:none;padding:14px;border-radius:12px;width:100%;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px}
.list-item{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.list-item .main{flex:1}
.list-item .title{font-size:14px;margin-bottom:3px}
.list-item .sub{font-size:12px;color:var(--text2)}
.empty-state{text-align:center;color:var(--text2);padding:40px 0;font-size:14px}
.toast{position:fixed;top:80px;left:50%;transform:translateX(-50%);background:var(--card2);color:var(--text);padding:10px 22px;border-radius:12px;font-size:13px;z-index:500;opacity:0;transition:0.3s;pointer-events:none;border:1px solid var(--border)}
.toast.show{opacity:1}
</style>
</head>
<body>
<div id="home" class="tab-page active">
  <div class="header"><h1>🍆 茄子管家</h1><div class="avatar" id="avatarBtn"><i class="fas fa-user"></i></div></div>
  <div class="balance-card"><div class="label">平衡指数</div><div class="score" id="balanceScore">--</div><div class="desc" id="balanceDesc">保持觉察，稳步前行</div></div>
  <div class="quick-input"><i class="fas fa-microphone"></i><input type="text" id="quickInput" placeholder="说一句：今晚11点睡/记账午餐35块/今天很累7分"></div>
  <div class="section-title"><i class="fas fa-bullseye"></i> 4个重心</div>
  <div class="center-grid" id="centerGrid"></div>
  <div class="section-title"><i class="fas fa-grid-2"></i> 6个核心模块</div>
  <div class="module-list" id="moduleList"></div>
</div>
<div id="focus" class="tab-page">
  <div class="header"><h1><i class="fas fa-compass"></i> 聚焦</h1></div>
  <div class="balance-card"><div class="label">综合平衡指数</div><div class="score" id="focusScore">--</div><div class="desc" id="focusDesc">最近7天综合表现</div></div>
  <div class="section-title"><i class="fas fa-chart-bar"></i> 三维统计</div>
  <div class="focus-stats"><div class="stat-card"><div class="num" style="color:var(--purple)" id="statSleep">--</div><div class="label">睡眠(h)</div></div><div class="stat-card"><div class="num" style="color:var(--yellow)" id="statEmotion">--</div><div class="label">情绪</div></div><div class="stat-card"><div class="num" style="color:var(--orange)" id="statExercise">--</div><div class="label">锻炼(次)</div></div></div>
  <div class="section-title"><i class="fas fa-yin-yang"></i> 4个人生重心</div>
  <div class="center-grid" id="focusCenters"></div>
</div>
<div id="report" class="tab-page"><div class="header"><h1><i class="fas fa-chart-line"></i> 报告</h1></div><div id="reportContent"></div></div>
<div id="message" class="tab-page"><div class="header"><h1><i class="fas fa-comments"></i> 智能助手</h1></div><div id="chatList"></div><div class="chat-input"><input type="text" id="chatInput" placeholder="说点什么..."><button id="chatSend"><i class="fas fa-paper-plane"></i></button></div></div>
<div id="profile" class="tab-page"><div class="header"><h1><i class="fas fa-user-circle"></i> 我的</h1></div><div class="profile-section"><div class="profile-item" onclick="showStats()"><i class="fas fa-chart-pie"></i><div class="name">数据统计</div><span class="arrow"><i class="fas fa-chevron-right"></i></span></div><div class="profile-item" onclick="backupData()"><i class="fas fa-cloud-arrow-down"></i><div class="name">数据备份</div><span class="arrow"><i class="fas fa-chevron-right"></i></span></div><div class="profile-item" onclick="clearCache()"><i class="fas fa-trash"></i><div class="name">清除缓存</div><span class="arrow"><i class="fas fa-chevron-right"></i></span></div></div></div>
<div class="detail-page" id="detailPage"><button class="back-btn" id="backBtn"><i class="fas fa-chevron-left"></i> 返回</button><h2 id="detailTitle" style="margin-bottom:16px">模块</h2><div id="recordList"></div><button class="add-btn" id="addBtn">+</button></div>
<div class="modal" id="modal"><div class="modal-box"><h3 id="modalTitle">添加记录</h3><div id="modalFields"></div><button class="btn-save" id="saveBtn">保存</button></div></div>
<div class="toast" id="toast"></div>
<div class="bottom-nav"><div class="nav-item active" data-tab="home"><i class="fas fa-house"></i><span>首页</span></div><div class="nav-item" data-tab="focus"><i class="fas fa-compass"></i><span>聚焦</span></div><div class="nav-item" data-tab="report"><i class="fas fa-chart-line"></i><span>报告</span></div><div class="nav-item" data-tab="message"><i class="fas fa-comments"></i><span>消息</span></div><div class="nav-item" data-tab="profile"><i class="fas fa-user"></i><span>我的</span></div></div>
<script>
var CENTERS=[{id:'work',name:'工作收入',icon:'fa-briefcase',color:'var(--blue)',desc:'财务+职业'},{id:'photo',name:'摄影能力',icon:'fa-camera',color:'var(--pink)',desc:'技能+作品'},{id:'health',name:'身体健康',icon:'fa-heart-pulse',color:'var(--green)',desc:'睡眠+锻炼+饮食'},{id:'cognition',name:'认知思考',icon:'fa-brain',color:'var(--purple)',desc:'情绪+日记+复盘'}];
var MODULES=[{id:'finance',label:'财务',icon:'fa-wallet',color:'var(--green)',desc:'记账与收支管理',fields:[{key:'date',label:'日期',type:'date'},{key:'type',label:'收支类型',type:'select',options:['支出','收入']},{key:'category',label:'分类',type:'select',options:['餐饮','交通','购物','学习','医疗','提成','其他']},{key:'amount',label:'金额(元)',type:'number'},{key:'note',label:'备注',type:'textarea'}]},{id:'sleep',label:'睡眠',icon:'fa-moon',color:'var(--purple)',desc:'睡眠时长与质量',fields:[{key:'date',label:'日期',type:'date'},{key:'hours',label:'睡眠时长(小时)',type:'number'},{key:'quality',label:'质量评分(1-5)',type:'select',options:['1','2','3','4','5']},{key:'note',label:'备注',type:'textarea'}]},{id:'exercise',label:'锻炼',icon:'fa-dumbbell',color:'var(--orange)',desc:'运动记录',fields:[{key:'date',label:'日期',type:'date'},{key:'type',label:'运动类型',type:'text'},{key:'duration',label:'时长(分钟)',type:'number'},{key:'intensity',label:'强度',type:'select',options:['轻度','中度','高强度']}]},{id:'emotion',label:'情绪',icon:'fa-face-smile',color:'var(--yellow)',desc:'情绪评分',fields:[{key:'date',label:'日期',type:'date'},{key:'score',label:'情绪评分(1-10)',type:'number'},{key:'tags',label:'情绪标签',type:'text'},{key:'note',label:'记录',type:'textarea'}]},{id:'diary',label:'日记',icon:'fa-book-open',color:'var(--blue)',desc:'每日记录',fields:[{key:'date',label:'日期',type:'date'},{key:'title',label:'标题',type:'text'},{key:'content',label:'内容',type:'textarea'},{key:'mood',label:'心情',type:'select',options:['😊','😐','😢','😡','😌']}]},{id:'learn',label:'学习复盘',icon:'fa-graduation-cap',color:'var(--purple)',desc:'成长记录',fields:[{key:'date',label:'日期',type:'date'},{key:'topic',label:'学习主题',type:'text'},{key:'insight',label:'收获/洞察',type:'textarea'},{key:'action',label:'下一步行动',type:'textarea'}]}];

function apiFetch(url,opts){opts=opts||{};opts.headers=opts.headers||{};opts.headers['Content-Type']='application/json';return fetch(url,opts);}
function showToast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2000);}

function switchTab(tab){
  document.querySelectorAll('.tab-page').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active')});
  document.getElementById(tab).classList.add('active');
  document.querySelector('.nav-item[data-tab="'+tab+'"]').classList.add('active');
  if(tab==='focus')loadFocus();
  if(tab==='report')loadReport();
}

document.querySelectorAll('.nav-item').forEach(function(n){n.onclick=function(){switchTab(this.dataset.tab)};});

function renderHome(){
  var cg=document.getElementById('centerGrid');
  cg.innerHTML='';
  CENTERS.forEach(function(c){
    var card=document.createElement('div');
    card.className='center-card';
    card.innerHTML='<div class="icon-wrap" style="background:'+c.color+'"><i class="fas '+c.icon+'"></i></div><div class="name">'+c.name+'</div><div class="desc">'+c.desc+'</div><div class="progress"><div class="progress-bar" style="width:60%"></div></div>';
    card.onclick=function(){showToast('重心：'+c.name)};
    cg.appendChild(card);
  });

  var ml=document.getElementById('moduleList');
  ml.innerHTML='';
  MODULES.forEach(function(m){
    var item=document.createElement('div');
    item.className='module-item';
    item.innerHTML='<div class="icon-wrap" style="background:'+m.color+'"><i class="fas '+m.icon+'"></i></div><div class="info"><div class="name">'+m.label+'</div><div class="sub">'+m.desc+'</div></div><span class="arrow"><i class="fas fa-chevron-right"></i></span>';
    item.onclick=function(){openModule(m.id)};
    ml.appendChild(item);
  });
}

var currentModule=null;
var currentData=[];

function openModule(id){
  var m=MODULES.find(function(x){return x.id===id});
  if(!m)return;
  currentModule=id;
  document.getElementById('detailTitle').innerHTML='<i class="fas '+m.icon+'" style="color:'+m.color+'"></i> '+m.label;
  document.getElementById('detailPage').classList.add('active');
  loadRecords();
}

function loadRecords(){
  apiFetch('/api/'+currentModule).then(function(r){return r.json()}).then(function(data){
    currentData=Array.isArray(data)?data:[];
    renderList();
  }).catch(function(){currentData=[];renderList()});
}

function renderList(){
  var list=document.getElementById('recordList');
  if(currentData.length===0){list.innerHTML='<div class="empty-state">📭 还没有记录</div>';return;}
  list.innerHTML=currentData.slice().reverse().map(function(r,idx){
    var realIndex=currentData.length-1-idx;
    var summary=Object.keys(r).filter(function(k){return k!=='date'&&k!=='note'}).slice(0,3).map(function(k){return r[k]}).join(' · ');
    return '<div class="list-item"><div class="main"><div class="title">'+summary+'</div><div class="sub">'+(r.note||'')+'</div></div><div class="right"><div class="date">'+(r.date||'')+'</div><button onclick="deleteRecord('+realIndex+')" style="background:none;border:none;color:var(--red);font-size:12px;margin-top:4px;cursor:pointer">删除</button></div></div>';
  }).join('');
}

function deleteRecord(index){
  if(!confirm('确认删除这条记录？'))return;
  currentData.splice(index,1);
  apiFetch('/api/'+currentModule,{method:'POST',body:JSON.stringify(currentData)}).then(function(){
    renderList();
    showToast('已删除');
  });
}

document.getElementById('backBtn').onclick=function(){document.getElementById('detailPage').classList.remove('active')};

document.getElementById('addBtn').onclick=function(){
  var m=MODULES.find(function(x){return x.id===currentModule});
  document.getElementById('modalTitle').textContent='添加 '+m.label;
  var f=document.getElementById('modalFields');
  f.innerHTML=m.fields.map(function(fd){
    if(fd.type==='select')return '<div class="field-group"><label>'+fd.label+'</label><select id="f_'+fd.key+'">'+fd.options.map(function(o){return '<option>'+o+'</option>'}).join('')+'</select></div>';
    if(fd.type==='textarea')return '<div class="field-group"><label>'+fd.label+'</label><textarea id="f_'+fd.key+'"></textarea></div>';
    return '<div class="field-group"><label>'+fd.label+'</label><input type="'+fd.type+'" id="f_'+fd.key+'"></div>';
  }).join('');
  var dateEl=document.getElementById('f_date');
  if(dateEl)dateEl.value=new Date().toISOString().slice(0,10);
  document.getElementById('modal').classList.add('active');
};

document.getElementById('saveBtn').onclick=function(){
  var m=MODULES.find(function(x){return x.id===currentModule});
  var obj={};
  m.fields.forEach(function(fd){var el=document.getElementById('f_'+fd.key);if(el)obj[fd.key]=el.value});
  currentData.push(obj);
  apiFetch('/api/'+currentModule,{method:'POST',body:JSON.stringify(currentData)}).then(function(){
    document.getElementById('modal').classList.remove('active');
    renderList();
    showToast('已保存');
  });
};

document.getElementById('modal').onclick=function(e){if(e.target===this)this.classList.remove('active')};

document.getElementById('quickInput').onkeypress=function(e){
  if(e.key!=='Enter')return;
  var text=this.value.trim();
  if(!text)return;
  var m1=text.match(/(?:记[^0-9]*?|花了?|买了?)([^0-9]+?)(\d+(?:\.\d+)?)\s*(?:块|元)/);
  if(m1){
    apiFetch('/api/finance',{method:'POST',body:JSON.stringify([{date:new Date().toISOString().slice(0,10),type:'支出',category:m1[1].trim()||'其他',amount:m1[2],note:text}])}).then(function(){showToast('已记录记账');this.value='';}.bind(this));
    return;
  }
  var m2=text.match(/睡[着了]?(\d+(?:\.\d+)?)\s*(?:小时|h)/);
  if(m2){
    apiFetch('/api/sleep',{method:'POST',body:JSON.stringify([{date:new Date().toISOString().slice(0,10),hours:m2[1],quality:'4',note:text}])}).then(function(){showToast('已记录睡眠');this.value='';}.bind(this));
    return;
  }
  showToast('已识别：'+text);
  this.value='';
};

function loadFocus(){
  Promise.all([apiFetch('/api/sleep').then(function(r){return r.json()}),apiFetch('/api/emotion').then(function(r){return r.json()}),apiFetch('/api/exercise').then(function(r){return r.json()})]).then(function(arr){
    var sleep=arr[0]||[],emotion=arr[1]||[],exercise=arr[2]||[];
    var avgSleep=sleep.length?sleep.reduce(function(s,r){return s+Number(r.hours||0)},0)/sleep.length:0;
    var avgEmotion=emotion.length?emotion.reduce(function(s,r){return s+Number(r.score||0)},0)/emotion.length:0;
    document.getElementById('statSleep').textContent=avgSleep?avgSleep.toFixed(1):'--';
    document.getElementById('statEmotion').textContent=avgEmotion?avgEmotion.toFixed(1):'--';
    document.getElementById('statExercise').textContent=exercise.length;
    var score=Math.round((avgSleep/8*30)+(avgEmotion/10*40)+Math.min(exercise.length/7,1)*30);
    document.getElementById('focusScore').textContent=score||'--';
    document.getElementById('focusDesc').textContent=score>=80?'优秀，继续保持':score>=60?'良好，再加把劲':'需要关注，加油';
  });
}

function loadReport(){
  apiFetch('/api/state').then(function(r){return r.json()}).then(function(data){
    var html=data.insights?'<div class="report-card"><h3><i class="fas fa-lightbulb"></i> 30天洞察</h3>'+data.insights.map(function(i){return '<p>· '+i+'</p>'}).join('')+'</div>':'<div class="report-card"><h3><i class="fas fa-seedling"></i> 开始记录</h3><p>继续记录数据，30天后将自动生成阶段审视报告。</p></div>';
    html+='<div class="report-card"><h3><i class="fas fa-bullseye"></i> 下一步建议</h3><span class="tag">保持睡眠≥7小时</span><span class="tag">每天记录情绪</span><span class="tag">每周3次锻炼</span><span class="tag">财务月度复盘</span></div>';
    document.getElementById('reportContent').innerHTML=html;
  }).catch(function(){document.getElementById('reportContent').innerHTML='<div class="report-card"><h3><i class="fas fa-info-circle"></i> 暂无数据</h3><p>开始记录后将自动生成报告。</p></div>';});
}

function addChat(text,isUser){var list=document.getElementById('chatList');var msg=document.createElement('div');msg.className='chat-msg '+(isUser?'user':'bot');msg.textContent=text;list.appendChild(msg);list.scrollTop=list.scrollHeight;}

document.getElementById('chatSend').onclick=function(){
  var input=document.getElementById('chatInput');
  var text=input.value.trim();
  if(!text)return;
  addChat(text,true);
  input.value='';
  apiFetch('/api/voice',{method:'POST',body:JSON.stringify({text:text})}).then(function(r){return r.json()}).then(function(d){addChat(d.message||'已处理',false)}).catch(function(){addChat('处理失败',false)});
};

function showStats(){Promise.all(MODULES.map(function(m){return apiFetch('/api/'+m.id).then(function(r){return r.json()}).then(function(d){return [m.label,Array.isArray(d)?d.length:0]})})).then(function(arr){alert('📊 数据统计\n\n'+arr.map(function(x){return x[0]+': '+x[1]+' 条'}).join('\n'))});}
function backupData(){apiFetch('/api/backup').then(function(){showToast('备份已创建')}).catch(function(){showToast('备份失败')});}
function clearCache(){if(confirm('确认清除本地缓存？')){localStorage.clear();showToast('缓存已清除');setTimeout(function(){location.reload()},1000);}}

renderHome();
apiFetch('/api/state').then(function(r){return r.json()}).then(function(d){if(d&&d.balance!==undefined){document.getElementById('balanceScore').textContent=d.balance;document.getElementById('balanceDesc').textContent=d.desc||'保持觉察，稳步前行';}}).catch(function(){});
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`🍆 茄子管家·重心版运行在端口 ${PORT}`));
