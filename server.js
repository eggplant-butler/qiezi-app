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
  if (!fs.existsSync(f)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(d)) return d;
    if (d && Array.isArray(d.records)) return d.records;
    return [];
  } catch (e) { return []; }
}
function writeData(m, d) {
  fs.writeFileSync(path.join(DATA_DIR, m + '.json'), JSON.stringify(d, null, 2));
}

// ============ 修复：health 和 insights 必须在通用路由前 ============
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '5.1' }));

// ============ 今日之问 API ============
const QUESTION_POOL = [
  '今天你是在消费还是在投资？',
  '今天做的哪件事让你离目标更近了一步？',
  '如果今天重来，你会改变什么？',
  '你今天有没有照顾好自己的身体或情绪？',
  '今天有什么让你感到感恩的事？',
  '你今天有没有做一件让自己骄傲的事？',
  '今天你有没有说出一句该说的话？',
  '今天你学到了什么新东西？',
  '今天你最大的精力消耗是什么？',
  '今天你最大的情绪波动是什么？',
  '今天你是不是在用行动面对你的目标？',
  '今天你有没有为自己留出安静的时间？',
  '今天你有没有跟值得的人说一句值得的话？',
  '今天你有没有做一件真正对健康有益的事？',
  '今天有没有一个决策你希望做得更好？',
  '今天你是不是太忙而忘记照顾自己了？',
  '今天你是在靠近目标还是在远离它？',
  '今天你有没有放下什么？',
  '今天你有没有做一件让未来更自由的事？',
  '今天你过得怎么样——真实的那种？'
];

app.get('/api/daily-question', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const qs = readData('daily_questions');
  const exist = qs.find(q => q.date === today);
  if (exist) return res.json({ question: exist.question, answer: exist.answer, date: today });
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(),0,0)) / 86400000);
  const idx = dayOfYear % QUESTION_POOL.length;
  const q = QUESTION_POOL[idx];
  const newItem = { id: Date.now().toString(36)+Math.random().toString(36).slice(2,6), question:q, date:today, answer:null, depthScore:null };
  qs.push(newItem);
  writeData('daily_questions', qs);
  res.json({ question:q, answer:null, date:today });
});

app.post('/api/daily-question/answer', (req, res) => {
  const { answer, date } = req.body;
  if (!answer) return res.json({ success:false, message:'回答不能为空' });
  const qs = readData('daily_questions');
  const target = qs.find(q => q.date === date);
  if (!target) return res.json({ success:false, message:'未找到今日问题' });
  target.answer = answer;
  target.depthScore = Math.min(5, Math.max(1, Math.ceil(answer.length / 20)));
  target.answeredAt = new Date().toISOString();
  writeData('daily_questions', qs);
  const diary = readData('diary');
  diary.push({ id: Date.now().toString(36)+Math.random().toString(36).slice(2,6), content:'📝 今日之问回答：'+answer, date, rating:target.depthScore, source:'daily_question' });
  writeData('diary', diary);
  res.json({ success:true, message:'回答已保存', depthScore:target.depthScore });
});

app.get('/api/daily-question/history', (req, res) => {
  res.json(readData('daily_questions').sort((a,b) => a.date < b.date ? 1 : -1));
});

