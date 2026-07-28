const fs = require('fs');
const path = require('path');

const root = './eggplant-butler-ultimate';
const dirs = ['backend', 'frontend', 'data', 'scripts', '.github/workflows'];
dirs.forEach(d => fs.mkdirSync(path.join(root, d), { recursive: true }));

console.log('✅ 目录创建完成');
console.log('📦 请继续执行第2批代码（追加前端+后端完整内容）');

// ============================================================
// 第2批-第1部分：前端HTML（样式 + 页面结构 + 34个模块数据）
// ============================================================
const frontendHTML = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>茄子管家·终极版</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    :root {
      --primary: #5B6ABF;
      --primary-light: #7B8CDE;
      --primary-dark: #4A56A8;
      --bg: #F0F2F8;
      --card-bg: #FFFFFF;
      --text: #1A1A2E;
      --text-secondary: #6B7280;
      --border: #E5E7EB;
      --shadow: 0 2px 12px rgba(91,106,191,0.08);
      --radius: 16px;
      --success: #22C55E;
      --warning: #F59E0B;
      --danger: #EF4444;
      --gentle: #EC4899;
    }
    body { background:var(--bg); padding:12px; padding-bottom:80px; color:var(--text); }

    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; padding:0 4px; }
    .header h1 { font-size:22px; font-weight:700; color:var(--primary); letter-spacing:0.5px; }
    .header h1 span { color:var(--text); }
    .voice-btn { background:var(--primary); color:white; border:none; width:48px; height:48px; border-radius:50%; font-size:20px; box-shadow:0 4px 16px rgba(91,106,191,0.35); cursor:pointer; transition:0.2s; }
    .voice-btn:active { transform:scale(0.92); }

    .scene-tips { background:var(--card-bg); border-radius:var(--radius); padding:14px 18px; margin-bottom:16px; box-shadow:var(--shadow); border-left:4px solid var(--primary); font-size:14px; color:var(--text-secondary); }
    .scene-tips strong { color:var(--text); }

    .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
    .card { background:var(--card-bg); border-radius:var(--radius); padding:14px 4px; text-align:center; box-shadow:var(--shadow); cursor:pointer; transition:0.15s; border:1px solid transparent; }
    .card:active { transform:scale(0.94); background:#f5f6fa; border-color:var(--primary-light); }
    .card .icon { font-size:26px; margin-bottom:2px; }
    .card .name { font-size:11px; color:var(--text-secondary); font-weight:500; }
    .card .badge { font-size:9px; background:var(--primary); color:#fff; border-radius:10px; padding:1px 8px; display:inline-block; margin-top:2px; }

    .detail-page { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:var(--bg); z-index:100; overflow-y:auto; padding:12px; }
    .detail-page.active { display:block; }
    .back-btn { background:none; border:none; font-size:26px; cursor:pointer; margin-bottom:6px; color:var(--text); display:flex; align-items:center; gap:6px; }
    .back-btn span { font-size:15px; font-weight:500; }

    .dashboard { background:var(--card-bg); border-radius:var(--radius); padding:16px; margin-bottom:12px; box-shadow:var(--shadow); }
    .dash-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:8px; }
    .dash-item { text-align:center; background:#f8f9fc; border-radius:12px; padding:10px 4px; }
    .dash-item .num { font-size:20px; font-weight:700; color:var(--primary); }
    .dash-item .label { font-size:11px; color:var(--text-secondary); margin-top:2px; }

    .view-tabs { display:flex; gap:6px; margin-bottom:12px; background:var(--card-bg); border-radius:12px; padding:4px; box-shadow:var(--shadow); }
    .view-tab { flex:1; text-align:center; padding:8px 0; border-radius:8px; font-size:13px; font-weight:500; color:var(--text-secondary); cursor:pointer; transition:0.2s; }
    .view-tab.active { background:var(--primary); color:white; }

    .list-wrapper { overflow:hidden; border-radius:12px; margin-bottom:6px; background:var(--card-bg); box-shadow:var(--shadow); position:relative; }
    .list-item { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:var(--card-bg); transition:0.2s; cursor:pointer; position:relative; z-index:2; touch-action:pan-y; }
    .list-item .main { display:flex; flex-direction:column; gap:2px; flex:1; }
    .list-item .main .title { font-size:14px; color:var(--text); font-weight:500; }
    .list-item .main .sub { font-size:11px; color:var(--text-secondary); display:flex; gap:6px; flex-wrap:wrap; }
    .list-item .main .sub .tag { background:#f0f1f5; padding:0 8px; border-radius:4px; color:var(--text-secondary); }
    .list-item .right { text-align:right; min-width:60px; }
    .list-item .right .amount { font-weight:700; font-size:15px; }
    .list-item .right .amount.expense { color:var(--danger); }
    .list-item .right .amount.income { color:var(--success); }
    .list-item .right .date { font-size:10px; color:var(--text-secondary); }

    .list-actions { position:absolute; top:0; right:-120px; width:120px; height:100%; display:flex; border-radius:12px; transition:0.25s; }
    .list-actions .action-btn { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:white; font-size:11px; background:transparent; border:none; }
    .list-actions .action-btn.edit { background:#3B82F6; }
    .list-actions .action-btn.delete { background:var(--danger); }

    .add-btn { position:fixed; bottom:24px; right:24px; background:var(--primary); color:white; border:none; width:58px; height:58px; border-radius:50%; font-size:26px; box-shadow:0 4px 20px rgba(91,106,191,0.4); cursor:pointer; z-index:200; transition:0.2s; }
    .add-btn:active { transform:scale(0.92); }

    .modal { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.45); z-index:300; justify-content:center; align-items:center; padding:16px; }
    .modal.active { display:flex; }
    .modal-box { background:var(--card-bg); width:100%; max-width:440px; border-radius:20px; padding:24px; max-height:80vh; overflow-y:auto; }
    .modal-box h3 { font-size:18px; margin-bottom:16px; color:var(--text); }
    .modal-box .field-group { margin-bottom:14px; }
    .modal-box .field-group label { display:block; font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:3px; }
    .modal-box .field-group input, .modal-box .field-group select, .modal-box .field-group textarea { width:100%; padding:11px 14px; border:1px solid var(--border); border-radius:10px; font-size:14px; background:#fafbfc; transition:0.2s; }
    .modal-box .field-group input:focus, .modal-box .field-group select:focus, .modal-box .field-group textarea:focus { border-color:var(--primary); outline:none; background:white; }
    .modal-box .field-group textarea { min-height:50px; resize:vertical; }
    .expand-toggle { color:var(--primary); font-size:13px; cursor:pointer; padding:6px 0; display:inline-block; }
    .expand-area { display:none; margin-top:10px; border-top:1px dashed var(--border); padding-top:10px; }
    .expand-area.open { display:block; }
    .modal-box .btn-save { background:var(--primary); color:white; border:none; padding:13px; border-radius:12px; width:100%; font-size:15px; font-weight:600; cursor:pointer; margin-top:8px; transition:0.2s; }
    .modal-box .btn-save:active { transform:scale(0.98); }

    .empty-state { text-align:center; color:var(--text-secondary); padding:40px 0; font-size:14px; }
    .toast { position:fixed; bottom:100px; left:50%; transform:translateX(-50%); background:#1A1A2E; color:white; padding:10px 22px; border-radius:12px; font-size:13px; z-index:500; opacity:0; transition:0.3s; pointer-events:none; }
    .toast.show { opacity:1; }

    .context-menu { display:none; position:fixed; top:0; left:0; right:0; bottom:0; z-index:400; background:rgba(0,0,0,0.3); justify-content:center; align-items:center; }
    .context-menu.active { display:flex; }
    .context-menu .menu-box { background:var(--card-bg); border-radius:20px; padding:16px; width:260px; }
    .context-menu .menu-box .item { padding:12px 0; border-bottom:1px solid var(--border); text-align:center; font-size:15px; cursor:pointer; color:var(--text); }
    .context-menu .menu-box .item:last-child { border-bottom:none; }
    .context-menu .menu-box .item.danger { color:var(--danger); }

    .insight-card { background:#f8f9fc; border-radius:12px; padding:12px 16px; margin-bottom:8px; border-left:4px solid var(--primary); font-size:13px; color:var(--text-secondary); display:flex; align-items:center; gap:8px; }
    .insight-card .icon { font-size:18px; }
    .insight-card.warning { border-left-color:var(--warning); background:#fffbeb; }
    .insight-card.success { border-left-color:var(--success); background:#f0fdf4; }
    .insight-card.gentle { border-left-color:var(--gentle); background:#fdf2f8; }

    @media (max-width:420px) { .grid { grid-template-columns:repeat(4,1fr); gap:6px; } .card { padding:10px 2px; } .card .icon { font-size:22px; } .card .name { font-size:10px; } }
  </style>
</head>
<body>
  <div id="mainApp">
    <div class="header">
      <h1>🍆 <span>茄子管家</span></h1>
      <button class="voice-btn" id="voiceBtn">🎤</button>
    </div>
    <div class="scene-tips" id="sceneTips">🌅 早安！今天也要元气满满哦。</div>
    <div class="grid" id="moduleGrid"></div>
  </div>

  <div class="detail-page" id="detailPage">
    <div class="back-btn" id="backBtn"><span>‹ 返回</span></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <h2 id="detailTitle" style="font-size:19px;color:var(--text);">模块</h2>
      <span id="recordCount" style="font-size:12px;color:var(--text-secondary);">0 条</span>
    </div>
    <div class="dashboard" id="dashboardArea">
      <div style="font-size:12px;font-weight:600;color:var(--text-secondary);">📊 概览</div>
      <div class="dash-grid" id="dashGrid">
        <div class="dash-item"><div class="num" id="dash1">-</div><div class="label">总计</div></div>
        <div class="dash-item"><div class="num" id="dash2">-</div><div class="label">平均</div></div>
        <div class="dash-item"><div class="num" id="dash3">-</div><div class="label">最高</div></div>
      </div>
    </div>
    <div id="insightArea"></div>
    <div class="view-tabs" id="viewTabs">
      <div class="view-tab active" data-view="day">日</div>
      <div class="view-tab" data-view="week">周</div>
      <div class="view-tab" data-view="month">月</div>
      <div class="view-tab" data-view="year">年</div>
    </div>
    <div id="recordList"></div>
    <button class="add-btn" id="addRecordBtn">+</button>
  </div>

  <div class="modal" id="modal">
    <div class="modal-box">
      <h3 id="modalTitle">添加记录</h3>
      <div id="modalFields"></div>
      <div class="expand-toggle" id="expandToggle">▼ 展开更多字段</div>
      <div class="expand-area" id="expandArea"></div>
      <button class="btn-save" id="saveRecord">保存</button>
    </div>
  </div>

  <div class="context-menu" id="contextMenu">
    <div class="menu-box">
      <div class="item" id="ctxEdit">✏️ 编辑</div>
      <div class="item" id="ctxCopy">📋 复制</div>
      <div class="item danger" id="ctxDelete">🗑️ 删除</div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    // ============================================================
    // 34个模块完整元数据（全部定制）
    // ============================================================
    const modules = [
      { id: 'finance', label: '财务管理', icon: '💰', base: [
        {key:'date',label:'日期',type:'date',default:new Date().toISOString().slice(0,10)},
        {key:'type',label:'收支类型',type:'select',options:['支出','收入','退款']},
        {key:'category',label:'分类',type:'select',options:['餐饮','交通','购物','娱乐','学习','医疗','人情','底薪','提成','其他']},
        {key:'amount',label:'金额',type:'number',placeholder:'请输入金额'}
      ], expand: [
        {key:'merchant',label:'商家/店铺',type:'text',placeholder:'请输入商家'},
        {key:'payment',label:'支付方式',type:'select',options:['微信','支付宝','现金','信用卡','银行卡']},
        {key:'intent',label:'消费意图',type:'select',options:['生存必需','社交应酬','投资自己','享乐消费','意外支出']},
        {key:'isCommission',label:'是否提成收入',type:'select',options:['否','是']},
        {key:'project',label:'关联项目',type:'text',placeholder:'输入项目名称'},
        {key:'note',label:'备注',type:'textarea',placeholder:'详细记录...'}
      ], dash: (d) => {
        const i = d.filter(r=>r.type==='收入').reduce((s,r)=>s+Number(r.amount||0),0);
        const e = d.filter(r=>r.type==='支出').reduce((s,r)=>s+Number(r.amount||0),0);
        return { d1:{label:'结余',val:(i-e)+'元'}, d2:{label:'总收入',val:i+'元'}, d3:{label:'总支出',val:e+'元'} };
      }},
      { id: 'sleep', label: '睡眠实验室', icon: '😴', base: [
        {key:'date',label:'日期',type:'date',default:new Date().toISOString().slice(0,10)},
        {key:'sleepHours',label:'睡眠时长(h)',type:'number',placeholder:'如 7.5'},
        {key:'feeling',label:'晨起感受',type:'select',options:['1-很差','2-较差','3-一般','4-较好','5-很棒']}
      ], expand: [
        {key:'wakeCount',label:'醒来次数',type:'number',placeholder:'0'},
        {key:'dream',label:'梦境记录',type:'text',placeholder:'记得的梦境内容'},
        {key:'note',label:'备注',type:'textarea',placeholder:'其他睡眠情况...'}
      ], dash: (d) => {
        const avg = d.length ? Math.round(d.reduce((s,r)=>s+Number(r.sleepHours||0),0)/d.length*10)/10 : 0;
        const best = d.length ? Math.max(...d.map(r=>Number(r.sleepHours||0))) : 0;
        return { d1:{label:'平均时长',val:avg+'h'}, d2:{label:'最长',val:best+'h'}, d3:{label:'记录天数',val:d.length} };
      }},
      { id: 'menstrual', label: '经期记录', icon: '🌸', base: [
        {key:'date',label:'日期',type:'date',default:new Date().toISOString().slice(0,10)},
        {key:'cycleDay',label:'经期第几天',type:'number',placeholder:'1-7'},
        {key:'flow',label:'经量',type:'select',options:['少','中','多']}
      ], expand: [
        {key:'pain',label:'痛经程度',type:'select',options:['1-无','2-轻微','3-中等','4-较重','5-严重']},
        {key:'mood',label:'情绪标签',type:'select',options:['平静','烦躁','低落','敏感','正常']},
        {key:'note',label:'备注',type:'textarea',placeholder:'其他情况...'}
      ], dash: (d) => {
        const last = d.length ? d[d.length-1] : null;
        return { d1:{label:'当前周期',val:last ? '第'+last.cycleDay+'天' : '-'}, d2:{label:'本月记录',val:d.length}, d3:{label:'规律性',val:d.length>3 ? '规律' : '记录中'} };
      }},
      { id: 'supplement', label: '营养补充站', icon: '💊', base: [
        {key:'date',label:'日期',type:'date',default:new Date().toISOString().slice(0,10)},
        {key:'name',label:'补充剂名称',type:'text',placeholder:'维C/蛋白粉/钙片'},
        {key:'taken',label:'是否补充',type:'select',options:['是','否']}
      ], expand: [
        {key:'dosage',label:'剂量',type:'text',placeholder:'如 500mg'},
        {key:'brand',label:'品牌',type:'text',placeholder:'品牌名称'},
        {key:'note',label:'备注',type:'textarea',placeholder:'补充后感受...'}
      ], dash: (d) => {
        const recent = d.filter(r=>r.taken==='是').slice(-7).length;
        return { d1:{label:'近7天补充',val:recent+'次'}, d2:{label:'总记录',val:d.length}, d3:{label:'坚持天数',val:d.filter(r=>r.taken==='是').length} };
      }},
      { id: 'habit', label: '习惯打卡', icon: '✅', base: [
        {key:'date',label:'日期',type:'date',default:new Date().toISOString().slice(0,10)},
        {key:'name',label:'习惯名称',type:'text',placeholder:'如：晨跑'},
        {key:'done',label:'完成状态',type:'select',options:['已完成','未完成']}
      ], expand: [
        {key:'duration',label:'时长(分钟)',type:'number',placeholder:'0'},
        {key:'difficulty',label:'难度自评',type:'select',options:['⭐简单','⭐⭐一般','⭐⭐⭐有挑战','⭐⭐⭐⭐很难','⭐⭐⭐⭐⭐极限']},
        {key:'failReason',label:'未完成原因',type:'select',options:['-','天气','身体不适','加班太忙','情绪低落','意志力不足','其他']},
        {key:'feel',label:'完成感受',type:'textarea',placeholder:'记录感受...'}
      ], dash: (d) => {
        const done = d.filter(r=>r.done==='已完成').length;
        const total = d.length||1;
        return { d1:{label:'完成率',val:Math.round(done/total*100)+'%'}, d2:{label:'已完成',val:done}, d3:{label:'总次数',val:total} };
      }},
      { id: 'emotion', label: '情绪管理', icon: '😊', base: [
        {key:'date',label:'日期',type:'date',default:new Date().toISOString().slice(0,10)},
        {key:'score',label:'评分(1-10)',type:'number',placeholder:'1-10'},
        {key:'tags',label:'情绪标签',type:'text',placeholder:'开心/焦虑/平静'}
      ], expand: [
        {key:'trigger',label:'触发因素',type:'text',placeholder:'工作/人际/健康等'},
        {key:'note',label:'备注',type:'textarea',placeholder:'详细记录...'}
      ], dash: (d) => {
        const avg = d.length ? Math.round(d.reduce((s,r)=>s+Number(r.score||0),0)/d.length*10)/10 : 0;
        const recent = d.length ? d[d.length-1].score : '-';
        return { d1:{label:'平均分',val:avg}, d2:{label:'今日',val:recent}, d3:{label:'记录数',val:d.length} };
      }},
      { id: 'mental_health', label: '心理健康', icon: '🧠', base: [
        {key:'date',label:'日期',type:'date',default:new Date().toISOString().slice(0,10)},
        {key:'phq9Score',label:'PHQ-9得分',type:'number',placeholder:'0-27'},
        {key:'gad7Score',label:'GAD-7得分',type:'number',placeholder:'0-21'}
      ], expand: [
        {key:'stressLevel',label:'压力自评',type:'select',options:['1-很低','2-较低','3-中等','4-较高','5-很高']},
        {key:'coping',label:'应对方式',type:'text',placeholder:'运动/倾诉/休息'},
        {key:'note',label:'备注',type:'textarea',placeholder:'详细记录...'}
      ], dash: (d) => {
        const last = d.length ? d[d.length-1] : null;
        return { d1:{label:'PHQ-9',val:last ? last.phq9Score : '-'}, d2:{label:'GAD-7',val:last ? last.gad7Score : '-'}, d3:{label:'记录数',val:d.length} };
      }}
    ];
    // 继续添加剩余模块到 modules 数组...
    // 由于篇幅限制，剩余模块定义在下一批追加
    console.log('✅ 第1部分加载完成，共 ' + modules.length + ' 个模块');
  <\/script>
</body>
</html>`;

fs.writeFileSync(path.join(root, 'frontend/index.html'), frontendHTML);
console.log('✅ 第2批-第1部分完成：前端框架已写入');
console.log('📦 请继续执行第2批-第2部分（追加剩余模块和交互逻辑）');
