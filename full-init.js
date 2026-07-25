const fs = require('fs');
const path = require('path');

// ===================== 创建目录结构 =====================
const root = './eggplant-butler-final';
const dirs = ['backend', 'frontend', 'data', 'scripts', '.github/workflows'];
dirs.forEach(d => fs.mkdirSync(path.join(root, d), { recursive: true }));

// ===================== 1. 生成后端 server.js =====================
const serverJS = `
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

const DATA_DIR = path.join(__dirname, '../data');

// ---------- 通用存储 API ----------
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

// ---------- 高级洞察引擎 (含情绪熔断) ----------
app.get('/api/insights/:module', (req, res) => {
  const module = req.params.module;
  const file = path.join(DATA_DIR, module + '.json');
  let data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  
  // 读取情绪数据，判断是否触发熔断（低情绪时不发批判性提醒）
  const emotionFile = path.join(DATA_DIR, 'emotion.json');
  let lastEmotion = 5;
  if (fs.existsSync(emotionFile)) {
    const emotions = JSON.parse(fs.readFileSync(emotionFile, 'utf8'));
    if (emotions.length > 0) lastEmotion = emotions[emotions.length-1].score || 5;
  }
  const isMeltdown = lastEmotion <= 3;

  let insights = [];
  if (module === 'finance' && !isMeltdown) {
    const total = data.reduce((s, r) => s + (r.type === 'expense' ? -r.amount : r.amount), 0);
    if (total < 0) insights.push({ type: 'warning', msg: '本月已超支 ' + Math.abs(total) + ' 元，建议复盘' });
    else insights.push({ type: 'info', msg: '本月结余 ' + total + ' 元，表现优秀！' });
  } else if (module === 'habit') {
    const done = data.filter(d => d.done).length;
    const total = data.length || 1;
    if (done/total < 0.3 && !isMeltdown) {
      insights.push({ type: 'warning', msg: '近期打卡率偏低，是不是遇到什么困难了？' });
    } else {
      insights.push({ type: 'info', msg: '打卡率 ' + Math.round(done/total*100) + '%，继续加油！' });
    }
  }
  if (isMeltdown) {
    insights = [{ type: 'gentle', msg: '今天心情似乎不太好，先休息一下吧，我明天再提醒你。' }];
  }
  res.json({ insights });
});

// ---------- 自然语言语音指令 ----------
app.post('/api/voice', (req, res) => {
  const text = req.body.text || '';
  let result = { action: 'unknown', message: '没听清，能再说一遍吗？' };

  // 1. 快速记账：记一笔吃饭50块
  const match1 = text.match(/记一笔(.*?)(\\d+)块/);
  if (match1) {
    result = { 
      action: 'add_record', 
      module: 'finance', 
      data: { category: match1[1].trim(), amount: -parseInt(match1[2]), type: 'expense', date: new Date().toISOString().slice(0,10) },
      message: '已记录：' + match1[1] + ' 消费 ' + match1[2] + ' 元'
    };
  }
  // 2. 记录心情：今天心情8分
  const match2 = text.match(/心情(\\d+)分/);
  if (match2) {
    result = {
      action: 'add_record',
      module: 'emotion',
      data: { date: new Date().toISOString().slice(0,10), score: parseInt(match2[1]), note: '语音录入' },
      message: '已记录今日心情：' + match2[1] + ' 分'
    };
  }
  // 3. 添加字段指令：在财务管理增加"商家"字段
  const match3 = text.match(/在(.+)增加[""](.+)[""]字段/);
  if (match3) {
    const moduleName = match3[1].trim();
    const fieldName = match3[2].trim();
    result = {
      action: 'add_field',
      module: moduleName,
      field: fieldName,
      message: '已记录需求：请在 ' + moduleName + ' 增加 "' + fieldName + '" 字段（需重启生效）'
    };
  }
  res.json(result);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0-final' }));

app.listen(PORT, '0.0.0.0', () => console.log('茄子管家运行在端口 ' + PORT));
`;
fs.writeFileSync(path.join(root, 'backend/server.js'), serverJS);