app.get('/api/insights', (req, res) => {
  const all = {};
  const modules = ['finance','sleep','exercise','emotion','diet','diary','photo','think','work','body','relation','growth','spirit','home','travel'];
  modules.forEach(m => { all[m] = readData(m); });
  res.json(generateInsights(all));
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

// ============================================================
// 闪念笔记 API
// ============================================================
const MODULE_KEYWORDS = {
  finance: ['花了','买了','消费','支出','收入','工资','提成','付了','付款','转账','支付宝','微信','账单','预算','省钱','存款','借款','还钱','欠款','利息','股票','理财','基金','保险','报销','发票'],
  sleep: ['睡了','醒','困','失眠','做梦','作息','熬夜','打盹','午休','睡不着','睡眠','困倦','疲惫','午睡','通宵','半夜','凌晨'],
  exercise: ['跑了','走了','跳了','练了','运动','力量','瑜伽','健身','出汗','拉伸','骑行','游泳','跑步','走路','散步','俯卧撑','仰卧起坐','深蹲','平板支撑'],
  emotion: ['感觉','心情','开心','焦虑','平静','烦躁','情绪','状态','难过','兴奋','抑郁','紧张','放松','疲惫','压力','委屈','愤怒','喜悦','悲伤','恐惧'],
  diet: ['吃了','喝了','早餐','午餐','晚餐','加餐','水果','零食','咖啡','饮','水','外卖','堂食','自己做饭','蔬菜','肉','鱼','蛋','奶'],
  photo: ['拍了','相机','镜头','快门','光圈','街拍','人像','构图','调色','摄影','照片','修图','后期'],
  think: ['想了','复盘','决定','判断','认为','反思','方向','目标','纠结','思考','权衡','选择','犹豫','决策','总结','感悟','领悟']
};

app.post('/api/quick-note', (req, res) => {
  const { content } = req.body;
  if (!content) return res.json({ success: false, message: '内容不能为空' });
  let suggested = 'diary';
  let maxScore = 0;
  for (const [module, keywords] of Object.entries(MODULE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) { if (content.includes(kw)) score++; }
    if (score > maxScore) { maxScore = score; suggested = module; }
  }
  const notes = readData('quick_notes');
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    content, createdAt: new Date().toISOString(), date: new Date().toISOString().split('T')[0],
    classified: false, suggestedModule: suggested, accepted: false
  };
  notes.push(note);
  writeData('quick_notes', notes);
  const moduleNames = { finance:'财务', sleep:'睡眠', exercise:'锻炼', emotion:'情绪', diet:'饮食', photo:'摄影', think:'认知思考', diary:'日记' };
  res.json({
    success: true, noteId: note.id,
    message: `✅ 已保存，建议归入「${moduleNames[suggested] || '日记'}」`,
    suggested, suggestedName: moduleNames[suggested] || '日记'
  });
});

app.get('/api/quick-notes', (req, res) => {
  res.json(readData('quick_notes').sort((a,b) => a.createdAt < b.createdAt ? 1 : -1));
});

app.post('/api/quick-note/classify', (req, res) => {
  const { noteId, targetModule } = req.body;
  const notes = readData('quick_notes');
  const note = notes.find(n => n.id === noteId);
  if (!note) return res.json({ success: false, message: '未找到笔记' });
  note.classified = true; note.targetModule = targetModule; note.accepted = true;
  note.classifiedAt = new Date().toISOString();
  writeData('quick_notes', notes);
  const targetData = readData(targetModule);
  targetData.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    content: note.content, date: note.date, source: 'quick_note', createdAt: note.createdAt
  });
  writeData(targetModule, targetData);
  res.json({ success: true, message: `✅ 已归类到 ${targetModule}` });
});

// ============================================================
// 缴费管理 API
// ============================================================
app.post('/api/bill', (req, res) => {
  const { name, amount, dueDate, period, category, note } = req.body;
  if (!name || !amount || !dueDate) return res.json({ success: false, message: '请填写完整信息' });
  const bills = readData('bills');
  const bill = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name, amount: parseFloat(amount), dueDate, period: period || '每月',
    category: category || '生活', note: note || '', paid: false,
    createdAt: new Date().toISOString()
  };
  bills.push(bill); writeData('bills', bills);
  res.json({ success: true, bill });
});

app.get('/api/bills', (req, res) => {
  const now = new Date(), today = now.toISOString().split('T')[0];
  const processed = readData('bills').map(b => {
    const due = new Date(b.dueDate);
    const days = Math.ceil((due - now) / 86400000);
    return { ...b, daysRemaining: days, status: b.paid ? 'paid' : (days < 0 ? 'overdue' : (days <= 7 ? 'upcoming' : 'normal')) };
  });
  res.json(processed.sort((a,b) => a.daysRemaining - b.daysRemaining));
});

app.post('/api/bill/pay', (req, res) => {
  const { billId } = req.body;
  const bills = readData('bills');
  const bill = bills.find(b => b.id === billId);
  if (!bill) return res.json({ success: false, message: '未找到账单' });
  bill.paid = true; bill.paidAt = new Date().toISOString();
  writeData('bills', bills);
  const finance = readData('finance');
  finance.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    type: '支出', category: bill.category || '生活缴费', amount: bill.amount,
    date: new Date().toISOString().split('T')[0], merchant: bill.name,
    note: `💳 缴费：${bill.name}`, source: 'bill'
  });
  writeData('finance', finance);
  res.json({ success: true, message: `✅ ${bill.name} 已标记为已缴` });
});

