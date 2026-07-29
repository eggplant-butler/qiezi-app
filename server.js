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

// ---------- 模块/重心元数据（后端洞察引擎使用） ----------
const MODULE_META = {
  finance:  { label: '财务',     icon: 'fa-wallet',         color: '#3fb950' },
  sleep:    { label: '睡眠',     icon: 'fa-moon',           color: '#a371f7' },
  exercise: { label: '锻炼',     icon: 'fa-dumbbell',       color: '#f0883e' },
  emotion:  { label: '情绪',     icon: 'fa-face-smile',     color: '#d29922' },
  diary:    { label: '日记',     icon: 'fa-book-open',      color: '#58a6ff' },
  learn:    { label: '学习复盘', icon: 'fa-graduation-cap', color: '#a371f7' },
  skill:    { label: '摄影练习', icon: 'fa-camera',         color: '#db61a2' },
  diet:     { label: '饮食',     icon: 'fa-utensils',       color: '#f0883e' }
};

const CENTERS_META = [
  { id: 'work',      name: '工作收入', icon: 'fa-briefcase',    color: '#58a6ff', desc: '财务 + 职业',       modules: ['finance'] },
  { id: 'photo',     name: '摄影能力', icon: 'fa-camera',       color: '#db61a2', desc: '技能 + 作品',       modules: ['skill'] },
  { id: 'health',    name: '身体健康', icon: 'fa-heart-pulse',  color: '#3fb950', desc: '睡眠 + 锻炼 + 饮食', modules: ['sleep', 'exercise', 'diet'] },
  { id: 'cognition', name: '认知思考', icon: 'fa-brain',        color: '#a371f7', desc: '情绪 + 日记 + 复盘', modules: ['emotion', 'diary', 'learn'] }
];