// ===================== 2. 生成前端 index.html =====================
const modulesMeta = [
  { id: 'finance', label: '财务管理', icon: '💰', fields: ['date','type','category','amount','merchant','note'] },
  { id: 'habit', label: '习惯打卡', icon: '✅', fields: ['date','habit','done','duration'] },
  { id: 'schedule', label: '动态日程', icon: '📅', fields: ['date','timeSlot','title','priority','status'] },
  { id: 'health', label: '健康管理', icon: '💪', fields: ['date','sleepHours','water','steps','weight'] },
  { id: 'pet', label: '宠物护理', icon: '🐱', fields: ['date','petName','eventType','note','nextDue'] },
  { id: 'emotion', label: '情绪管理', icon: '😊', fields: ['date','score','tags','note'] },
  { id: 'note', label: '闪念笔记', icon: '📝', fields: ['date','content','category','pinned'] },
  { id: 'contact', label: '社交人脉', icon: '👥', fields: ['name','phone','birthday','company','lastContact'] },
  { id: 'work', label: '工作引擎', icon: '💼', fields: ['date','client','task','duration','review'] },
  { id: 'reading', label: '阅读模块', icon: '📚', fields: ['bookName','author','pages','progress','rating'] },
  { id: 'wish', label: '愿望清单', icon: '🎯', fields: ['title','targetAmount','savedAmount','deadline'] },
  { id: 'happy', label: '小确幸', icon: '🎉', fields: ['date','content','category','image'] },
  { id: 'housework', label: '家务引擎', icon: '🧹', fields: ['task','area','frequency','lastDone','nextDue'] },
  { id: 'inventory', label: '库存买菜', icon: '🛒', fields: ['item','category','quantity','expiryDate'] },
  { id: 'weather', label: '天气助手', icon: '🌤️', fields: ['city','date','temp','condition','advice'] },
  { id: 'settings', label: '设置', icon: '⚙️', fields: ['theme','modules','backup'] },
  { id: 'infra', label: '生活基础设施', icon: '🏠', fields: ['type','name','expiryDate','phone','note'] }
];