app.delete('/api/bill/:id', (req, res) => {
  const bills = readData('bills');
  writeData('bills', bills.filter(b => b.id !== req.params.id));
  res.json({ success: true });
});

// ============================================================
// 阅读打卡 API
// ============================================================
app.post('/api/reading', (req, res) => {
  const { bookName, author, progress, date, duration, totalPages, currentPage } = req.body;
  if (!bookName) return res.json({ success: false, message: '请输入书名' });
  const readings = readData('reading');
  readings.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    bookName, author: author || '', progress: progress || 0, date: date || new Date().toISOString().split('T')[0],
    duration: parseInt(duration) || 0, totalPages: parseInt(totalPages) || 0, currentPage: parseInt(currentPage) || 0,
    createdAt: new Date().toISOString()
  });
  writeData('reading', readings);
  res.json({ success: true });
});

app.get('/api/readings', (req, res) => {
  res.json(readData('reading').sort((a,b) => a.date < b.date ? 1 : -1));
});

app.get('/api/reading/stats', (req, res) => {
  const readings = readData('reading');
  const now = new Date(), today = now.toISOString().split('T')[0];
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const monthReadings = readings.filter(r => r.date >= monthStart && r.date <= today);
  const totalDays = new Set(readings.map(r => r.date)).size;
  const monthDays = new Set(monthReadings.map(r => r.date)).size;
  const books = new Set(readings.map(r => r.bookName));
  res.json({ totalReadings: readings.length, totalDays, monthDays, totalBooks: books.size, todayRead: readings.some(r => r.date === today) });
});

// ============================================================
// 家务引擎 API
// ============================================================
const HOUSE_TASKS = [
  { task: '扫地', area: '客厅', frequency: '每日' },
  { task: '拖地', area: '客厅', frequency: '每日' },
  { task: '洗碗', area: '厨房', frequency: '每日' },
  { task: '整理厨房台面', area: '厨房', frequency: '每日' },
  { task: '铺床', area: '卧室', frequency: '每日' },
  { task: '擦桌子', area: '卧室', frequency: '每周' },
  { task: '换床单', area: '卧室', frequency: '每两周' },
  { task: '清理卫生间', area: '卫生间', frequency: '每周' },
  { task: '倒垃圾', area: '卫生间', frequency: '每日' },
  { task: '拖阳台', area: '阳台', frequency: '每周' },
  { task: '整理衣柜', area: '卧室', frequency: '每月' },
  { task: '擦窗', area: '客厅', frequency: '每月' }
];

app.get('/api/housework', (req, res) => {
  const chores = readData('housework');
  const modeData = readData('housework_mode');
  const mode = modeData[0]?.mode || 'normal';
  const now = new Date();
  const processed = chores.map(c => {
    const last = c.lastDone || '2026-01-01';
    const daysSince = Math.floor((now - new Date(last)) / 86400000);
    const freqMap = { '每日': 1, '每周': 7, '每两周': 14, '每月': 30 };
    const threshold = freqMap[c.frequency] || 1;
    const overdue = daysSince >= threshold;
    return { ...c, daysSince, overdue, status: overdue ? '待做' : '已完成' };
  });
  const grouped = {};
  processed.forEach(c => {
    if (!grouped[c.area]) grouped[c.area] = [];
    grouped[c.area].push(c);
  });
  const sorted = processed.sort((a,b) => {
    if (a.overdue && !b.overdue) return -1;
    if (!a.overdue && b.overdue) return 1;
    return a.daysSince - b.daysSince;
  });
  const urgent = sorted.filter(c => c.overdue);
  const daily = sorted.filter(c => c.frequency === '每日' && !c.overdue);
  res.json({ grouped, urgent, daily, mode, all: sorted });
});

app.post('/api/housework/complete', (req, res) => {
  const { taskId } = req.body;
  const chores = readData('housework');
  const task = chores.find(c => c.id === taskId);
  if (!task) return res.json({ success: false, message: '未找到任务' });
  task.lastDone = new Date().toISOString().split('T')[0];
  task.completedAt = new Date().toISOString();
  writeData('housework', chores);
  res.json({ success: true, message: `✅ ${task.task} 已完成！` });
});

