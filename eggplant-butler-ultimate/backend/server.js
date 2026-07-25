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

// 健康检查（必须在通用CRUD之前定义）
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '4.0-ultimate' }));

// 语音指令（必须在通用CRUD之前定义）
app.post('/api/voice', (req, res) => {
  const text = req.body.text || '';
  let result = { action: 'unknown', message: '没听清，能再说一遍吗？' };
  const m1 = text.match(/记一笔(.*?)(\d+)块/);
  if (m1) { result = { action: 'add_record', module: 'finance', data: { date: new Date().toISOString().slice(0,10), type: '支出', category: m1[1].trim() || '其他', amount: parseInt(m1[2]), merchant: '语音录入', intent: '享乐消费', note: '语音快速记账' }, message: '✅ 已记录：' + (m1[1].trim()||'消费') + ' ' + m1[2] + ' 元' }; return res.json(result); }
  const m2 = text.match(/昨晚睡了(\d+)小时/);
  if (m2) { result = { action: 'add_record', module: 'sleep', data: { date: new Date().toISOString().slice(0,10), sleepHours: parseInt(m2[1]), wakeCount: 0, feeling: '3-一般', dream: '语音录入' }, message: '✅ 已记录睡眠：' + m2[1] + ' 小时' }; return res.json(result); }
  const m3 = text.match(/经期第(\d+)天/);
  if (m3) { result = { action: 'add_record', module: 'menstrual', data: { date: new Date().toISOString().slice(0,10), cycleDay: parseInt(m3[1]), flow: '中', pain: '1-无', mood: '正常' }, message: '✅ 已记录经期第 ' + m3[1] + ' 天' }; return res.json(result); }
  const m4 = text.match(/提成(.*?)(\d+)块/);
  if (m4) { result = { action: 'add_record', module: 'finance', data: { date: new Date().toISOString().slice(0,10), type: '收入', category: '提成', amount: parseInt(m4[2]), project: m4[1].trim(), isCommission: '是', note: '语音记录提成' }, message: '✅ 已记录提成：' + m4[1].trim() + ' ' + m4[2] + ' 元' }; return res.json(result); }
  const m5 = text.match(/吃了(.+)/);
  if (m5 && (text.includes('维C') || text.includes('蛋白') || text.includes('钙'))) { result = { action: 'add_record', module: 'supplement', data: { date: new Date().toISOString().slice(0,10), name: m5[1].trim(), taken: '是', note: '语音记录' }, message: '✅ 已记录补充：' + m5[1].trim() }; return res.json(result); }
  res.json(result);
});

