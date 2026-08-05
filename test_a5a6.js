// A5 家务→居住 + A6 阅读→成长 联动单测
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data/qiezi-test-a5a6.db');
try { fs.unlinkSync(DB_PATH); } catch(e) {}
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS records (
  mid TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  created TEXT NOT NULL, updated TEXT NOT NULL,
  PRIMARY KEY (mid, id)
)`);

function readData(mid) {
  return db.prepare('SELECT data FROM records WHERE mid=? ORDER BY created').all(mid).map(r => JSON.parse(r.data));
}
function writeData(mid, list) {
  db.prepare('DELETE FROM records WHERE mid=?').run(mid);
  const ins = db.prepare('INSERT INTO records (mid,id,data,created,updated) VALUES (?,?,?,?,?)');
  const now = new Date().toISOString();
  list.forEach(item => ins.run(mid, item.id, JSON.stringify(item), item.created || now, now));
}

// === A5: housework/complete 联动逻辑 ===
function houseworkComplete(taskId) {
  const chores = readData('housework');
  const task = chores.find(c => c.id === taskId);
  if (!task) return { success: false, linkedModules: [] };
  task.lastDone = new Date().toISOString().split('T')[0];
  task.completedAt = new Date().toISOString();
  writeData('housework', chores);
  const linkedModules = [];
  const linkId = task.id + '-' + task.lastDone;
  if (!readData('home').some(h => h._linkedModule === 'housework' && h._linkedId === linkId)) {
    const actionMap = {'扫地':'打扫','拖地':'打扫','洗碗':'打扫','整理厨房台面':'整理','铺床':'整理','擦桌子':'打扫','换床单':'整理','清理卫生间':'打扫','倒垃圾':'打扫','拖阳台':'打扫','整理衣柜':'整理','擦窗':'打扫'};
    const action = actionMap[task.task] || '打扫';
    const homeList = readData('home');
    homeList.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      space: task.area || '客厅', action: action,
      items: task.task, security: 3, note: '家务自动记录',
      date: task.lastDone,
      _linkedModule: 'housework', _linkedId: linkId, created: new Date().toISOString()
    });
    writeData('home', homeList);
    linkedModules.push('home');
  }
  return { success: true, linkedModules, task };
}

// === A6: reading POST 联动逻辑 ===
function readingAdd({ bookName, author, progress, date, duration, totalPages, currentPage }) {
  const readings = readData('reading');
  const newId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  readings.push({ id: newId, bookName, author: author || '', progress: progress || 0,
    date: date || new Date().toISOString().split('T')[0],
    duration: parseInt(duration) || 0, totalPages: parseInt(totalPages) || 0, currentPage: parseInt(currentPage) || 0,
    createdAt: new Date().toISOString() });
  writeData('reading', readings);
  const linkedModules = [];
  if (!readData('growth').some(g => g._linkedModule === 'reading' && g._linkedId === newId)) {
    const growthList = readData('growth');
    growthList.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      type: '学习', skill: '阅读 - ' + bookName,
      method: '看书', duration: parseInt(duration) || 0,
      understanding: '', progress: progress || ('读 ' + (currentPage || 0) + '/' + (totalPages || 0) + ' 页'),
      obstacle: '', plan: '', output: '',
      content: '《' + bookName + '》' + (author ? ' - ' + author : '') + ' 阅读 ' + (duration || 0) + ' 分钟',
      date: date || new Date().toISOString().split('T')[0],
      _linkedModule: 'reading', _linkedId: newId, created: new Date().toISOString()
    });
    writeData('growth', growthList);
    linkedModules.push('growth');
  }
  return { success: true, linkedModules, id: newId };
}

// === 初始化测试数据 ===
writeData('housework', [
  { id: 't1', task: '扫地', area: '客厅', frequency: '每日', lastDone: '2026-08-03' },
  { id: 't2', task: '整理衣柜', area: '卧室', frequency: '每月', lastDo: '2026-07-01' }
]);

const tests = [
  { name: 'A5 扫地→home(打扫)', fn: () => {
    const r = houseworkComplete('t1');
    const home = readData('home');
    return r.success && r.linkedModules.includes('home') &&
      home.length === 1 && home[0].action === '打扫' && home[0].space === '客厅' &&
      home[0].items === '扫地' && home[0]._linkedModule === 'housework';
  }},
  { name: 'A5 整理衣柜→home(整理)', fn: () => {
    const r = houseworkComplete('t2');
    const home = readData('home');
    return r.success && r.linkedModules.includes('home') &&
      home.length === 2 && home[1].action === '整理' && home[1].space === '卧室';
  }},
  { name: 'A5 同任务同天不重复联动', fn: () => {
    const r = houseworkComplete('t1'); // 再完成一次（lastDo 仍是今天）
    const home = readData('home');
    return r.success && !r.linkedModules.includes('home') && home.length === 2;
  }},
  { name: 'A5 不存在任务→失败', fn: () => {
    const r = houseworkComplete('not-exist');
    return !r.success && !r.linkedModules.includes('home');
  }},
  { name: 'A6 阅读→growth', fn: () => {
    const r = readingAdd({ bookName: '深度工作', author: 'Cal Newport', duration: 45, currentPage: 120, totalPages: 300 });
    const growth = readData('growth');
    return r.success && r.linkedModules.includes('growth') &&
      growth.length === 1 && growth[0].type === '学习' && growth[0].method === '看书' &&
      growth[0].skill === '阅读 - 深度工作' && growth[0]._linkedModule === 'reading' &&
      growth[0].content.includes('深度工作') && growth[0].content.includes('45');
  }},
  { name: 'A6 阅读无作者→growth', fn: () => {
    const r = readingAdd({ bookName: 'Atomic Habits', duration: 30 });
    const growth = readData('growth');
    return r.success && growth.length === 2 && !growth[1].content.includes(' - ');
  }},
  { name: 'A6 阅读无时长→growth(0)', fn: () => {
    const r = readingAdd({ bookName: '测试书' });
    const growth = readData('growth');
    return r.success && growth.length === 3 && growth[2].duration === 0;
  }},
];

let pass = 0, fail = 0;
tests.forEach(t => {
  const ok = t.fn();
  if (ok) { console.log('✅', t.name); pass++; }
  else { console.log('❌', t.name); fail++; }
});

console.log('\n=== 测试结果 ===\n通过:', pass, '失败:', fail);
db.close();
try { fs.unlinkSync(DB_PATH); } catch(e) {}
process.exit(fail > 0 ? 1 : 0);