app.post('/api/housework/mode', (req, res) => {
  const { mode } = req.body;
  if (!['normal', 'busy', 'rest'].includes(mode)) return res.json({ success: false, message: '无效模式' });
  writeData('housework_mode', [{ mode, updatedAt: new Date().toISOString() }]);
  const modeNames = { normal: '正常', busy: '忙', rest: '闲' };
  res.json({ success: true, message: `✅ 已切换至「${modeNames[mode]}」模式` });
});

app.post('/api/housework/add', (req, res) => {
  const { task, area, frequency } = req.body;
  if (!task || !area || !frequency) return res.json({ success: false, message: '请填写完整信息' });
  const chores = readData('housework');
  const newTask = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    task, area, frequency, lastDone: null, createdAt: new Date().toISOString()
  };
  chores.push(newTask);
  writeData('housework', chores);
  res.json({ success: true, task: newTask });
});

app.delete('/api/housework/:id', (req, res) => {
  const chores = readData('housework');
  writeData('housework', chores.filter(c => c.id !== req.params.id));
  res.json({ success: true });
});

// ============================================================
// 社交人脉 API
// ============================================================
app.post('/api/contact', (req, res) => {
  const { name, relation, birthday, phone, note } = req.body;
  if (!name) return res.json({ success: false, message: '请输入姓名' });
  const contacts = readData('contacts');
  contacts.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name, relation: relation || '朋友', birthday: birthday || null,
    phone: phone || '', note: note || '', lastContact: null,
    interactions: [], createdAt: new Date().toISOString()
  });
  writeData('contacts', contacts);
  res.json({ success: true });
});

app.get('/api/contacts', (req, res) => {
  const contacts = readData('contacts');
  const now = new Date();
  const processed = contacts.map(c => {
    let daysUntilBirthday = null;
    if (c.birthday) {
      const bday = new Date(c.birthday);
      const thisYear = new Date(now.getFullYear(), bday.getMonth(), bday.getDate());
      daysUntilBirthday = Math.ceil((thisYear - now) / 86400000);
      if (daysUntilBirthday < 0) {
        const nextYear = new Date(now.getFullYear() + 1, bday.getMonth(), bday.getDate());
        daysUntilBirthday = Math.ceil((nextYear - now) / 86400000);
      }
    }
    const lastContact = c.interactions?.length > 0 ? c.interactions[c.interactions.length - 1].date : null;
    const daysSinceContact = lastContact ? Math.floor((now - new Date(lastContact)) / 86400000) : null;
    return { ...c, daysUntilBirthday, daysSinceContact, lastContact, interactionCount: c.interactions?.length || 0 };
  });
  const sorted = processed.sort((a,b) => {
    if (a.daysUntilBirthday !== null && b.daysUntilBirthday !== null) return a.daysUntilBirthday - b.daysUntilBirthday;
    if (a.daysUntilBirthday !== null) return -1;
    if (b.daysUntilBirthday !== null) return 1;
    return (a.daysSinceContact || 999) - (b.daysSinceContact || 999);
  });
  res.json(sorted);
});

app.post('/api/contact/interact', (req, res) => {
  const { contactId, content, rating } = req.body;
  if (!contactId) return res.json({ success: false, message: '请选择联系人' });
  const contacts = readData('contacts');
  const contact = contacts.find(c => c.id === contactId);
  if (!contact) return res.json({ success: false, message: '未找到联系人' });
  if (!contact.interactions) contact.interactions = [];
  contact.interactions.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    date: new Date().toISOString().split('T')[0],
    content: content || '互动记录', rating: parseInt(rating) || 3,
    createdAt: new Date().toISOString()
  });
  contact.lastContact = new Date().toISOString().split('T')[0];
  writeData('contacts', contacts);
  if (parseInt(rating) <= 2) {
    const emotion = readData('emotion');
    emotion.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      date: new Date().toISOString().split('T')[0], rating: parseInt(rating),
      tags: ['社交', contact.name], note: `与 ${contact.name} 互动，感受评分 ${rating}/5`, source: 'social'
    });
    writeData('emotion', emotion);
  }
  res.json({ success: true, message: `✅ 已记录与 ${contact.name} 的互动` });
});

