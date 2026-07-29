const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 前端静态文件
if (fs.existsSync(path.join(__dirname, 'frontend'))) {
  app.use(express.static('frontend'));
}

// ============ 数据读写 ============
function readData(m) {
  const f = path.join(DATA_DIR, m + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
}
function writeData(m, d) {
  fs.writeFileSync(path.join(DATA_DIR, m + '.json'), JSON.stringify(d, null, 2));
}

// ============ 修复：health 和 insights 必须在通用路由前 ============
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '5.1' }));

app.get('/api/insights', (req, res) => {
  const all = {};
  const modules = ['finance','sleep','exercise','emotion','diet','diary','photo','think','work','body','relation','growth','spirit','home','travel'];
  modules.forEach(m => { all[m] = readData(m); });
  res.json(generateInsights(all));
});

// ============ 通用 CRUD API ============
app.get('/api/:module', (req, res) => {
  res.json(readData(req.params.module));
});
app.post('/api/:module', (req, res) => {
  writeData(req.params.module, req.body);
  res.json({ success: true });
});
app.post('/api/:module/add', (req, res) => {
  const d = readData(req.params.module);
  d.push(req.body);
  writeData(req.params.module, d);
  res.json({ success: true, id: req.body.id });
});
app.delete('/api/:module/:id', (req, res) => {
  const d = readData(req.params.module);
  writeData(req.params.module, d.filter(i => i.id !== req.params.id));
  res.json({ success: true });
});

