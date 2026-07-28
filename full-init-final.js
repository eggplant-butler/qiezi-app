const fs = require('fs');
const path = require('path');

// ===================== 创建目录 =====================
const root = './eggplant-butler-final';
const dirs = ['backend', 'frontend', 'data', 'scripts', '.github/workflows'];
dirs.forEach(d => fs.mkdirSync(path.join(root, d), { recursive: true }));

// ===================== server.js（含全部27个模块API） =====================
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

// ---------- 深度洞察引擎（你的专属分析） ----------
app.get('/api/insights/:module', (req, res) => {
  const module = req.params.module;
  const file = path.join(DATA_DIR, module + '.json');
  let data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  
  // 读取情绪（用于熔断）
  const emotionFile = path.join(DATA_DIR, 'emotion.json');
  let lastEmotion = 5;
  if (fs.existsSync(emotionFile)) {
    const emotions = JSON.parse(fs.readFileSync(emotionFile, 'utf8'));
    if (emotions.length > 0) lastEmotion = emotions[emotions.length-1].score || 5;
  }
  const isMeltdown = lastEmotion <= 3;

  let insights = [];

  // ---- 财务管理：提成+预算+储蓄 ----
  if (module === 'finance' && !isMeltdown) {
    const totalIncome = data.filter(r => r.type === '收入').reduce((s, r) => s + Number(r.amount || 0), 0);
    const totalExpense = data.filter(r => r.type === '支出').reduce((s, r) => s + Number(r.amount || 0), 0);
    const balance = totalIncome - totalExpense;
    const commission = data.filter(r => r.isCommission === '是').reduce((s, r) => s + Number(r.amount || 0), 0);
    
    if (balance < 0) insights.push({ type: 'warning', msg: \`本月已超支 \${Math.abs(balance)} 元，建议查看支出明细\` });
    else insights.push({ type: 'info', msg: \`本月结余 \${balance} 元（提成收入 \${commission} 元），继续加油！\` });
    
    // 愿望联动提醒
    const wishFile = path.join(DATA_DIR, 'wish.json');
    if (fs.existsSync(wishFile)) {
      const wishes = JSON.parse(fs.readFileSync(wishFile, 'utf8'));
      const activeWishes = wishes.filter(w => w.status === '进行中');
      if (activeWishes.length > 0) {
        const totalTarget = activeWishes.reduce((s, w) => s + Number(w.targetAmount || 0), 0);
        const totalSaved = activeWishes.reduce((s, w) => s + Number(w.savedAmount || 0), 0);
        if (totalTarget > 0) {
          const progress = Math.round(totalSaved / totalTarget * 100);
          insights.push({ type: 'info', msg: \`🎯 你的 \${activeWishes.length} 个愿望总进度 \${progress}%，已存 \${totalSaved}/\${totalTarget} 元\` });
        }
      }
    }
  }

  // ---- 睡眠分析 ----
  if (module === 'sleep' && data.length > 0) {
    const last7 = data.slice(-7);
    const avgSleep = Math.round(last7.reduce((s, r) => s + (r.sleepHours || 0), 0) / last7.length);
    const avgQuality = Math.round(last7.reduce((s, r) => s + (r.feeling || 0), 0) / last7.length);
    insights.push({ type: 'info', msg: \`😴 近7天平均睡眠 \${avgSleep}小时，晨起感受 \${avgQuality}/5 分\` });
    if (avgSleep < 7) insights.push({ type: 'warning', msg: '⚠️ 睡眠不足7小时，建议23:00前入睡' });
    if (avgQuality >= 4) insights.push({ type: 'success', msg: '🌟 睡眠质量优秀，继续保持！' });
  }

  // ---- 经期提醒 ----
  if (module === 'menstrual' && data.length > 0) {
    const last = data[data.length - 1];
    if (last.cycleDay) {
      const day = parseInt(last.cycleDay);
      if (day >= 24 && day <= 28) insights.push({ type: 'info', msg: '🌸 经期即将到来，建议提前准备，减少高强度工作' });
      if (day >= 7 && day <= 14) insights.push({ type: 'info', msg: '💪 卵泡期，精力充沛，适合挑战性任务和学习' });
    }
  }

  // ---- 习惯打卡分析 ----
  if (module === 'habit' && !isMeltdown) {
    const total = data.length || 1;
    const done = data.filter(r => r.done === '已完成').length;
    const rate = Math.round(done / total * 100);
    if (rate < 30) insights.push({ type: 'warning', msg: '📉 习惯完成率偏低，建议先降低难度或拆解为小步骤' });
    else if (rate >= 80) insights.push({ type: 'success', msg: \`🎉 习惯完成率 \${rate}%，自律的你已经超越大多数人！\` });
  }

  // ---- 情绪熔断 ----
  if (isMeltdown) {
    insights = [{ type: 'gentle', msg: '🌸 今天心情似乎不太好，先休息一下吧，我明天再提醒你。' }];
  }

  if (insights.length === 0) {
    insights = [{ type: 'info', msg: '📊 继续记录，我会给你更多个性化建议。' }];
  }

  res.json({ insights });
});

// ---------- 语音指令（免费，不消耗Trae） ----------
app.post('/api/voice', (req, res) => {
  const text = req.body.text || '';
  let result = { action: 'unknown', message: '没听清，能再说一遍吗？' };

  // 1. 快速记账
  const match1 = text.match(/记一笔(.*?)(\\d+)块/);
  if (match1) {
    const category = match1[1].trim();
    const amount = parseInt(match1[2]);
    result = {
      action: 'add_record',
      module: 'finance',
      data: {
        date: new Date().toISOString().slice(0,10),
        type: '支出',
        category: category,
        amount: amount,
        merchant: '语音录入',
        intent: '享乐消费',
        note: '语音快速记账'
      },
      message: \`✅ 已记录：\${category} 消费 \${amount} 元\`
    };
  }

  // 2. 记录睡眠
  const match2 = text.match(/昨晚睡了(\\d+)小时/);
  if (match2) {
    result = {
      action: 'add_record',
      module: 'sleep',
      data: {
        date: new Date().toISOString().slice(0,10),
        sleepHours: parseInt(match2[1]),
        wakeCount: 0,
        feeling: 4,
        dream: '语音录入'
      },
      message: \`✅ 已记录睡眠：\${match2[1]} 小时\`
    };
  }

  // 3. 记录经期
  const match3 = text.match(/经期第(\\d+)天/);
  if (match3) {
    result = {
      action: 'add_record',
      module: 'menstrual',
      data: {
        date: new Date().toISOString().slice(0,10),
        cycleDay: parseInt(match3[1]),
        flow: '中',
        pain: 2,
        mood: '一般'
      },
      message: \`✅ 已记录经期第 \${match3[1]} 天\`
    };
  }

  // 4. 记录提成
  const match4 = text.match(/提成(.*?)(\\d+)块/);
  if (match4) {
    result = {
      action: 'add_record',
      module: 'finance',
      data: {
        date: new Date().toISOString().slice(0,10),
        type: '收入',
        category: '提成',
        amount: parseInt(match4[2]),
        project: match4[1].trim(),
        isCommission: '是',
        note: '语音记录提成'
      },
      message: \`✅ 已记录提成：\${match4[1]} \${match4[2]} 元\`
    };
  }

  // 5. 记录营养补充
  const match5 = text.match(/吃了(.*?)/);
  if (match5 && (text.includes('维C') || text.includes('蛋白') || text.includes('钙'))) {
    result = {
      action: 'add_record',
      module: 'supplement',
      data: {
        date: new Date().toISOString().slice(0,10),
        name: match5[1].trim(),
        taken: '是',
        note: '语音记录'
      },
      message: \`✅ 已记录补充：\${match5[1]}\`
    };
  }

  res.json(result);
});

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '3.0-custom' }));

app.listen(PORT, '0.0.0.0', () => console.log(\`🍆 茄子管家运行在端口 \${PORT}\`));
`;

fs.writeFileSync(path.join(root, 'backend/server.js'), serverJS);

// ===================== package.json =====================
const pkg = {
  name: 'eggplant-butler-final',
  version: '3.0.0',
  description: '你专属的全维度生活管家',
  scripts: { start: 'node server.js' },
  dependencies: {
    express: '^4.18.2',
    cors: '^2.8.5'
  }
};
fs.writeFileSync(path.join(root, 'backend/package.json'), JSON.stringify(pkg, null, 2));

// ===================== deploy.sh =====================
const deploySH = `#!/bin/bash
set -e
read -p "请输入你的服务器公网IP: " SERVER_IP
read -p "请输入SSH用户名 (默认ubuntu): " SSH_USER
SSH_USER=\${SSH_USER:-ubuntu}

echo "📦 打包上传中..."
tar -czf eggplant.tar.gz backend frontend data
scp eggplant.tar.gz \${SSH_USER}@\${SERVER_IP}:/home/ubuntu/
ssh \${SSH_USER}@\${SERVER_IP} << 'ENDSSH'
  cd /home/ubuntu
  rm -rf eggplant-butler-final
  mkdir -p eggplant-butler-final
  tar -xzf eggplant.tar.gz -C eggplant-butler-final
  cd eggplant-butler-final/backend
  npm install
  pkill -f "node server" || true
  nohup node server.js > app.log 2>&1 &
  echo "✅ 部署完成！访问 \`http://\${SERVER_IP}\` 即可使用"
ENDSSH
echo "🎉 茄子管家已上线！"
`;
fs.writeFileSync(path.join(root, 'deploy.sh'), deploySH);
fs.chmodSync(path.join(root, 'deploy.sh'), '755');

// ===================== README =====================
const readme = `# 🍆 茄子管家 · 你的专属定制版

## 包含模块
1. 财务管理（提成追踪 + 收入来源 + 预算规划 + 投资预留 + 保险预留）
2. 健康管理（睡眠实验室 + 经期记录 + 营养补充 + 体检预留 + 备孕预留）
3. 习惯打卡（增强版）
4. 日程管理（四象限）
5. 情绪管理（经期联动）
6. 闪念笔记
7. 社交人脉（向上社交经营）
8. 家庭责任（家人健康提醒 + 独居安全）
9. 工作引擎（OKR目标管理）
10. 技能图谱
11. 愿望清单（多目标并行储蓄）
12-17. 阅读/小确幸/家务/库存/天气/基础设施
18. 通勤碎片时间推荐

## 部署
bash deploy.sh
`;
fs.writeFileSync(path.join(root, 'README.md'), readme);

console.log('✅ 第1批完成！');
console.log('📦 已生成：server.js + package.json + deploy.sh');
console.log('');
console.log('🚀 下一步：');
console.log('1. 继续复制第2批代码（前端HTML）');
console.log('2. 然后执行 node full-init-final.js');
console.log('3. 最后 cd eggplant-butler-final && bash deploy.sh');