app.delete('/api/contact/:id', (req, res) => {
  writeData('contacts', readData('contacts').filter(c => c.id !== req.params.id));
  res.json({ success: true });
});

// ============================================================
// 成就系统 API
// ============================================================
const ACHIEVEMENTS_DEF = [
  { id: 'a1', name: '🌱 萌芽者', condition: '连续记录7天', check: (d) => d.consecutiveDays >= 7 },
  { id: 'a2', name: '🌿 坚持者', condition: '连续记录30天', check: (d) => d.consecutiveDays >= 30 },
  { id: 'a3', name: '🌳 扎根者', condition: '连续记录90天', check: (d) => d.consecutiveDays >= 90 },
  { id: 'a4', name: '📚 书虫', condition: '读完5本书', check: (d) => d.booksRead >= 5 },
  { id: 'a5', name: '💪 行动派', condition: '完成30次锻炼', check: (d) => d.exercises >= 30 },
  { id: 'a6', name: '🧠 思考者', condition: '回答7次今日之问', check: (d) => d.questionsAnswered >= 7 },
  { id: 'a7', name: '💰 储户', condition: '储蓄目标达成1个', check: (d) => d.savingsGoals >= 1 },
  { id: 'a8', name: '📸 记录者', condition: '拍摄50张作品', check: (d) => d.photos >= 50 },
  { id: 'a9', name: '❤️ 温暖者', condition: '记录10次感恩瞬间', check: (d) => d.gratitudes >= 10 },
  { id: 'a10', name: '🗣️ 连接者', condition: '与5位朋友保持联系', check: (d) => d.contactsMaintained >= 5 }
];

app.get('/api/achievements', (req, res) => {
  const achieved = readData('achievements');
  const unlocked = achieved.filter(a => a.unlocked);
  const all = ACHIEVEMENTS_DEF.map(def => {
    const existing = achieved.find(a => a.id === def.id);
    return { ...def, unlocked: existing?.unlocked || false, unlockedAt: existing?.unlockedAt || null };
  });
  res.json({ all, unlocked: all.filter(a => a.unlocked), total: ACHIEVEMENTS_DEF.length, unlockedCount: unlocked.length });
});

app.post('/api/achievements/check', (req, res) => {
  const emotion = readData('emotion');
  const sleep = readData('sleep');
  const exercise = readData('exercise');
  const reading = readData('reading');
  const questions = readData('daily_questions');
  const wish = readData('wish');
  const photo = readData('photo');
  const diary = readData('diary');
  const contacts = readData('contacts');
  
  const allDates = new Set();
  emotion.forEach(e => allDates.add(e.date));
  sleep.forEach(s => allDates.add(s.date));
  exercise.forEach(ex => allDates.add(ex.date));
  const dates = Array.from(allDates).sort();
  
  let maxStreak = 0, currentStreak = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = new Date(dates[i]);
    const prev = i > 0 ? new Date(dates[i-1]) : null;
    if (prev && (d - prev) / 86400000 === 1) { currentStreak++; }
    else { currentStreak = 1; }
    if (currentStreak > maxStreak) maxStreak = currentStreak;
  }
  
  const userData = {
    consecutiveDays: maxStreak,
    booksRead: reading.filter(r => (r.progress || 0) >= 100).length,
    exercises: exercise.length,
    questionsAnswered: questions.filter(q => q.answer).length,
    savingsGoals: wish.filter(w => w.status === '已完成').length,
    photos: photo.length,
    gratitudes: diary.filter(d => d.content && d.content.includes('感恩')).length,
    contactsMaintained: contacts.filter(c => c.interactions && c.interactions.length >= 2).length
  };
  
  const achievements = readData('achievements');
  let newUnlocked = 0;
  ACHIEVEMENTS_DEF.forEach(def => {
    const existing = achievements.find(a => a.id === def.id);
    if (!existing || !existing.unlocked) {
      if (def.check(userData)) {
        const entry = existing || { id: def.id, name: def.name, condition: def.condition };
        entry.unlocked = true;
        entry.unlockedAt = new Date().toISOString();
        if (!existing) achievements.push(entry);
        newUnlocked++;
      }
    }
  });
  if (newUnlocked > 0) writeData('achievements', achievements);
  res.json({ newUnlocked, totalUnlocked: achievements.filter(a => a.unlocked).length, achievements });
});

