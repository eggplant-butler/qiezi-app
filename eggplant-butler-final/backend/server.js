
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
  const match1 = text.match(/记一笔(.*?)(\d+)块/);
  if (match1) {
    result = { 
      action: 'add_record', 
      module: 'finance', 
      data: { category: match1[1].trim(), amount: -parseInt(match1[2]), type: 'expense', date: new Date().toISOString().slice(0,10) },
      message: '已记录：' + match1[1] + ' 消费 ' + match1[2] + ' 元'
    };
  }
  // 2. 记录心情：今天心情8分
  const match2 = text.match(/心情(\d+)分/);
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