// 通用CRUD
app.get('/api/:module', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  if (!fs.existsSync(file)) return res.json([]);
  try { return res.json(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch(e) { return res.json([]); }
});

app.post('/api/:module', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  try {
    fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
    return res.json({ success: true });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/:module/:index', (req, res) => {
  const file = path.join(DATA_DIR, req.params.module + '.json');
  if (!fs.existsSync(file)) return res.json({ success: false });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.splice(parseInt(req.params.index), 1);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return res.json({ success: true });
});

// 深度洞察引擎
app.get('/api/insights/:module', (req, res) => {
  const module = req.params.module;
  const file = path.join(DATA_DIR, module + '.json');
  let data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];

  // 情绪熔断
  const emotionFile = path.join(DATA_DIR, 'emotion.json');
  let lastEmotion = 5;
  if (fs.existsSync(emotionFile)) {
    try { const em = JSON.parse(fs.readFileSync(emotionFile, 'utf8')); if (em.length > 0) lastEmotion = Number(em[em.length-1].score || 5); } catch(e) {}
  }
  const isMeltdown = lastEmotion <= 3;

  let insights = [];

  if (isMeltdown) {
    insights = [{ type: 'gentle', msg: '🌸 今天心情似乎不太好，先休息一下吧，我明天再提醒你。' }];
    return res.json({ insights });
  }

  if (module === 'finance' && data.length > 0) {
    const income = data.filter(r => r.type === '收入').reduce((s, r) => s + Number(r.amount || 0), 0);
    const expense = data.filter(r => r.type === '支出').reduce((s, r) => s + Number(r.amount || 0), 0);
    const balance = income - expense;
    const commission = data.filter(r => r.isCommission === '是').reduce((s, r) => s + Number(r.amount || 0), 0);
    if (balance < 0) insights.push({ type: 'warning', msg: '⚠️ 已超支 ' + Math.abs(balance) + ' 元，建议查看支出明细' });
    else insights.push({ type: 'info', msg: '💰 结余 ' + balance + ' 元（提成 ' + commission + ' 元）' });
    // 愿望联动
    const wishFile = path.join(DATA_DIR, 'wish.json');
    if (fs.existsSync(wishFile)) {
      try {
        const wishes = JSON.parse(fs.readFileSync(wishFile, 'utf8'));
        const active = wishes.filter(w => w.status === '进行中');
        if (active.length > 0) {
          const target = active.reduce((s, w) => s + Number(w.targetAmount || 0), 0);
          const saved = active.reduce((s, w) => s + Number(w.savedAmount || 0), 0);
          if (target > 0) insights.push({ type: 'info', msg: '🎯 ' + active.length + ' 个愿望进度 ' + Math.round(saved/target*100) + '%，已存 ' + saved + '/' + target + ' 元' });
        }
      } catch(e) {}
    }
  }

  if (module === 'sleep' && data.length > 0) {
    const last7 = data.slice(-7);
    const avg = Math.round(last7.reduce((s, r) => s + Number(r.sleepHours || 0), 0) / last7.length * 10) / 10;
    insights.push({ type: 'info', msg: '😴 近7天平均睡眠 ' + avg + ' 小时' });
    if (avg < 7) insights.push({ type: 'warning', msg: '⚠️ 睡眠不足7小时，建议23:00前入睡' });
    if (avg >= 8) insights.push({ type: 'success', msg: '🌟 睡眠充足，继续保持！' });
  }

  if (module === 'menstrual' && data.length > 0) {
    const last = data[data.length - 1];
    if (last.cycleDay) {
      const day = parseInt(last.cycleDay);
      if (day >= 24 && day <= 28) insights.push({ type: 'info', msg: '🌸 经期即将到来，建议提前准备' });
      if (day >= 7 && day <= 14) insights.push({ type: 'info', msg: '💪 卵泡期，精力充沛，适合挑战性任务' });
    }
  }

  if (module === 'habit' && data.length > 0) {
    const done = data.filter(r => r.done === '已完成').length;
    const rate = Math.round(done / (data.length || 1) * 100);
    if (rate < 30) insights.push({ type: 'warning', msg: '📉 完成率 ' + rate + '%，建议降低难度或拆解小步骤' });
    else if (rate >= 80) insights.push({ type: 'success', msg: '🎉 完成率 ' + rate + '%，太棒了！' });
  }

  if (module === 'emotion' && data.length > 0) {
    const avg = Math.round(data.reduce((s, r) => s + Number(r.score || 0), 0) / data.length * 10) / 10;
    if (avg <= 3) insights.push({ type: 'gentle', msg: '🌸 最近情绪偏低，记得照顾好自己' });
    else if (avg >= 7) insights.push({ type: 'success', msg: '🌟 最近情绪很好，继续保持！' });
  }

  if (module === 'inventory' && data.length > 0) {
    const expiring = data.filter(r => {
      if (!r.expiryDate) return false;
      const diff = (new Date(r.expiryDate) - new Date()) / (1000*60*60*24);
      return diff > 0 && diff <= 3;
    });
    if (expiring.length > 0) insights.push({ type: 'warning', msg: '⚠️ ' + expiring.length + ' 个物品即将过期(≤3天)' });
  }

  if (module === 'wish' && data.length > 0) {
    const active = data.filter(r => r.status === '进行中');
    active.forEach(w => {
      if (w.targetAmount > 0) {
        const p = Math.round(Number(w.savedAmount || 0) / Number(w.targetAmount) * 100);
        if (p >= 90) insights.push({ type: 'success', msg: '🎯 "' + w.title + '" 快完成了！' + p + '%' });
      }
    });
  }

  if (insights.length === 0) {
    insights = [{ type: 'info', msg: '📊 继续记录，我会给你更多个性化建议' }];
  }

  return res.json({ insights });
});

app.listen(PORT, '0.0.0.0', () => console.log('🍆 茄子管家·终极版运行在端口 ' + PORT));