// ============================================================
// 工作模式 API
// ============================================================
app.get('/api/work-mode', (req, res) => {
  const mode = readData('work_mode')[0] || { mode: 'normal', updatedAt: null };
  res.json(mode);
});

app.post('/api/work-mode', (req, res) => {
  const { mode } = req.body;
  if (!['normal', 'interview', 'sales', 'coach'].includes(mode)) {
    return res.json({ success: false, message: '无效模式' });
  }
  writeData('work_mode', [{ mode, updatedAt: new Date().toISOString() }]);
  res.json({ success: true, message: `✅ 已切换至「${mode}」模式` });
});

// 面试记录
app.post('/api/interview', (req, res) => {
  const { company, position, date, status, salary, note } = req.body;
  if (!company || !position) return res.json({ success: false, message: '请填写公司和岗位' });
  const interviews = readData('interviews');
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    company,
    position,
    date: date || new Date().toISOString().split('T')[0],
    status: status || '待面试',
    salary: salary || '',
    note: note || '',
    createdAt: new Date().toISOString()
  };
  interviews.push(record);
  writeData('interviews', interviews);
  res.json({ success: true, record });
});

app.get('/api/interviews', (req, res) => {
  const interviews = readData('interviews');
  const statusOrder = { '待面试': 0, '已面试': 1, '已Offer': 2, '已拒绝': 3 };
  res.json(interviews.sort((a,b) => (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0)));
});

app.put('/api/interview/:id', (req, res) => {
  const { status, note } = req.body;
  const interviews = readData('interviews');
  const target = interviews.find(i => i.id === req.params.id);
  if (!target) return res.json({ success: false, message: '未找到记录' });
  if (status) target.status = status;
  if (note) target.note = note;
  target.updatedAt = new Date().toISOString();
  writeData('interviews', interviews);
  res.json({ success: true, message: '✅ 已更新' });
});

app.delete('/api/interview/:id', (req, res) => {
  const interviews = readData('interviews');
  writeData('interviews', interviews.filter(i => i.id !== req.params.id));
  res.json({ success: true });
});

// 技能评分
app.post('/api/skill', (req, res) => {
  const { name, score } = req.body;
  if (!name || score === undefined) return res.json({ success: false, message: '请填写技能名称和评分' });
  const skills = readData('skills');
  const skill = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name,
    score: Math.min(10, Math.max(1, parseInt(score))),
    date: new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString()
  };
  skills.push(skill);
  writeData('skills', skills);
  res.json({ success: true, skill });
});

app.get('/api/skills', (req, res) => {
  const skills = readData('skills');
  // 按技能名称分组，取最新评分
  const grouped = {};
  skills.forEach(s => {
    if (!grouped[s.name] || s.date > grouped[s.name].date) {
      grouped[s.name] = s;
    }
  });
  const latest = Object.values(grouped);
  // 计算平均分
  const avg = latest.length > 0 ? (latest.reduce((a,b) => a + b.score, 0) / latest.length).toFixed(1) : 0;
  res.json({ skills: latest, all: skills, average: avg, count: latest.length });
});

// 工作统计（KPI 进度）
app.get('/api/work-stats', (req, res) => {
  const interviews = readData('interviews');
  const skills = readData('skills');
  const offers = interviews.filter(i => i.status === '已Offer').length;
  const rejected = interviews.filter(i => i.status === '已拒绝').length;
  const pending = interviews.filter(i => i.status === '待面试').length;
  const done = interviews.filter(i => i.status === '已面试').length;
  const total = interviews.length;
  const avgSkill = skills.length > 0 ? (skills.reduce((a,b) => a + b.score, 0) / skills.length).toFixed(1) : 0;
  res.json({
    interviews: { total, pending, done, offers, rejected },
    skills: { total: skills.length, average: avgSkill },
    kpi: total > 0 ? Math.round((offers / total) * 100) : 0
  });
});

// ============================================================
// 通用 CRUD API（必须放在所有具体路由之后！）
// ============================================================
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍆 茄子管家 v5.1 运行在 http://localhost:${PORT}`);
});