// ============ 完整洞察引擎 ============
function generateInsights(data) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const monthAgo = new Date(now); monthAgo.setDate(now.getDate() - 30);
  const ms = monthAgo.toISOString().split('T')[0];
  
  const result = {
    daily: {},
    weekly: {},
    monthly: {},
    correlations: [],
    suggestions: [],
    growth: {},
    milestones: [],
    compoundRate: null
  };

  // ---- 1. 每日状态 ----
  const te = (data.emotion || []).find(e => e.date === today);
  const ts = (data.sleep || []).find(s => s.date === today);
  result.daily = {
    mood: te ? parseFloat(te.rating) || 0 : null,
    sleep: ts ? parseFloat(ts.hours) || 0 : null
  };

  // ---- 2. 睡眠-情绪关联 ----
  const se = (data.sleep || []).filter(s => s.date >= ms).map(s => {
    const e = (data.emotion || []).find(em => em.date === s.date);
    return e ? { h: parseFloat(s.hours) || 0, m: parseFloat(e.rating) || 0 } : null;
  }).filter(Boolean);
  if (se.length >= 5) {
    const gd = se.filter(d => d.h >= 7);
    const bd = se.filter(d => d.h < 6);
    if (gd.length && bd.length) {
      const ag = gd.reduce((a,b) => a + b.m, 0) / gd.length;
      const ab = bd.reduce((a,b) => a + b.m, 0) / bd.length;
      result.correlations.push({
        type: 'sleep_mood',
        title: '😴 睡眠与情绪',
        detail: `≥7h时${ag.toFixed(1)}分，<6h时${ab.toFixed(1)}分，差${(ag-ab).toFixed(1)}分`
      });
      if (ag - ab > 1) {
        result.suggestions.push({
          id: 's1',
          text: '💡 睡眠对情绪影响显著，建议本周至少3天23:00前睡',
          module: 'sleep',
          status: 'pending'
        });
      }
    }
  }

  // ---- 3. 锻炼-情绪关联 ----
  const exm = (data.exercise || []).filter(e => e.date >= ms).map(e => {
    const em = (data.emotion || []).find(em => em.date === e.date);
    return em ? { m: parseFloat(em.rating) || 0 } : null;
  }).filter(Boolean);
  const noEx = (data.emotion || []).filter(e => e.date >= ms && !(data.exercise || []).some(ex => ex.date === e.date));
  if (exm.length >= 3 && noEx.length >= 3) {
    const ae = exm.reduce((a,b) => a + b.m, 0) / exm.length;
    const an = noEx.reduce((a,b) => a + parseFloat(b.rating) || 0, 0) / noEx.length;
    result.correlations.push({
      type: 'exercise_mood',
      title: '🏃 锻炼与情绪',
      detail: `锻炼日${ae.toFixed(1)}分，非锻炼日${an.toFixed(1)}分，差${(ae-an).toFixed(1)}分`
    });
    if (ae - an > 0.8) {
      result.suggestions.push({
        id: 's2',
        text: '💪 锻炼后情绪明显提升，每周至少安排2次运动',
        module: 'exercise',
        status: 'pending'
      });
    }
  }

  // ---- 4. 饮食结构 ----
  const diet = (data.diet || []).filter(d => d.date >= ms);
  if (diet.length >= 7) {
    const veg = diet.filter(d => d.content && (d.content.includes('蔬菜') || d.content.includes('青菜') || d.content.includes('沙拉'))).length;
    const meat = diet.filter(d => d.content && (d.content.includes('肉') || d.content.includes('鸡胸') || d.content.includes('牛肉'))).length;
    const carb = diet.filter(d => d.content && (d.content.includes('饭') || d.content.includes('面') || d.content.includes('面包'))).length;
    result.correlations.push({
      type: 'diet_structure',
      title: '🥗 饮食结构',
      detail: `近30天：蔬菜${veg}次，肉类${meat}次，碳水${carb}次`
    });
    if (veg < diet.length * 0.3) {
      result.suggestions.push({ id: 's3', text: '🥬 蔬菜摄入偏少，建议每餐增加绿叶蔬菜', module: 'diet', status: 'pending' });
    }
    if (meat < diet.length * 0.2) {
      result.suggestions.push({ id: 's4', text: '🥩 蛋白质摄入偏少，建议增加鸡胸肉或鱼', module: 'diet', status: 'pending' });
    }
  }

  // ---- 5. 摄影成长 ----
  const photos = (data.photo || []).filter(p => p.date >= ms);
  if (photos.length >= 3) {
    const q = photos.reduce((a,b) => a + (parseFloat(b.quality) || 0), 0) / photos.length;
    const l = photos.reduce((a,b) => a + (parseFloat(b.learning) || 0), 0) / photos.length;
    result.correlations.push({
      type: 'photo_growth',
      title: '📷 摄影成长',
      detail: `本月${photos.length}次，质量${q.toFixed(1)}/5，学习${l.toFixed(1)}/5`
    });
    if (q < 3) {
      result.suggestions.push({ id: 's5', text: '📷 近期摄影质量偏低，建议专注一个主题深入练习', module: 'photo', status: 'pending' });
    }
  }

  // ---- 6. 成长阶段 ----
  const total = Math.max(
    (data.emotion || []).length,
    (data.sleep || []).length,
    (data.exercise || []).length,
    1
  );
  let phase, desc, next;
  if (total < 7) { phase = '🌱 萌芽期'; desc = '开始记录，让习惯成为自然'; next = '7天连续记录'; }
  else if (total < 30) { phase = '🌿 成长期'; desc = '你的记录习惯正在形成'; next = '30天连续记录'; }
  else if (total < 90) { phase = '🌳 稳定期'; desc = '数据开始有意义了'; next = '90天连续记录'; }
  else if (total < 180) { phase = '🍇 成熟期'; desc = '系统已经足够了解你'; next = '180天连续记录'; }
  else if (total < 365) { phase = '🌟 默契期'; desc = '系统和你在共同成长'; next = '365天连续记录'; }
  else { phase = '♾️ 共生期'; desc = '系统是你的长期伙伴'; next = '继续记录，年度对比'; }
  result.growth = {
    days: total,
    phase: phase,
    phaseDesc: desc,
    nextMilestone: next,
    progress: Math.min(100, Math.round((total / 365) * 100))
  };

  // ---- 7. 里程碑 ----
  const milestones = [];
  if (total >= 7) milestones.push({ name: '🌱 连续7天', date: today, icon: '🌱' });
  if (total >= 30) milestones.push({ name: '🌿 连续30天', date: today, icon: '🌿' });
  if (total >= 90) milestones.push({ name: '🌳 连续90天', date: today, icon: '🌳' });
  if (total >= 180) milestones.push({ name: '🍇 连续180天', date: today, icon: '🍇' });
  if (total >= 365) milestones.push({ name: '🎂 连续365天', date: today, icon: '🎂' });
  result.milestones = milestones;

  // ---- 8. 月度总结 ----
  const me = (data.emotion || []).filter(e => e.date >= ms);
  if (me.length > 0) {
    const avg = me.reduce((a,b) => a + parseFloat(b.rating) || 0, 0) / me.length;
    const prevMs = new Date(now); prevMs.setDate(now.getDate() - 60);
    const pms = prevMs.toISOString().split('T')[0];
    const pme = (data.emotion || []).filter(e => e.date >= pms && e.date < ms);
    let change = 0;
    if (pme.length > 0) {
      const pavg = pme.reduce((a,b) => a + parseFloat(b.rating) || 0, 0) / pme.length;
      change = avg - pavg;
    }
    result.monthly = {
      mood: avg.toFixed(1),
      days: me.length,
      change: change,
      changeText: change > 0.3 ? `📈 比上月提升${change.toFixed(1)}分` : change < -0.3 ? `📉 比上月下降${Math.abs(change).toFixed(1)}分` : '➡️ 与上月基本持平'
    };
  }

  // ---- 9. 复利速率 ----
  const allEmo = (data.emotion || []).sort((a,b) => a.date > b.date ? 1 : -1);
  if (allEmo.length >= 30) {
    const first30 = allEmo.slice(0, 30);
    const last30 = allEmo.slice(-30);
    const fAvg = first30.reduce((a,b) => a + parseFloat(b.rating) || 0, 0) / first30.length;
    const lAvg = last30.reduce((a,b) => a + parseFloat(b.rating) || 0, 0) / last30.length;
    const rate = (lAvg - fAvg) / (allEmo.length / 30);
    result.compoundRate = {
      value: rate,
      text: rate > 0.1 ? `📈 每月改善${rate.toFixed(2)}分` :
            rate < -0.1 ? `📉 每月下降${Math.abs(rate).toFixed(2)}分，需要关注` :
            '➡️ 保持稳定，继续积累'
    };
  }

  return result;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍆 茄子管家 v5.1 运行在 http://localhost:${PORT}`);
});