const frontendHTML = `
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
  <title>茄子管家·进化体</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family: -apple-system, sans-serif; }
    body { background:#f5f7fa; padding:16px; padding-bottom:80px; }
    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
    .header h1 { font-size:24px; font-weight:700; }
    .voice-btn { background:#4F46E5; color:white; border:none; width:50px; height:50px; border-radius:50%; font-size:24px; box-shadow:0 4px 12px rgba(79,70,229,0.4); cursor:pointer; }
    .scene-tips { background:white; border-radius:16px; padding:16px; margin-bottom:20px; box-shadow:0 2px 8px rgba(0,0,0,0.05); border-left:4px solid #4F46E5; }
    .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; }
    .card { background:white; border-radius:16px; padding:16px; text-align:center; box-shadow:0 2px 8px rgba(0,0,0,0.05); cursor:pointer; transition:0.2s; }
    .card:active { transform:scale(0.95); }
    .card .icon { font-size:32px; margin-bottom:6px; }
    .card .name { font-size:13px; color:#333; }
    .detail-page { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:#f5f7fa; z-index:100; overflow-y:auto; padding:16px; }
    .detail-page.active { display:block; }
    .back-btn { background:none; border:none; font-size:24px; margin-bottom:16px; cursor:pointer; }
    .list-item { background:white; border-radius:12px; padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; box-shadow:0 1px 4px rgba(0,0,0,0.05); }
    .add-btn { position:fixed; bottom:20px; right:20px; background:#4F46E5; color:white; border:none; width:60px; height:60px; border-radius:50%; font-size:30px; box-shadow:0 4px 16px rgba(79,70,229,0.4); cursor:pointer; z-index:200; }
    .modal { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:300; justify-content:center; align-items:center; }
    .modal.active { display:flex; }
    .modal-box { background:white; width:90%; max-width:400px; border-radius:20px; padding:24px; }
    .modal-box input, .modal-box select { width:100%; padding:12px; margin-bottom:12px; border:1px solid #ddd; border-radius:8px; }
    .modal-box button { background:#4F46E5; color:white; border:none; padding:12px; border-radius:8px; width:100%; font-weight:600; }
    .insight-card { background:#FFF9E6; border-radius:12px; padding:12px; margin:12px 0; border-left:4px solid #F59E0B; }
  </style>
</head>
<body>
  <div id="mainApp">
    <div class="header">
      <h1>🍆 茄子管家</h1>
      <button class="voice-btn" id="voiceBtn">🎤</button>
    </div>
    
    <div class="scene-tips" id="sceneTips">
      ⏰ 早上好！今天有 3 件待办，记得查看日程。
    </div>

    <div class="grid" id="moduleGrid"></div>
  </div>

  <div class="detail-page" id="detailPage">
    <button class="back-btn" id="backBtn">‹ 返回</button>
    <h2 id="detailTitle">模块</h2>
    <div id="insightArea"></div>
    <div id="recordList"></div>
    <button class="add-btn" id="addRecordBtn">+</button>
  </div>

  <div class="modal" id="modal">
    <div class="modal-box">
      <h3 id="modalTitle">添加记录</h3>
      <div id="modalFields"></div>
      <button id="saveRecord">保存</button>
    </div>
  </div>

  <script>
    const modules = ` + JSON.stringify(modulesMeta) + `;
    let currentModule = null;
    let currentData = [];

    const grid = document.getElementById('moduleGrid');
    modules.forEach(m => {
      const div = document.createElement('div');
      div.className = 'card';
      div.innerHTML = '<div class="icon">' + m.icon + '</div><div class="name">' + m.label + '</div>';
      div.onclick = () => openModule(m.id);
      grid.appendChild(div);
    });

    async function openModule(id) {
      currentModule = id;
      const meta = modules.find(m => m.id === id);
      document.getElementById('detailTitle').textContent = meta.icon + ' ' + meta.label;
      document.getElementById('detailPage').classList.add('active');
      await loadData(id);
      renderInsights(id);
      renderList(id);
    }

    async function loadData(id) {
      const res = await fetch('/api/' + id);
      currentData = await res.json();
    }

    function renderInsights(id) {
      const area = document.getElementById('insightArea');
      fetch('/api/insights/' + id)
        .then(r => r.json())
        .then(data => {
          if (data.insights && data.insights.length > 0) {
            area.innerHTML = data.insights.map(i => 
              '<div class="insight-card">💡 ' + i.msg + '</div>'
            ).join('');
          } else {
            area.innerHTML = '<div class="insight-card">💡 继续记录，我会给你更多建议。</div>';
          }
        });
    }

    function renderList(id) {
      const list = document.getElementById('recordList');
      const meta = modules.find(m => m.id === id);
      if (currentData.length === 0) {
        list.innerHTML = '<div style="text-align:center;color:#999;padding:40px;">还没有记录，点 + 添加一条</div>';
        return;
      }
      list.innerHTML = currentData.slice().reverse().map(row => {
        const fields = meta.fields.slice(0, 4);
        const label = fields.map(f => f + ':' + (row[f] || '—')).join(' ');
        return '<div class="list-item"><span>' + label + '</span><span style="color:#999;font-size:12px;">' + (row.date || '') + '</span></div>';
      }).join('');
    }

    document.getElementById('backBtn').onclick = () => {
      document.getElementById('detailPage').classList.remove('active');
    };

    document.getElementById('addRecordBtn').onclick = () => {
      const modal = document.getElementById('modal');
      const meta = modules.find(m => m.id === currentModule);
      const fieldsDiv = document.getElementById('modalFields');
      fieldsDiv.innerHTML = meta.fields.map(f => {
        if (f === 'date') return '<input type="date" id="field_' + f + '" value="' + new Date().toISOString().slice(0,10) + '" placeholder="' + f + '">';
        if (f === 'done') return '<select id="field_' + f + '"><option value="true">已完成</option><option value="false">未完成</option></select>';
        return '<input type="text" id="field_' + f + '" placeholder="请输入 ' + f + '">';
      }).join('');
      document.getElementById('modalTitle').textContent = '添加 ' + meta.label;
      modal.classList.add('active');
    };

    document.getElementById('saveRecord').onclick = async () => {
      const meta = modules.find(m => m.id === currentModule);
      const obj = {};
      meta.fields.forEach(f => {
        const el = document.getElementById('field_' + f);
        if (el) obj[f] = el.value;
      });
      currentData.push(obj);
      await fetch('/api/' + currentModule, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentData)
      });
      document.getElementById('modal').classList.remove('active');
      renderList(currentModule);
      renderInsights(currentModule);
    };

    document.getElementById('voiceBtn').onclick = () => {
      if (!('webkitSpeechRecognition' in window)) {
        alert('请使用 Chrome 或 Safari 浏览器');
        return;
      }
      const recognition = new webkitSpeechRecognition();
      recognition.lang = 'zh-CN';
      recognition.onresult = async (event) => {
        const text = event.results[0][0].transcript;
        const res = await fetch('/api/voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        const result = await res.json();
        alert(result.message || '已执行：' + text);
        if (result.action === 'add_record' && result.module) {
          if (currentModule === result.module) {
            await loadData(result.module);
            renderList(result.module);
            renderInsights(result.module);
          }
        }
      };
      recognition.start();
    };

    function updateScene() {
      const h = new Date().getHours();
      const tip = document.getElementById('sceneTips');
      if (h < 9) tip.innerHTML = '🌅 早安！开启新的一天，先看看今日日程吧。';
      else if (h < 12) tip.innerHTML = '☀️ 上午好！专注工作，别忘了喝水哦。';
      else if (h < 14) tip.innerHTML = '🌤️ 午休时间，小憩一下或记录情绪。';
      else if (h < 18) tip.innerHTML = '📈 下午加油！检查一下愿望清单进度。';
      else tip.innerHTML = '🌙 夜晚了，复盘今天，准备明天。';
    }
    updateScene();
  </script>
</body>
</html>
`;
fs.writeFileSync(path.join(root, 'frontend/index.html'), frontendHTML);