// ---------- 工具函数 ----------
function readModule(name) {
  const file = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || []; } catch { return []; }
}
function writeModule(name, data) {
  const file = path.join(DATA_DIR, name + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function withinDays(record, days) {
  if (!record || !record.date) return false;
  const d = new Date(record.date);
  if (isNaN(d.getTime())) return false;
  const diff = (Date.now() - d.getTime()) / 86400000;
  return diff >= 0 && diff < days;
}
function avg(arr, key) {
  if (!arr.length) return 0;
  const sum = arr.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  return sum / arr.length;
}

// ---------- 状态/洞察引擎 ----------
function computeState() {
  const finance  = readModule('finance');
  const sleep    = readModule('sleep');
  const exercise = readModule('exercise');
  const emotion  = readModule('emotion');
  const diary    = readModule('diary');
  const learn    = readModule('learn');
  const skill    = readModule('skill');
  const diet     = readModule('diet');

  const sleep30    = sleep.filter(r => withinDays(r, 30));
  const emotion30  = emotion.filter(r => withinDays(r, 30));
  const exercise30 = exercise.filter(r => withinDays(r, 30));
  const finance30  = finance.filter(r => withinDays(r, 30));

  const avgSleep    = avg(sleep30, 'hours');
  const avgEmotion  = avg(emotion30, 'score');
  const exerciseCnt = exercise30.length;

  // 平衡指数：睡眠30% + 情绪40% + 锻炼30%
  const sleepScore = Math.min(avgSleep / 8, 1) * 30;
  const emotionScore = Math.min(avgEmotion / 10, 1) * 40;
  const exerciseScore = Math.min(exerciseCnt / 12, 1) * 30; // 30天12次为满分
  let balance = Math.round(sleepScore + emotionScore + exerciseScore);
  if (!finance.length && !sleep.length && !exercise.length && !emotion.length) balance = 0;

  // ---------- 30天洞察 ----------
  const insights = [];

  // 财务洞察
  if (finance30.length) {
    const expense = finance30.filter(r => (r.type || '支出') === '支出').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const income  = finance30.filter(r => r.type === '收入').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const catMap = {};
    finance30.filter(r => (r.type || '支出') === '支出').forEach(r => { const c = r.category || '其他'; catMap[c] = (catMap[c] || 0) + (Number(r.amount) || 0); });
    const topCat = Object.keys(catMap).sort((a, b) => catMap[b] - catMap[a])[0];
    insights.push({ icon: 'fa-wallet', title: '财务', text: '近30天支出 ' + expense.toFixed(0) + ' 元' + (income ? '，收入 ' + income.toFixed(0) + ' 元' : '') + '，日均 ' + (expense / 30).toFixed(1) + ' 元' + (topCat ? '，最大支出类别：' + topCat + '（' + catMap[topCat].toFixed(0) + '元）' : '') });
  } else {
    insights.push({ icon: 'fa-wallet', title: '财务', text: '近30天暂无记账记录，建议从今天开始记录每日支出。' });
  }

  // 睡眠洞察
  if (sleep30.length) {
    const recent7 = sleep.filter(r => withinDays(r, 7));
    const prev7avg = sleep30.length > recent7.length ? avg(sleep30.filter(r => !withinDays(r, 7)), 'hours') : 0;
    const recent7avg = avg(recent7, 'hours');
    const trend = recent7avg > prev7avg + 0.3 ? '上升' : recent7avg < prev7avg - 0.3 ? '下降' : '平稳';
    insights.push({ icon: 'fa-moon', title: '睡眠', text: '近30天平均睡眠 ' + avgSleep.toFixed(1) + ' 小时（' + (avgSleep >= 7 ? '达标' : '偏少') + '），近7天 ' + recent7avg.toFixed(1) + ' 小时，趋势' + trend });
  } else {
    insights.push({ icon: 'fa-moon', title: '睡眠', text: '近30天暂无睡眠记录，建议每天记录睡眠时长。' });
  }

  // 情绪洞察
  if (emotion30.length) {
    const sorted = emotion30.slice().sort((a, b) => Number(a.score) - Number(b.score));
    const lowest = sorted[0];
    const trendArr = emotion30.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const half = Math.floor(trendArr.length / 2);
    const firstHalf = avg(trendArr.slice(0, half), 'score');
    const secondHalf = avg(trendArr.slice(half), 'score');
    const mood = secondHalf > firstHalf + 0.3 ? '好转' : secondHalf < firstHalf - 0.3 ? '走低' : '平稳';
    insights.push({ icon: 'fa-face-smile', title: '情绪', text: '近30天平均情绪 ' + avgEmotion.toFixed(1) + ' 分，走势' + mood + (lowest ? '，最低 ' + lowest.score + ' 分（' + lowest.date + '）' : '') });
  } else {
    insights.push({ icon: 'fa-face-smile', title: '情绪', text: '近30天暂无情绪记录，关注内心状态从每天打分开始。' });
  }

  // 锻炼洞察
  if (exercise30.length) {
    const totalMin = exercise30.reduce((s, r) => s + (Number(r.duration) || 0), 0);
    const typeMap = {};
    exercise30.forEach(r => { const t = r.type || '运动'; typeMap[t] = (typeMap[t] || 0) + 1; });
    const topType = Object.keys(typeMap).sort((a, b) => typeMap[b] - typeMap[a])[0];
    insights.push({ icon: 'fa-dumbbell', title: '锻炼', text: '近30天锻炼 ' + exerciseCnt + ' 次，累计 ' + totalMin + ' 分钟，每周约 ' + (exerciseCnt / 4.3).toFixed(1) + ' 次' + (topType ? '，主项：' + topType : '') });
  } else {
    insights.push({ icon: 'fa-dumbbell', title: '锻炼', text: '近30天暂无锻炼记录，从一次15分钟快走开始吧。' });
  }

  // 学习/日记/摄影补充
  if (learn.length) insights.push({ icon: 'fa-graduation-cap', title: '学习', text: '累计复盘 ' + learn.length + ' 次，持续复盘是认知升级的杠杆。' });
  if (diary.length) insights.push({ icon: 'fa-book-open', title: '日记', text: '累计日记 ' + diary.length + ' 篇，文字让生活留下痕迹。' });
  if (skill.length) insights.push({ icon: 'fa-camera', title: '摄影', text: '累计摄影练习 ' + skill.length + ' 次，量变积累质变。' });

  // ---------- 下一步建议（基于数据动态生成） ----------
  const suggestions = [];
  if (avgSleep > 0 && avgSleep < 7) suggestions.push('睡眠偏少（' + avgSleep.toFixed(1) + 'h），目标 7-8 小时，今晚提前 30 分钟入睡');
  else if (avgSleep >= 7) suggestions.push('睡眠充足，继续保持稳定作息');
  else suggestions.push('开始记录睡眠，建立作息基线');

  if (avgEmotion > 0 && avgEmotion < 6) suggestions.push('情绪偏低（' + avgEmotion.toFixed(1) + '分），安排一次让自己放松的活动');
  else if (avgEmotion >= 8) suggestions.push('情绪状态优秀，可挑战一个新目标');
  else suggestions.push('每天给情绪打分，觉察是改变的第一步');

  if (exerciseCnt > 0 && exerciseCnt < 8) suggestions.push('锻炼频率偏低（30天' + exerciseCnt + '次），目标每周3次');
  else if (exerciseCnt >= 12) suggestions.push('锻炼频率优秀，注意搭配休息防过度');
  else suggestions.push('制定每周锻炼计划，从轻量运动起步');

  const finance30expense = finance30.filter(r => (r.type || '支出') === '支出').reduce((s, r) => s + (Number(r.amount) || 0), 0);
  if (finance30.length && finance30expense > 0) suggestions.push('30天支出 ' + finance30expense.toFixed(0) + ' 元，月度复盘一次消费结构');
  else suggestions.push('开始记账，看清钱花在哪里');

  return { balance, desc: balance >= 80 ? '状态优秀，保持节奏' : balance >= 60 ? '整体良好，继续优化' : balance >= 30 ? '需要关注，从小步开始' : '开始记录，建立数据基线', insights, suggestions, stats: {
    finance: finance.length, sleep: sleep.length, exercise: exercise.length, emotion: emotion.length,
    diary: diary.length, learn: learn.length, skill: skill.length, diet: diet.length,
    avgSleep: +avgSleep.toFixed(2), avgEmotion: +avgEmotion.toFixed(2), exercise30: exerciseCnt
  }};
}

app.get('/api/state', (req, res) => {
  try { res.json(computeState()); } catch (e) { res.json({ balance: 0, desc: '暂无数据', insights: [], suggestions: [], stats: {} }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '4.0-center', time: new Date().toISOString() }));

// ---------- 语音指令解析（支持记账/睡眠/情绪/锻炼，自动保存） ----------
app.post('/api/voice', (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (!text.trim()) return res.json({ action: 'unknown', message: '请说一句话，比如：记账午餐35块、睡了7小时、心情8分、跑了30分钟' });

  let result = { action: 'unknown', message: '没太明白，可以试试：记账午餐35块 / 睡了7小时 / 心情8分 / 跑了30分钟' };

  // 1) 记账：记账午餐35块 / 记午餐35块 / 花了35 / 买书45元
  const mFin = text.match(/(?:记账|记一下|记|花了?|买了?|消费了?|支出了?|支出)([^0-9]*?)(\d+(?:\.\d+)?)\s*(?:块|元)/);
  if (mFin) {
    const category = (mFin[1] || '').trim() || '其他';
    const record = { date: todayStr(), type: '支出', category, amount: mFin[2], note: text };
    const data = readModule('finance'); data.push(record); writeModule('finance', data);
    result = { action: 'add_record', module: 'finance', data: record, saved: true, message: '✅ 已记账：' + category + ' 支出 ' + mFin[2] + ' 元' };
    return res.json(result);
  }

  // 2) 睡眠：睡了7小时 / 睡7.5h
  const mSleep = text.match(/睡[着了]?(\d+(?:\.\d+)?)\s*(?:小时|h)/);
  if (mSleep) {
    const record = { date: todayStr(), hours: mSleep[1], quality: '4', note: text };
    const data = readModule('sleep'); data.push(record); writeModule('sleep', data);
    result = { action: 'add_record', module: 'sleep', data: record, saved: true, message: '✅ 已记录睡眠：' + mSleep[1] + ' 小时' };
    return res.json(result);
  }

  // 3) 情绪：心情8分 / 情绪7分 / 开心9分
  const mEmo = text.match(/(?:心情|情绪|开心|难过|焦虑|平静|状态)[^0-9]*?(\d+(?:\.\d+)?)\s*分?/);
  if (mEmo) {
    const record = { date: todayStr(), score: mEmo[1], tags: text, note: text };
    const data = readModule('emotion'); data.push(record); writeModule('emotion', data);
    result = { action: 'add_record', module: 'emotion', data: record, saved: true, message: '✅ 已记录情绪：' + mEmo[1] + ' 分' };
    return res.json(result);
  }

  // 4) 锻炼：跑了30分钟 / 跑步40min / 游泳50分钟 / 健身60分
  const mEx = text.match(/(跑步|跑|散步|走路|走|游泳|骑车|骑行|健身|瑜伽|运动|锻炼)(?:了)?(\d+(?:\.\d+)?)\s*(?:分钟|min|分)/);
  if (mEx) {
    const typeMap = { '跑': '跑步', '跑步': '跑步', '散步': '散步', '走路': '散步', '走': '散步', '游泳': '游泳', '骑车': '骑行', '骑行': '骑行', '健身': '健身', '瑜伽': '瑜伽', '运动': '运动', '锻炼': '锻炼' };
    const type = typeMap[mEx[1]] || '运动';
    const record = { date: todayStr(), type, duration: mEx[2], intensity: '中度' };
    const data = readModule('exercise'); data.push(record); writeModule('exercise', data);
    result = { action: 'add_record', module: 'exercise', data: record, saved: true, message: '✅ 已记录锻炼：' + type + ' ' + mEx[2] + ' 分钟' };
    return res.json(result);
  }

  // 5) 简单对话回复
  if (/你好|hello|hi/i.test(text)) result = { action: 'chat', message: '你好呀，我是茄子管家，可以帮你记账、记睡眠、记情绪、记锻炼，试试「记账午餐35块」' };
  else if (/建议|怎么办|怎么样/.test(text)) {
    const st = computeState();
    result = { action: 'chat', message: '建议：' + (st.suggestions[0] || '继续记录数据') };
  } else if (/报告|总结|分析/.test(text)) {
    const st = computeState();
    result = { action: 'chat', message: '当前平衡指数 ' + st.balance + ' 分。' + st.desc + '。详见报告页。' };
  }

  res.json(result);
});

// ---------- 头像 ----------
app.get('/api/avatar', (req, res) => {
  const file = path.join(DATA_DIR, 'avatar.json');
  if (!fs.existsSync(file)) return res.json({ emoji: '🍆', name: '茄子管家用户' });
  try { res.json(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { res.json({ emoji: '🍆' }); }
});
app.post('/api/avatar', (req, res) => {
  fs.writeFileSync(path.join(DATA_DIR, 'avatar.json'), JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// ---------- 备份 ----------
app.get('/api/backup', (req, res) => {
  const backup = { exportedAt: new Date().toISOString(), version: '4.0-center', data: {} };
  ['finance', 'sleep', 'exercise', 'emotion', 'diary', 'learn', 'skill', 'diet', 'avatar'].forEach(name => {
    backup.data[name] = readModule(name);
  });
  try { backup.data.avatar = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'avatar.json'), 'utf8')); } catch {}
  res.setHeader('Content-Disposition', 'attachment; filename="qiezi-backup-' + Date.now() + '.json"');
  res.json(backup);
});

// ---------- 通用CRUD API（必须放在所有具体 /api/xxx 路由之后，避免 :module 吞掉它们） ----------
app.get('/api/:module', (req, res) => {
  res.json(readModule(req.params.module));
});

app.post('/api/:module', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ success: false, error: 'body must be an array' });
  writeModule(req.params.module, req.body);
  res.json({ success: true });
});

app.delete('/api/:module/:index', (req, res) => {
  const name = req.params.module;
  const idx = parseInt(req.params.index, 10);
  const data = readModule(name);
  if (idx < 0 || idx >= data.length) return res.json({ success: false, error: 'index out of range' });
  data.splice(idx, 1);
  writeModule(name, data);
  res.json({ success: true });
});

// ===================== 前端页面 =====================
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
:root{--bg:#0d1117;--card:#161b22;--card2:#1c2128;--border:#30363d;--text:#e6edf3;--text2:#8b949e;--primary:#58a6ff;--green:#3fb950;--purple:#a371f7;--orange:#f0883e;--yellow:#d29922;--blue:#58a6ff;--pink:#db61a2;--red:#f85149}
body{background:var(--bg);color:var(--text);padding-bottom:84px;min-height:100vh}
.tab-page{display:none;padding:16px}.tab-page.active{display:block}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:0 4px}
.header h1{font-size:22px;font-weight:700}
.avatar{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#1f6feb,#a371f7);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px}
.balance-card{background:linear-gradient(135deg,#1f6feb 0%,#a371f7 100%);border-radius:20px;padding:24px;margin-bottom:20px;color:#fff;position:relative;overflow:hidden}
.balance-card::before{content:'';position:absolute;top:-50%;right:-20%;width:200px;height:200px;background:rgba(255,255,255,0.1);border-radius:50%}
.balance-card .label{font-size:13px;opacity:0.9;margin-bottom:6px}
.balance-card .score{font-size:48px;font-weight:700;margin:8px 0}
.balance-card .desc{font-size:13px;opacity:0.85}
.section-title{font-size:16px;font-weight:600;margin:20px 0 12px;display:flex;align-items:center;gap:8px}
.section-title i{color:var(--primary)}
.center-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:12px}
.center-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;cursor:pointer;transition:0.2s;position:relative}
.center-card:active{transform:scale(0.97)}
.center-card.active{border-color:var(--primary);box-shadow:0 0 0 2px rgba(88,166,255,0.2)}
.center-card .icon-wrap{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;font-size:20px;color:#fff}
.center-card .name{font-size:15px;font-weight:600;margin-bottom:4px}
.center-card .desc{font-size:12px;color:var(--text2)}
.center-card .progress{height:4px;background:var(--card2);border-radius:2px;margin-top:8px;overflow:hidden}
.center-card .progress-bar{height:100%;background:linear-gradient(90deg,var(--primary),var(--purple));border-radius:2px;transition:width 0.3s}
.center-card .pct{position:absolute;top:12px;right:14px;font-size:11px;color:var(--text2)}
.center-expand{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:14px;margin-bottom:20px;display:none}
.center-expand.active{display:block}
.center-expand .ce-title{font-size:13px;color:var(--text2);margin-bottom:10px;display:flex;align-items:center;gap:6px}
.ce-module{background:var(--card2);border-radius:12px;padding:12px 14px;margin-bottom:8px}
.ce-module .ce-mhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.ce-module .ce-mname{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.ce-module .ce-mcount{font-size:12px;color:var(--text2)}
.ce-module .ce-open{background:var(--primary);color:#fff;border:none;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
.ce-rec{font-size:12px;color:var(--text2);padding:4px 0;border-top:1px dashed var(--border)}
.ce-rec:first-of-type{border-top:none}
.quick-input{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:14px;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.quick-input i{color:var(--primary);font-size:18px}
.quick-input input{flex:1;background:transparent;border:none;color:var(--text);font-size:14px;outline:none}
.quick-input input::placeholder{color:var(--text2)}
.quick-hint{font-size:11px;color:var(--text2);margin-top:8px;line-height:1.6}
.quick-hint span{display:inline-block;background:var(--card2);padding:2px 8px;border-radius:8px;margin:2px 4px 2px 0}
.module-list{display:flex;flex-direction:column;gap:8px}
.module-item{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:14px;cursor:pointer}
.module-item:active{transform:scale(0.98);background:var(--card2)}
.module-item .icon-wrap{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px}
.module-item .info{flex:1}
.module-item .name{font-size:15px;font-weight:500;margin-bottom:2px}
.module-item .sub{font-size:12px;color:var(--text2)}
.module-item .badge{background:var(--card2);color:var(--text2);font-size:11px;padding:2px 8px;border-radius:10px;margin-right:8px}
.module-item .arrow{color:var(--text2);font-size:14px}
.focus-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 8px;text-align:center}
.stat-card .num{font-size:24px;font-weight:700;margin-bottom:4px}
.stat-card .label{font-size:11px;color:var(--text2)}
.report-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:12px}
.report-card h3{font-size:15px;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.report-card h3 i{color:var(--primary)}
.report-card p{font-size:13px;color:var(--text2);line-height:1.7}
.report-card .insight-row{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
.report-card .insight-row:last-child{border-bottom:none}
.report-card .insight-row i{color:var(--primary);margin-top:3px}
.report-card .insight-row .ir-text{flex:1;font-size:13px;color:var(--text);line-height:1.6}
.report-card .insight-row .ir-text b{color:var(--text);font-weight:600}
.tag{display:inline-block;padding:3px 10px;background:var(--card2);border-radius:10px;font-size:12px;color:var(--primary);margin:4px 6px 0 0}
.chat-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:14px;margin-bottom:12px;min-height:200px}
.chat-msg{padding:10px 14px;border-radius:12px;margin-bottom:8px;max-width:80%;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.chat-msg.user{background:var(--primary);color:#fff;margin-left:auto}
.chat-msg.bot{background:var(--card2);color:var(--text)}
.chat-input{display:flex;gap:8px;position:fixed;bottom:84px;left:16px;right:16px}
.chat-input input{flex:1;background:var(--card);border:1px solid var(--border);border-radius:24px;padding:12px 18px;color:var(--text);font-size:14px;outline:none}
.chat-input button{background:var(--primary);color:#fff;border:none;border-radius:50%;width:44px;height:44px;cursor:pointer}
.profile-section{background:var(--card);border:1px solid var(--border);border-radius:14px;margin-bottom:12px;overflow:hidden}
.profile-item{padding:16px;display:flex;align-items:center;gap:14px;cursor:pointer;border-bottom:1px solid var(--border)}
.profile-item:last-child{border-bottom:none}
.profile-item:active{background:var(--card2)}
.profile-item i{width:20px;color:var(--primary);font-size:16px}
.profile-item .name{flex:1;font-size:14px}
.profile-item .arrow{color:var(--text2);font-size:12px}
.profile-info{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:12px;text-align:center}
.profile-info .emoji{font-size:48px;margin-bottom:8px}
.profile-info .name{font-size:16px;font-weight:600}
.stat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:10px}
.stat-grid .si{background:var(--card2);border-radius:10px;padding:10px;display:flex;justify-content:space-between;font-size:13px}
.stat-grid .si .sn{color:var(--text2)}
.stat-grid .si .sv{font-weight:600}
.bottom-nav{position:fixed;bottom:0;left:0;right:0;background:var(--card);border-top:1px solid var(--border);display:flex;justify-content:space-around;padding:8px 0;z-index:100}
.nav-item{flex:1;text-align:center;padding:6px;cursor:pointer;color:var(--text2)}
.nav-item.active{color:var(--primary)}
.nav-item i{font-size:20px;display:block;margin-bottom:2px}
.nav-item span{font-size:11px}
.detail-page{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:200;overflow-y:auto;padding:16px}
.detail-page.active{display:block}
.back-btn{background:none;border:none;color:var(--text);font-size:16px;cursor:pointer;margin-bottom:16px;display:flex;align-items:center;gap:6px}
.add-btn{position:fixed;bottom:24px;right:20px;background:var(--primary);color:#fff;border:none;width:56px;height:56px;border-radius:50%;font-size:22px;box-shadow:0 4px 20px rgba(31,111,235,0.4);cursor:pointer;z-index:150}
.modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:300;justify-content:center;align-items:flex-end;padding:16px}
.modal.active{display:flex}
.modal-box{background:var(--card);border-radius:20px 20px 0 0;padding:24px;width:100%;max-height:85vh;overflow-y:auto;border:1px solid var(--border)}
.modal-box h3{font-size:18px;margin-bottom:16px}
.field-group{margin-bottom:14px}
.field-group label{display:block;font-size:12px;color:var(--text2);margin-bottom:4px;font-weight:500}
.field-group input,.field-group select,.field-group textarea{width:100%;background:var(--card2);border:1px solid var(--border);border-radius:10px;padding:11px 14px;color:var(--text);font-size:14px;outline:none}
.field-group input:focus,.field-group select:focus,.field-group textarea:focus{border-color:var(--primary)}
.btn-save{background:var(--primary);color:#fff;border:none;padding:14px;border-radius:12px;width:100%;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px}
.list-item{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.list-item .main{flex:1;min-width:0}
.list-item .title{font-size:14px;margin-bottom:3px;word-break:break-word}
.list-item .sub{font-size:12px;color:var(--text2);word-break:break-word}
.list-item .right{text-align:right;flex-shrink:0}
.list-item .date{font-size:11px;color:var(--text2);margin-bottom:4px}
.del-btn{background:none;border:none;color:var(--red);font-size:12px;cursor:pointer;padding:2px 6px}
.empty-state{text-align:center;color:var(--text2);padding:40px 0;font-size:14px}
.toast{position:fixed;top:80px;left:50%;transform:translateX(-50%);background:var(--card2);color:var(--text);padding:10px 22px;border-radius:12px;font-size:13px;z-index:500;opacity:0;transition:0.3s;pointer-events:none;border:1px solid var(--border);max-width:90%;text-align:center}
.toast.show{opacity:1}
</style>
</head>
<body>
<div id="home" class="tab-page active">
  <div class="header"><h1>🍆 茄子管家</h1><div class="avatar" id="avatarBtn">🍆</div></div>
  <div class="balance-card"><div class="label">平衡指数</div><div class="score" id="balanceScore">--</div><div class="desc" id="balanceDesc">保持觉察，稳步前行</div></div>
  <div class="quick-input"><i class="fas fa-microphone"></i><input type="text" id="quickInput" placeholder="说一句：记账午餐35块 / 睡了7小时 / 心情8分 / 跑了30分钟"></div>
  <div class="quick-hint">示例：<span onclick="fillQuick('记账午餐35块')">记账午餐35块</span><span onclick="fillQuick('睡了7小时')">睡了7小时</span><span onclick="fillQuick('心情8分')">心情8分</span><span onclick="fillQuick('跑了30分钟')">跑了30分钟</span></div>
  <div class="section-title"><i class="fas fa-bullseye"></i> 4个重心</div>
  <div class="center-grid" id="centerGrid"></div>
  <div class="center-expand" id="centerExpand"></div>
  <div class="section-title"><i class="fas fa-table-cells-large"></i> 6个核心模块</div>
  <div class="module-list" id="moduleList"></div>
</div>

<div id="focus" class="tab-page">
  <div class="header"><h1><i class="fas fa-compass"></i> 聚焦</h1></div>
  <div class="balance-card"><div class="label">综合平衡指数</div><div class="score" id="focusScore">--</div><div class="desc" id="focusDesc">基于睡眠/情绪/锻炼计算</div></div>
  <div class="section-title"><i class="fas fa-chart-bar"></i> 三维统计</div>
  <div class="focus-stats">
    <div class="stat-card"><div class="num" style="color:var(--purple)" id="statSleep">--</div><div class="label">平均睡眠(h)</div></div>
    <div class="stat-card"><div class="num" style="color:var(--yellow)" id="statEmotion">--</div><div class="label">平均情绪</div></div>
    <div class="stat-card"><div class="num" style="color:var(--orange)" id="statExercise">--</div><div class="label">锻炼(次/30天)</div></div>
  </div>
  <div class="section-title"><i class="fas fa-yin-yang"></i> 4个人生重心进度</div>
  <div class="center-grid" id="focusCenters"></div>
</div>

<div id="report" class="tab-page">
  <div class="header"><h1><i class="fas fa-chart-line"></i> 报告</h1></div>
  <div id="reportContent"><div class="empty-state">加载中...</div></div>
</div>

<div id="message" class="tab-page">
  <div class="header"><h1><i class="fas fa-comments"></i> 智能助手</h1></div>
  <div class="chat-box" id="chatList">
    <div class="chat-msg bot">你好！我是茄子管家助手。可以对我说：记账午餐35块、睡了7小时、心情8分、跑了30分钟，我会自动帮你记录。</div>
  </div>
  <div class="chat-input"><input type="text" id="chatInput" placeholder="说点什么..."><button id="chatSend"><i class="fas fa-paper-plane"></i></button></div>
</div>

<div id="profile" class="tab-page">
  <div class="header"><h1><i class="fas fa-user-circle"></i> 我的</h1></div>
  <div class="profile-info"><div class="emoji" id="pfEmoji">🍆</div><div class="name" id="pfName">茄子管家用户</div></div>
  <div class="profile-section">
    <div class="profile-item" onclick="showStats()"><i class="fas fa-chart-pie"></i><div class="name">数据统计</div><span class="arrow"><i class="fas fa-chevron-right"></i></span></div>
    <div class="profile-item" onclick="backupData()"><i class="fas fa-cloud-arrow-down"></i><div class="name">数据备份（导出JSON）</div><span class="arrow"><i class="fas fa-chevron-right"></i></span></div>
    <div class="profile-item" onclick="changeAvatar()"><i class="fas fa-image"></i><div class="name">修改头像</div><span class="arrow"><i class="fas fa-chevron-right"></i></span></div>
    <div class="profile-item" onclick="clearCache()"><i class="fas fa-trash"></i><div class="name">清除缓存</div><span class="arrow"><i class="fas fa-chevron-right"></i></span></div>
  </div>
  <div class="profile-section">
    <div class="profile-item" onclick="showAbout()"><i class="fas fa-info-circle"></i><div class="name">关于茄子管家</div><span class="arrow"><i class="fas fa-chevron-right"></i></span></div>
  </div>
</div>

<div class="detail-page" id="detailPage">
  <button class="back-btn" id="backBtn"><i class="fas fa-chevron-left"></i> 返回</button>
  <h2 id="detailTitle" style="margin-bottom:16px">模块</h2>
  <div id="recordList"></div>
  <button class="add-btn" id="addBtn">+</button>
</div>

<div class="modal" id="modal">
  <div class="modal-box">
    <h3 id="modalTitle">添加记录</h3>
    <div id="modalFields"></div>
    <button class="btn-save" id="saveBtn">保存</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<div class="bottom-nav">
  <div class="nav-item active" data-tab="home"><i class="fas fa-house"></i><span>首页</span></div>
  <div class="nav-item" data-tab="focus"><i class="fas fa-compass"></i><span>聚焦</span></div>
  <div class="nav-item" data-tab="report"><i class="fas fa-chart-line"></i><span>报告</span></div>
  <div class="nav-item" data-tab="message"><i class="fas fa-comments"></i><span>助手</span></div>
  <div class="nav-item" data-tab="profile"><i class="fas fa-user"></i><span>我的</span></div>
</div>

<script>
var CENTERS=[
  {id:'work',name:'工作收入',icon:'fa-briefcase',color:'#58a6ff',desc:'财务 + 职业',modules:['finance']},
  {id:'photo',name:'摄影能力',icon:'fa-camera',color:'#db61a2',desc:'技能 + 作品',modules:['skill']},
  {id:'health',name:'身体健康',icon:'fa-heart-pulse',color:'#3fb950',desc:'睡眠+锻炼+饮食',modules:['sleep','exercise','diet']},
  {id:'cognition',name:'认知思考',icon:'fa-brain',color:'#a371f7',desc:'情绪+日记+复盘',modules:['emotion','diary','learn']}
];
var MODULES=[
  {id:'finance',label:'财务',icon:'fa-wallet',color:'#3fb950',desc:'记账与收支管理',fields:[{key:'date',label:'日期',type:'date'},{key:'type',label:'收支类型',type:'select',options:['支出','收入']},{key:'category',label:'分类',type:'select',options:['餐饮','交通','购物','学习','医疗','提成','其他']},{key:'amount',label:'金额(元)',type:'number'},{key:'note',label:'备注',type:'textarea'}]},
  {id:'sleep',label:'睡眠',icon:'fa-moon',color:'#a371f7',desc:'睡眠时长与质量',fields:[{key:'date',label:'日期',type:'date'},{key:'hours',label:'睡眠时长(小时)',type:'number'},{key:'quality',label:'质量评分(1-5)',type:'select',options:['1','2','3','4','5']},{key:'note',label:'备注',type:'textarea'}]},
  {id:'exercise',label:'锻炼',icon:'fa-dumbbell',color:'#f0883e',desc:'运动记录',fields:[{key:'date',label:'日期',type:'date'},{key:'type',label:'运动类型',type:'text'},{key:'duration',label:'时长(分钟)',type:'number'},{key:'intensity',label:'强度',type:'select',options:['轻度','中度','高强度']}]},
  {id:'emotion',label:'情绪',icon:'fa-face-smile',color:'#d29922',desc:'情绪评分',fields:[{key:'date',label:'日期',type:'date'},{key:'score',label:'情绪评分(1-10)',type:'number'},{key:'tags',label:'情绪标签',type:'text'},{key:'note',label:'记录',type:'textarea'}]},
  {id:'diary',label:'日记',icon:'fa-book-open',color:'#58a6ff',desc:'每日记录',fields:[{key:'date',label:'日期',type:'date'},{key:'title',label:'标题',type:'text'},{key:'content',label:'内容',type:'textarea'},{key:'mood',label:'心情',type:'select',options:['😊','😐','😢','😡','😌']}]},
  {id:'learn',label:'学习复盘',icon:'fa-graduation-cap',color:'#a371f7',desc:'成长记录',fields:[{key:'date',label:'日期',type:'date'},{key:'topic',label:'学习主题',type:'text'},{key:'insight',label:'收获/洞察',type:'textarea'},{key:'action',label:'下一步行动',type:'textarea'}]},
  {id:'skill',label:'摄影练习',icon:'fa-camera',color:'#db61a2',desc:'摄影技能记录',fields:[{key:'date',label:'日期',type:'date'},{key:'topic',label:'练习主题',type:'text'},{key:'duration',label:'练习时长(分钟)',type:'number'},{key:'note',label:'备注',type:'textarea'}]},
  {id:'diet',label:'饮食',icon:'fa-utensils',color:'#f0883e',desc:'饮食记录',fields:[{key:'date',label:'日期',type:'date'},{key:'meal',label:'餐次',type:'select',options:['早餐','午餐','晚餐','加餐']},{key:'items',label:'食物',type:'text'},{key:'calories',label:'热量估算',type:'number'}]}
];
var CORE_MODULE_IDS=['finance','sleep','exercise','emotion','diary','learn'];

function apiFetch(url,opts){opts=opts||{};opts.headers=opts.headers||{};opts.headers['Content-Type']='application/json';return fetch(url,opts);}
function showToast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2200);}
function fillQuick(t){var i=document.getElementById('quickInput');i.value=t;i.focus();}

function switchTab(tab){
  document.querySelectorAll('.tab-page').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.nav-item').forEach(function(n){n.classList.remove('active')});
  document.getElementById(tab).classList.add('active');
  var nav=document.querySelector('.nav-item[data-tab="'+tab+'"]');
  if(nav)nav.classList.add('active');
  if(tab==='focus')loadFocus();
  if(tab==='report')loadReport();
  if(tab==='profile')loadProfile();
}
document.querySelectorAll('.nav-item').forEach(function(n){n.onclick=function(){switchTab(this.dataset.tab)};});

// ---------- 首页 ----------
var moduleCounts={};
function refreshCounts(cb){
  Promise.all(MODULES.map(function(m){return apiFetch('/api/'+m.id).then(function(r){return r.json()}).then(function(d){moduleCounts[m.id]=Array.isArray(d)?d.length:0;})})).then(function(){if(cb)cb()}).catch(function(){if(cb)cb()});
}

function renderHome(){
  var cg=document.getElementById('centerGrid');
  cg.innerHTML='';
  CENTERS.forEach(function(c){
    var card=document.createElement('div');
    card.className='center-card';
    card.id='cc-'+c.id;
    var pct=centerProgress(c);
    card.innerHTML='<div class="icon-wrap" style="background:'+c.color+'"><i class="fas '+c.icon+'"></i></div><div class="name">'+c.name+'</div><div class="desc">'+c.desc+'</div><div class="pct">'+pct+'%</div><div class="progress"><div class="progress-bar" style="width:'+pct+'%"></div></div>';
    card.onclick=function(){toggleCenter(c.id)};
    cg.appendChild(card);
  });

  var ml=document.getElementById('moduleList');
  ml.innerHTML='';
  CORE_MODULE_IDS.forEach(function(id){
    var m=MODULES.find(function(x){return x.id===id});
    var cnt=moduleCounts[m.id]||0;
    var item=document.createElement('div');
    item.className='module-item';
    item.innerHTML='<div class="icon-wrap" style="background:'+m.color+'"><i class="fas '+m.icon+'"></i></div><div class="info"><div class="name">'+m.label+'</div><div class="sub">'+m.desc+'</div></div><span class="badge">'+cnt+'条</span><span class="arrow"><i class="fas fa-chevron-right"></i></span>';
    item.onclick=function(){openModule(m.id)};
    ml.appendChild(item);
  });
}

function centerProgress(c){
  var total=c.modules.reduce(function(s,id){return s+(moduleCounts[id]||0)},0);
  var target=c.modules.length*10;
  return Math.min(Math.round(total/target*100),100);
}

var activeCenter=null;
function toggleCenter(id){
  if(activeCenter===id){activeCenter=null;document.getElementById('centerExpand').classList.remove('active');document.querySelectorAll('.center-card').forEach(function(x){x.classList.remove('active')});return;}
  activeCenter=id;
  document.querySelectorAll('.center-card').forEach(function(x){x.classList.remove('active')});
  document.getElementById('cc-'+id).classList.add('active');
  var c=CENTERS.find(function(x){return x.id===id});
  var box=document.getElementById('centerExpand');
  var html='<div class="ce-title"><i class="fas '+c.icon+'" style="color:'+c.color+'"></i> '+c.name+' · 包含 '+c.modules.length+' 个模块</div>';
  c.modules.forEach(function(mid){
    var m=MODULES.find(function(x){return x.id===mid});
    if(!m)return;
    html+='<div class="ce-module"><div class="ce-mhead"><div class="ce-mname"><i class="fas '+m.icon+'" style="color:'+m.color+'"></i> '+m.label+'</div><button class="ce-open" onclick="openModule(\\''+m.id+'\\')">查看详情</button></div><div class="ce-mcount">记录数：'+(moduleCounts[mid]||0)+' 条</div><div id="ce-records-'+mid+'"></div></div>';
  });
  box.innerHTML=html;
  box.classList.add('active');
  c.modules.forEach(function(mid){loadCenterRecords(mid)});
}

function loadCenterRecords(mid){
  apiFetch('/api/'+mid).then(function(r){return r.json()}).then(function(data){
    data=Array.isArray(data)?data:[];
    var el=document.getElementById('ce-records-'+mid);
    if(!el)return;
    if(!data.length){el.innerHTML='<div class="ce-rec">暂无记录</div>';return;}
    el.innerHTML=data.slice(-3).reverse().map(function(r){
      var keys=Object.keys(r).filter(function(k){return k!=='note'&&k!=='date'});
      var s=keys.slice(0,3).map(function(k){return r[k]}).join(' · ');
      return '<div class="ce-rec">'+(r.date||'')+' · '+s+'</div>';
    }).join('');
  }).catch(function(){});
}

// ---------- 详情页 ----------
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
  if(currentData.length===0){list.innerHTML='<div class="empty-state">📭 还没有记录，点击右下角 + 添加</div>';return;}
  var m=MODULES.find(function(x){return x.id===currentModule});
  list.innerHTML=currentData.slice().reverse().map(function(r,idx){
    var realIndex=currentData.length-1-idx;
    var keys=Object.keys(r).filter(function(k){return k!=='date'&&k!=='note'&&k!=='content'});
    var summary=keys.slice(0,4).map(function(k){return r[k]}).join(' · ')||'记录';
    var sub=(r.note||r.content||'');
    return '<div class="list-item"><div class="main"><div class="title">'+summary+'</div>'+(sub?'<div class="sub">'+escapeHtml(sub)+'</div>':'')+'</div><div class="right"><div class="date">'+(r.date||'')+'</div><button class="del-btn" onclick="deleteRecord('+realIndex+')">删除</button></div></div>';
  }).join('');
}
function escapeHtml(s){return String(s).replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c]})}
function deleteRecord(index){
  if(!confirm('确认删除这条记录？'))return;
  apiFetch('/api/'+currentModule+'/'+index,{method:'DELETE'}).then(function(r){return r.json()}).then(function(){
    loadRecords();
    showToast('已删除');
  }).catch(function(){showToast('删除失败')});
}
document.getElementById('backBtn').onclick=function(){
  document.getElementById('detailPage').classList.remove('active');
  refreshCounts(renderHome);
};
document.getElementById('addBtn').onclick=function(){
  var m=MODULES.find(function(x){return x.id===currentModule});
  document.getElementById('modalTitle').textContent='添加 '+m.label;
  var f=document.getElementById('modalFields');
  f.innerHTML=m.fields.map(function(fd){
    if(fd.type==='select')return '<div class="field-group"><label>'+fd.label+'</label><select id="f_'+fd.key+'">'+fd.options.map(function(o){return '<option>'+o+'</option>'}).join('')+'</select></div>';
    if(fd.type==='textarea')return '<div class="field-group"><label>'+fd.label+'</label><textarea id="f_'+fd.key+'" rows="3"></textarea></div>';
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
  }).catch(function(){showToast('保存失败')});
};
document.getElementById('modal').onclick=function(e){if(e.target===this)this.classList.remove('active')};

// ---------- 快速输入（调用 /api/voice 自动保存） ----------
document.getElementById('quickInput').addEventListener('keypress',function(e){
  if(e.key!=='Enter')return;
  var text=this.value.trim();
  if(!text)return;
  var self=this;
  apiFetch('/api/voice',{method:'POST',body:JSON.stringify({text:text})}).then(function(r){return r.json()}).then(function(d){
    showToast(d.message||'已处理');
    self.value='';
    refreshCounts(function(){renderHome();});
  }).catch(function(){showToast('处理失败')});
});

// ---------- 聚焦页 ----------
function loadFocus(){
  Promise.all([apiFetch('/api/state').then(function(r){return r.json()})]).then(function(arr){
    var st=arr[0]||{};
    var s=st.stats||{};
    document.getElementById('statSleep').textContent=s.avgSleep?s.avgSleep.toFixed(1):'--';
    document.getElementById('statEmotion').textContent=s.avgEmotion?s.avgEmotion.toFixed(1):'--';
    document.getElementById('statExercise').textContent=(s.exercise30!==undefined)?s.exercise30:'--';
    document.getElementById('focusScore').textContent=(st.balance!==undefined)?st.balance:'--';
    document.getElementById('focusDesc').textContent=st.desc||'';
    renderFocusCenters();
  }).catch(function(){});
  function renderFocusCenters(){
    var cg=document.getElementById('focusCenters');
    cg.innerHTML='';
    CENTERS.forEach(function(c){
      var pct=centerProgress(c);
      var card=document.createElement('div');
      card.className='center-card';
      card.innerHTML='<div class="icon-wrap" style="background:'+c.color+'"><i class="fas '+c.icon+'"></i></div><div class="name">'+c.name+'</div><div class="desc">'+c.desc+'</div><div class="pct">'+pct+'%</div><div class="progress"><div class="progress-bar" style="width:'+pct+'%"></div></div>';
      card.onclick=function(){switchTab('home');setTimeout(function(){toggleCenter(c.id)},100)};
      cg.appendChild(card);
    });
  }
}

// ---------- 报告页 ----------
function loadReport(){
  apiFetch('/api/state').then(function(r){return r.json()}).then(function(st){
    var html='';
    html+='<div class="report-card"><h3><i class="fas fa-lightbulb"></i> 30天洞察</h3>';
    if(st.insights&&st.insights.length){
      st.insights.forEach(function(ins){
        html+='<div class="insight-row"><i class="fas '+(ins.icon||'fa-circle-dot')+'"></i><div class="ir-text"><b>'+ins.title+'</b>：'+ins.text+'</div></div>';
      });
    }else{html+='<p>暂无洞察数据。</p>';}
    html+='</div>';

    html+='<div class="report-card"><h3><i class="fas fa-database"></i> 各模块数据统计</h3><div class="stat-grid">';
    MODULES.forEach(function(m){
      var v=(st.stats&&st.stats[m.id]!==undefined)?st.stats[m.id]:(moduleCounts[m.id]||0);
      html+='<div class="si"><span class="sn"><i class="fas '+m.icon+'" style="color:'+m.color+'"></i> '+m.label+'</span><span class="sv">'+v+' 条</span></div>';
    });
    html+='</div></div>';

    html+='<div class="report-card"><h3><i class="fas fa-bullseye"></i> 下一步建议</h3>';
    if(st.suggestions&&st.suggestions.length){
      st.suggestions.forEach(function(sg){html+='<span class="tag">'+escapeHtml(sg)+'</span>'});
    }else{html+='<p>暂无建议。</p>';}
    html+='</div>';

    document.getElementById('reportContent').innerHTML=html;
  }).catch(function(){document.getElementById('reportContent').innerHTML='<div class="report-card"><h3><i class="fas fa-info-circle"></i> 加载失败</h3><p>请检查后端服务。</p></div>';});
}

// ---------- 智能助手 ----------
function addChat(text,isUser){var list=document.getElementById('chatList');var msg=document.createElement('div');msg.className='chat-msg '+(isUser?'user':'bot');msg.textContent=text;list.appendChild(msg);list.scrollTop=list.scrollHeight;}
function sendChat(){
  var input=document.getElementById('chatInput');
  var text=input.value.trim();
  if(!text)return;
  addChat(text,true);
  input.value='';
  apiFetch('/api/voice',{method:'POST',body:JSON.stringify({text:text})}).then(function(r){return r.json()}).then(function(d){
    addChat(d.message||'已处理',false);
    refreshCounts(function(){renderHome();});
  }).catch(function(){addChat('处理失败，请稍后再试',false)});
}
document.getElementById('chatSend').onclick=sendChat;
document.getElementById('chatInput').addEventListener('keypress',function(e){if(e.key==='Enter')sendChat()});

// ---------- 我的页 ----------
function loadProfile(){
  apiFetch('/api/avatar').then(function(r){return r.json()}).then(function(a){
    if(a&&a.emoji){document.getElementById('pfEmoji').textContent=a.emoji;document.getElementById('avatarBtn').textContent=a.emoji;}
    if(a&&a.name)document.getElementById('pfName').textContent=a.name;
  }).catch(function(){});
}
function showStats(){
  apiFetch('/api/state').then(function(r){return r.json()}).then(function(st){
    var s=st.stats||{};
    var html='<div class="profile-info"><div class="emoji">📊</div><div class="name">数据统计</div></div>';
    html+='<div class="stat-grid">';
    MODULES.forEach(function(m){
      var v=s[m.id]!==undefined?s[m.id]:(moduleCounts[m.id]||0);
      html+='<div class="si"><span class="sn"><i class="fas '+m.icon+'" style="color:'+m.color+'"></i> '+m.label+'</span><span class="sv">'+v+' 条</span></div>';
    });
    html+='</div>';
    html+='<div style="margin-top:12px;text-align:center;color:var(--text2);font-size:13px">平衡指数：<b style="color:var(--primary)">'+st.balance+'</b> 分 · '+st.desc+'</div>';
    document.getElementById('profile').innerHTML+='<div id="statsModal" class="modal active"><div class="modal-box"><h3>数据统计</h3>'+html+'<button class="btn-save" onclick="document.getElementById(\\'statsModal\\').remove()">关闭</button></div></div>';
  }).catch(function(){showToast('加载失败')});
}
function backupData(){
  fetch('/api/backup').then(function(r){return r.json()}).then(function(data){
    var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');
    a.href=url;a.download='qiezi-backup-'+Date.now()+'.json';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('备份已下载');
  }).catch(function(){showToast('备份失败')});
}
function changeAvatar(){
  var emoji=prompt('输入一个表情作为头像（如 🍆 🐱 🌟）','🍆');
  if(!emoji)return;
  var name=prompt('输入昵称','茄子管家用户');
  apiFetch('/api/avatar',{method:'POST',body:JSON.stringify({emoji:emoji,name:name||'茄子管家用户'})}).then(function(){loadProfile();showToast('已更新头像')}).catch(function(){showToast('保存失败')});
}
function clearCache(){if(confirm('确认清除本地缓存并刷新？')){localStorage.clear();showToast('缓存已清除');setTimeout(function(){location.reload()},800);}}
function showAbout(){showToast('茄子管家·重心版 v4.0 \\n4重心 · 8模块 · 真实数据洞察');}
document.getElementById('avatarBtn').onclick=changeAvatar;

// ---------- 初始化 ----------
refreshCounts(function(){
  renderHome();
  apiFetch('/api/state').then(function(r){return r.json()}).then(function(d){
    if(d&&d.balance!==undefined){document.getElementById('balanceScore').textContent=d.balance;document.getElementById('balanceDesc').textContent=d.desc||'';}
  }).catch(function(){});
  loadProfile();
});
</script>
</body>
</html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log('🍆 茄子管家·重心版运行在端口 ' + PORT));