// ===================== 3. 生成一键部署脚本 deploy.sh =====================
const deploySH = `#!/bin/bash
# 茄子管家 一键部署脚本
set -e

read -p "请输入你的服务器公网IP: " SERVER_IP
read -p "请输入SSH用户名 (默认ubuntu): " SSH_USER
SSH_USER=\${SSH_USER:-ubuntu}

echo "打包上传中..."
tar -czf eggplant.tar.gz backend frontend data
scp eggplant.tar.gz \${SSH_USER}@\${SERVER_IP}:/home/ubuntu/
ssh \${SSH_USER}@\${SERVER_IP} << 'ENDSSH'
  cd /home/ubuntu
  rm -rf eggplant-butler-final
  mkdir -p eggplant-butler-final
  tar -xzf eggplant.tar.gz -C eggplant-butler-final
  cd eggplant-butler-final/backend
  
  npm init -y
  npm install express cors
  
  pkill -f "node server" || true
  
  nohup node server.js > app.log 2>&1 &
  
  echo "配置Nginx反代..."
  sudo tee /etc/nginx/sites-available/eggplant > /dev/null << EOF
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \\$host;
    }
}
EOF
  sudo ln -sf /etc/nginx/sites-available/eggplant /etc/nginx/sites-enabled/
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl restart nginx
  
  echo "部署完成！访问 http://\${SERVER_IP} 即可使用"
ENDSSH

echo "✅ 茄子管家已上线！"
`;
fs.writeFileSync(path.join(root, 'deploy.sh'), deploySH);

// ===================== 4. 生成 GitHub Actions 自动部署流水线 =====================
const workflowYML = `
name: Auto Deploy

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy to Server
        uses: appleboy/scp-action@v0.1.4
        with:
          host: \${{ secrets.SERVER_IP }}
          username: ubuntu
          key: \${{ secrets.SSH_KEY }}
          source: "backend,frontend,data"
          target: "/home/ubuntu/eggplant-butler-final/"
      - name: Restart Service
        uses: appleboy/ssh-action@v0.1.5
        with:
          host: \${{ secrets.SERVER_IP }}
          username: ubuntu
          key: \${{ secrets.SSH_KEY }}
          script: |
            cd /home/ubuntu/eggplant-butler-final/backend
            pkill -f "node server" || true
            nohup node server.js > app.log 2>&1 &
`;
fs.writeFileSync(path.join(root, '.github/workflows/deploy.yml'), workflowYML);

// ===================== 5. 生成 README 及辅助文件 =====================
const readme = `
# 茄子管家 · 终极进化版

## 已包含
- 17个生活管理模块（含生活基础设施）
- 语音控制（Web Speech API）
- 情绪熔断机制
- 场景雷达
- GitHub Actions 自动部署

## 手动部署步骤
1. 运行 bash deploy.sh
2. 输入服务器IP和密码
3. 访问 http://你的IP

## 后续更新
修改代码后 push 到 GitHub main 分支，自动部署。
`;
fs.writeFileSync(path.join(root, 'README.md'), readme);

// 给 deploy.sh 加执行权限
fs.chmodSync(path.join(root, 'deploy.sh'), '755');

console.log('✅ 茄子管家终极版已生成在 ./eggplant-butler-final');
console.log('📦 接下来：');
console.log('1. cd eggplant-butler-final');
console.log('2. bash deploy.sh');
console.log('🌐 部署完成后，打开浏览器访问你的服务器IP即可使用！');
