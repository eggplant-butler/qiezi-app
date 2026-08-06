// ============ 前端错误上报（最早注册，捕获所有运行时错误）============
function reportClientError(payload) {
  try {
    if (navigator.sendBeacon) {
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/api/client-error', blob);
    }
  } catch (_) {}
}
// v6.9.11: 防御性修复——在任何业务逻辑前，强制确保 #app 隐藏、#lock 覆盖全屏
// 防止 SW 缓存/外部 CSS 加载异常导致布局崩溃（锁屏漏出仪表盘）
(function(){
  var _app = document.getElementById('app');
  var _lock = document.getElementById('lock');
  if (_app) _app.style.display = 'none';
  if (_lock) { _lock.style.display = 'flex'; _lock.style.position = 'fixed'; _lock.style.inset = '0'; _lock.style.zIndex = '9999'; }
})();
window.addEventListener('error', function(e) {
  reportClientError({
    type: 'error',
    message: e.message,
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error && e.error.stack,
    url: location.href,
    userAgent: navigator.userAgent
  });
});
window.addEventListener('unhandledrejection', function(e) {
  var reason = e.reason;
  reportClientError({
    type: 'unhandledrejection',
    message: (reason && (reason.message || String(reason))) || 'unhandledrejection',
    stack: reason && reason.stack,
    url: location.href,
    userAgent: navigator.userAgent
  });
});

var TOKEN_KEY = 'qzos_token';
var TOKEN = localStorage.getItem(TOKEN_KEY) || '';
var KEY = 'qzos_';
var TODAY = new Date().toISOString().split('T')[0];
var curScene = null, editId = null, privacyOn = false;
var dataCache = {};
var insightsCache = null;
var suggestionFeedback = {};
// ====== 登录安全锁 v6.5.6：防止登录过程中被强制刷新（iPhone Safari 死循环修复） ======
// 页面加载后的前 120 秒，如果处于登录界面，禁止一切自动刷新（给用户留足输密码时间）
var __PAGE_LOAD_TS = Date.now();
var __LOGIN_GRACE_PERIOD_MS = 120 * 1000;  // 登录宽限期：2分钟
function __hasAuth() {
  try { return !!(localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY)); }
  catch(e) { return false; }
}
function __isLoginScreenVisible() {
  try {
    var lock = document.getElementById('lock');
    if (!lock) return true;  // DOM 还没加载出来，按登录页处理（安全）
    var ds = lock.style.display;
    var cs = window.getComputedStyle ? window.getComputedStyle(lock).display : ds;
    // 如果 display 不是 none 或者未设置（默认显示），说明是登录界面
    if (ds === 'none' || cs === 'none') return false;
    return true;
  } catch(e) { return true; }
}
function __isUserTypingPassword() {
  try {
    var pwdI = document.getElementById('pwdI');
    if (!pwdI) return false;
    // 密码框有焦点 或 已输入内容 → 用户正在登录操作中
    if (document.activeElement === pwdI) return true;
    if (pwdI.value && pwdI.value.length > 0) return true;
    return false;
  } catch(e) { return false; }
}
function __shouldBlockRefresh(reason) {
  // 1) 用户正在输密码 → 绝对不刷新（最高优先级）
  if (__isUserTypingPassword()) {
    console.warn('[RefreshGuard] ' + (reason||'') + ' → 用户正在输密码，BLOCK 刷新');
    return true;
  }
  // 2) 登录宽限期内 + 登录页可见 → 不刷新（用户可能正在看界面/思考密码）
  var inGracePeriod = (Date.now() - __PAGE_LOAD_TS) < __LOGIN_GRACE_PERIOD_MS;
  if (inGracePeriod && __isLoginScreenVisible()) {
    console.warn('[RefreshGuard] ' + (reason||'') + ' → 登录宽限期内（' + Math.round((__LOGIN_GRACE_PERIOD_MS - (Date.now() - __PAGE_LOAD_TS))/1000) + 's），BLOCK 刷新');
    return true;
  }
  // 3) 登录页可见 且 未登录 → 不刷新
  if (__isLoginScreenVisible() && !__hasAuth()) {
    console.warn('[RefreshGuard] ' + (reason||'') + ' → 未登录且在登录页，BLOCK 刷新');
    return true;
  }
  return false;
}

// ============ 认证：覆盖 fetch 自动注入 token + 401 自动登出 + 离线检测 + 超时重试 ============
var _origFetch = window.fetch;
var __isOffline = false;
// 带超时的 fetch：AbortController 控制超时，默认 10s
function fetchWithTimeout(url, opts, timeoutMs) {
  var ctrl = new AbortController();
  var opts2 = Object.assign({}, opts, { signal: ctrl.signal });
  var to = setTimeout(function() { ctrl.abort(); }, timeoutMs || 10000);
  return _origFetch(url, opts2).finally(function() { clearTimeout(to); });
}
window.fetch = function(url, opts) {
  opts = opts || {};
  opts.headers = opts.headers || {};
  if (typeof url === 'string' && url.startsWith('/api/') && TOKEN) {
    if (typeof opts.headers === 'object' && !(opts.headers instanceof Headers)) {
      opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    }
  }
  // v6.9.10: GET 请求自动重试 1 次（弱网瞬时失败兜底）
  var isGet = !opts.method || opts.method === 'GET';
  var isApi = typeof url === 'string' && url.startsWith('/api/');
  var tryFetch = function() { return fetchWithTimeout(url, opts, 8000); };
  var chain = tryFetch();
  if (isApi && isGet) {
    // GET 失败（网络错/超时）时延迟 1s 重试一次
    chain = chain.catch(function(err) {
      return new Promise(function(resolve, reject) {
        setTimeout(function() {
          tryFetch().then(resolve, reject);
        }, 1000);
      });
    });
  }
  return chain.then(function(resp) {
    // v6.5.8 离线检测：SW 返回 __offline 标记时显示提示
    if (resp.headers.get('content-type') && resp.headers.get('content-type').includes('json')) {
      var clone = resp.clone();
      clone.json().then(function(data) {
        if (data && data.__offline && !__isOffline) {
          __isOffline = true;
          showOfflineBanner();
        }
        // 网络恢复时自动隐藏
        if (!data || !data.__offline) {
          if (__isOffline) { __isOffline = false; hideOfflineBanner(); }
        }
      }).catch(function(){});
    }
    // v6.9.17: 401 处理降级——只对 /api/me 的 401 清 token（这是明确的认证检查），
    // 其他接口 401 可能是 SW 缓存/网络抖动，先给一次重试机会，避免误清 token
    if (resp.status === 401 && typeof url === 'string' && url.startsWith('/api/') && !url.includes('/api/login')) {
      // 计数本次会话内的 401 次数，连续 2 次才真正登出
      window.__auth401Count = (window.__auth401Count || 0) + 1;
      if (window.__auth401Count >= 2 || url === '/api/me') {
        TOKEN = '';
        localStorage.removeItem(TOKEN_KEY);
        var app = document.getElementById('app');
        var lock = document.getElementById('lock');
        if (app && lock) {
          app.style.display = 'none';
          lock.style.display = 'flex';
          var err = document.getElementById('pwdErr');
          if (err) { err.textContent = '登录已过期，请重新登录'; err.style.display = 'block'; }
        }
      }
    } else if (resp.ok) {
      // 请求成功，重置 401 计数
      window.__auth401Count = 0;
    }
    return resp;
  });
};

// ============================================================
// P0-3 离线写入重试队列（数据防丢失）+ 统一离线提示条
// ============================================================
var PENDING_KEY = 'qiezi_pending_v1';
function getPendingQueue() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch(e) { return []; }
}
function savePendingQueue(q) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(q)); } catch(e) {}
  updateOfflineBanner();
}
function pendingQueueAdd(item) {
  var q = getPendingQueue();
  if (item.operation === 'save' || item.operation === 'delete') {
    q = q.filter(function(x) { return !(x.module === item.module && x.operation === item.operation && (x.operation === 'delete' ? x.targetId === item.targetId : false)); });
  }
  q.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2,4), ts: Date.now(), ...item });
  savePendingQueue(q);
}
function pendingQueueRemove(pendingId) {
  var q = getPendingQueue().filter(function(x) { return x.id !== pendingId; });
  savePendingQueue(q);
}
async function flushPendingQueue(silent) {
  var q = getPendingQueue();
  if (!q.length) { if (!silent) updateOfflineBanner(); return 0; }
  if (!navigator.onLine) { if (!silent) updateOfflineBanner(); return 0; }
  var total = q.length, done = 0, failed = 0;
  for (var i = 0; i < q.length; i++) {
    var p = q[i];
    try {
      if (p.operation === 'add_record') {
        var body = { mid: p.module, data: p.data };
        if (p.editId) body.editId = p.editId;
        var r = await fetch('/api/record/add', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        var rd = await r.json();
        if (rd && rd.success) {
          pendingQueueRemove(p.id);
          done++;
          if (rd.linkedModules && rd.linkedModules.length) {
            for (var j = 0; j < rd.linkedModules.length; j++) {
              try { await apiFetch(rd.linkedModules[j]); } catch(e) {}
            }
          }
        } else {
          failed++;
          if (rd && rd.message === '模块非法') { pendingQueueRemove(p.id); continue; }
        }
      } else if (p.operation === 'save') {
        await fetch('/api/' + p.module, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(p.data) });
        pendingQueueRemove(p.id); done++;
      } else if (p.operation === 'delete') {
        await fetch('/api/' + p.module + '/' + p.targetId, { method:'DELETE' });
        pendingQueueRemove(p.id); done++;
      } else {
        pendingQueueRemove(p.id);
      }
    } catch(e) { failed++; }
  }
  var remain = getPendingQueue();
  if (remain.length === 0) {
    if (curScene) try { await apiFetch(curScene); renderDetail(curScene); renderHome(); } catch(e) {}
  }
  updateOfflineBanner();
  if (!silent && (done > 0 || failed === 0)) {
    var msg = '离线同步：成功 ' + done + ' 条' + (failed > 0 ? '，失败 ' + failed + ' 条（下次在线时重试）' : '');
    showToast(msg, done === total ? 'success' : 'warn');
  }
  return done;
}
function clearPendingQueue() {
  if (!confirm('确定丢弃 ' + getPendingQueue().length + ' 条离线改动？（本地暂存的记录会丢失）')) return;
  savePendingQueue([]);
  updateOfflineBanner();
  showToast('已丢弃离线暂存', 'warn');
}
// 统一离线/待同步 banner（替换原离线提示条+新增待同步按钮）
function updateOfflineBanner() {
  var q = getPendingQueue();
  var isOffline = !navigator.onLine || __isOffline;
  var needShow = isOffline || q.length > 0;
  var b = document.getElementById('offlineBanner');
  var app = document.getElementById('app');
  if (!needShow) {
    if (b) b.remove();
    if (app) app.style.paddingTop = '';
    return;
  }
  if (!b) {
    b = document.createElement('div');
    b.id = 'offlineBanner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;background:#F59E0B;color:#fff;padding:8px 16px;font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.15);display:flex;align-items:center;gap:4px;';
    document.body.appendChild(b);
  }
  var icon = isOffline ? '📡 离线模式' : '📡 待同步';
  var text = isOffline
    ? (q.length > 0 ? '当前离线 · <b>' + q.length + '</b> 条改动本地暂存，上线自动同步' : '当前离线 · 数据暂存本地，上线后自动同步')
    : '有 <b>' + q.length + '</b> 条改动正在等待同步';
  var actions = '';
  if (q.length > 0) {
    actions = '<button onclick="flushPendingQueue(false)" style="margin-left:8px;padding:4px 10px;border:none;border-radius:6px;background:#10B981;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">立即同步</button>' +
              '<button onclick="clearPendingQueue()" style="margin-left:4px;padding:4px 10px;border:1px solid rgba(255,255,255,.3);border-radius:6px;background:transparent;color:#fff;font-size:12px;cursor:pointer;">丢弃</button>';
  }
  b.innerHTML = '<div style="flex:1;">' + icon + ' · ' + text + '</div>' + actions;
  if (app) app.style.paddingTop = '40px';
}
// 兼容旧函数名
function showOfflineBanner() { updateOfflineBanner(); }
function hideOfflineBanner() { updateOfflineBanner(); }
// 浏览器原生 online/offline 事件
window.addEventListener('offline', function() { __isOffline = true; updateOfflineBanner(); });
window.addEventListener('online', function() {
  __isOffline = false;
  updateOfflineBanner();
  setTimeout(function() { flushPendingQueue(true); }, 800);
});
// 轻量 Toast（统一实现，支持 kind: success/warn/default + 可选 duration）
// 注意：全局仅此一个 showToast，避免之前 250/4602 两处定义冲突
var __toastTimer = null;
function showToast(msg, kind, duration) {
  // 兼容旧调用 showToast(msg, duration) —— 第二参数为数字时视为 duration
  if (typeof kind === 'number') { duration = kind; kind = 'default'; }
  var t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    t.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);padding:10px 18px;border-radius:10px;z-index:99999;font-size:13px;font-weight:600;box-shadow:0 4px 18px rgba(0,0,0,.18);transition:opacity .3s;opacity:0;pointer-events:none;max-width:90vw;text-align:center;';
    document.body.appendChild(t);
  }
  t.style.background = kind === 'success' ? '#10B981' : kind === 'warn' ? '#F59E0B' : '#6B7280';
  t.style.color = '#fff';
  t.textContent = msg;
  t.style.opacity = '1';
  if (__toastTimer) clearTimeout(__toastTimer);
  __toastTimer = setTimeout(function() { t.style.opacity = '0'; }, duration || 2800);
}

var SCENES = [
{id:'work',name:'我的工作',icon:'💼',brief:'职业·收入·意义'},
{id:'home',name:'我的居住',icon:'🏠',brief:'空间·物品·安全'},
{id:'travel',name:'我的出行',icon:'🛵',brief:'通勤·自由·掌控'},
{id:'health',name:'我的健康',icon:'❤️',brief:'身体·就医·体检'},
{id:'relation',name:'我的关系',icon:'👥',brief:'父母·同事·朋友'},
{id:'time',name:'我的时间',icon:'⏰',brief:'分配·频率·充实'},
{id:'growth',name:'我的成长',icon:'🌱',brief:'学习·技能·方向'},
{id:'spirit',name:'我的精神',icon:'🧠',brief:'日志·信念·价值'}
];

// 修复：health->body, mind->think，匹配后端模块
var FOCUS = [
{id:'work',label:'工作收入',icon:'💼',desc:'稳定收入·增长路径',status:'active'},
{id:'photo',label:'摄影能力',icon:'📷',desc:'技能积累·表达出口',status:'learning'},
{id:'health',label:'身体健康',icon:'❤️',desc:'能量基础·一切前提',status:'steady'},
{id:'think',label:'认知思考',icon:'🧠',desc:'决策质量·成长引擎',status:'learning'}
];

var CORE_MODULES = [
{id:'finance',label:'财务',icon:'💰'},{id:'sleep',label:'睡眠',icon:'😴'},
{id:'exercise',label:'锻炼',icon:'🏃'},{id:'emotion',label:'情绪',icon:'😊'},
{id:'diet',label:'饮食',icon:'🥗'},{id:'diary',label:'日记',icon:'📖'},
{id:'growth',label:'成长认知',icon:'🌱'},{id:'photo',label:'摄影',icon:'📷'},
{id:'think',label:'认知思考',icon:'🧠'},{id:'inventory',label:'库存',icon:'📦'},
{id:'space',label:'空间物品',icon:'🏠'},{id:'pet',label:'宠物',icon:'🐾'},
{id:'health',label:'健康',icon:'❤️'},{id:'todo',label:'待办',icon:'📋'}
];

async function apiFetch(m) {
  try {
    const r = await fetch('/api/' + m);
    const d = await r.json();
    dataCache[m] = d;
    return d;
  } catch(e) { return dataCache[m] || []; }
}
async function apiSave(m, d) {
  try {
    await fetch('/api/' + m, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(d) });
    dataCache[m] = d;
  } catch(e) {
    pendingQueueAdd({ operation: 'save', module: m, data: d });
  }
}
async function apiAdd(m, r) {
  if (!dataCache[m]) dataCache[m] = [];
  try {
    await fetch('/api/' + m + '/add', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(r) });
    dataCache[m].push(r);
  } catch(e) {
    pendingQueueAdd({ operation: 'add_record', module: m, data: r });
    dataCache[m].push(r);
  }
}
async function apiDelete(m, id) {
  try {
    await fetch('/api/' + m + '/' + id, { method:'DELETE' });
    if (dataCache[m]) dataCache[m] = dataCache[m].filter(i => i.id !== id);
  } catch(e) {
    pendingQueueAdd({ operation: 'delete', module: m, targetId: id });
    if (dataCache[m]) dataCache[m] = dataCache[m].filter(i => i.id !== id);
  }
}
async function fetchInsights() {
  try { const r = await fetch('/api/insights'); insightsCache = await r.json(); } catch(e) { insightsCache = null; }
}
function genId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

async function login(){
  var p = document.getElementById('pwdI').value;
  if(!p) return;
  try {
    var r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: p })
    });
    var j = await r.json();
    if (j.success && j.token) {
      TOKEN = j.token;
      localStorage.setItem(TOKEN_KEY, j.token);
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      applyTheme('home');
      initApp();
    } else {
      var err = document.getElementById('pwdErr');
      err.textContent = j.message || '密码错误';
      err.style.display = 'block';
    }
  } catch(e) {
    var err = document.getElementById('pwdErr');
    err.textContent = '网络错误，请重试';
    err.style.display = 'block';
  }
}
document.getElementById('pwdI').addEventListener('keydown', function(e){ if(e.key === 'Enter') login(); });

// 启动时检查是否已登录（token 是否有效）
// v6.9.17: 网络失败时重试2次（共3次），避免弱网下误回退到登录页
async function checkSession() {
  if (!TOKEN) return false;
  for (var i = 0; i < 3; i++) {
    try {
      var r = await fetch('/api/me');
      if (r.ok) return true;
      if (r.status === 401) return false;  // 明确未登录，不重试
      // 其他状态码（5xx等）继续重试
    } catch(e) {
      // 网络错误，继续重试
    }
    if (i < 2) await new Promise(function(res){ setTimeout(res, 1500); });
  }
  return false;
}
// 页面加载时自动登录
// v6.9.17: checkSession 失败但 token 仍在时，不立即回退登录页，先显示重试提示
(async function() {
  var ok = await checkSession();
  if (ok) {
    document.getElementById('lock').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    applyTheme('home');
    initApp();
  } else if (TOKEN) {
    // token 还在但验证失败（可能是网络问题）→ 显示重试按钮而非直接清 token
    var err = document.getElementById('pwdErr');
    if (err) { err.textContent = '网络不稳定，点击重试'; err.style.display = 'block'; }
    var btn = document.querySelector('#lock button');
    if (btn) {
      btn.textContent = '重试连接';
      btn.setAttribute('onclick', 'location.reload()');
    }
  }
})();

function logout() {
  TOKEN = '';
  localStorage.removeItem(TOKEN_KEY);
  document.getElementById('app').style.display = 'none';
  document.getElementById('lock').style.display = 'flex';
  document.getElementById('pwdI').value = '';
}

async function initApp() {
  // v6.5.8 首屏优化：先显示骨架屏，数据到达后切换为真实内容
  var skeleton = document.getElementById('homeSkeleton');
  var content = document.getElementById('homeContent');
  // v6.9.18 首屏聚合加载：bootstrap(23模块) + insights-plus(insights+dashboard) 并发，替代 2+串行 27+ 请求
  try {
    const [bootResp, insResp] = await Promise.all([
      fetch('/api/bootstrap?_='+Date.now()),
      fetch('/api/insights-plus?_='+Date.now())
    ]);
    const boot = await bootResp.json();
    for (var m in boot) { if (Array.isArray(boot[m])) dataCache[m] = boot[m]; }
    try {
      const ins = await insResp.json();
      insightsCache = ins.insights || null;
      engDashboardCache = ins.dashboard || null;
    } catch(e) { insightsCache = null; engDashboardCache = null; }
  } catch(e) {
    // 聚合接口失败时降级为逐模块串行（兜底）
    var mods = ['finance','sleep','exercise','emotion','diet','diary','learn','photo','think','inventory','space','work','home','travel','body','relation','time','growth','spirit','pet','medical','todo','health'];
    for(var i=0; i<mods.length; i++) await apiFetch(mods[i]);
    await fetchInsights();
  }
  // v6.5.8：数据就绪，隐藏骨架屏，显示真实内容
  if (skeleton) skeleton.style.display = 'none';
  if (content) content.style.display = 'block';
  renderHome();
  renderInsight();
  loadDailyQuestion();
  // v6.5.9 启动提醒到期检查
  startReminderCheck();
  // P0-3：加载后检查离线待同步队列，立即尝试 flush（静默）
  updateOfflineBanner();
  setTimeout(function() { flushPendingQueue(true); }, 500);
}

async function loadDailyQuestion() {
  try {
    var r = await fetch('/api/daily-question');
    var d = await r.json();
    var textEl = document.getElementById('dailyQuestionText');
    if (textEl) textEl.textContent = d.question;
    var disp = document.getElementById('dailyAnswerDisplay');
    var inp = document.getElementById('dailyQuestionInput');
    if (d.answer) {
      if (disp) { disp.style.display = 'block'; disp.textContent = '✅ 已回答：' + d.answer; }
      if (inp) { inp.value = ''; inp.placeholder = '已回答，明天再来'; inp.disabled = true; }
    } else {
      if (disp) disp.style.display = 'none';
      if (inp) { inp.disabled = false; inp.placeholder = '写下你的回答...'; }
    }
  } catch(e) { console.warn('加载今日之问失败', e); }
}

async function submitDailyAnswer() {
  var inp = document.getElementById('dailyQuestionInput');
  if (!inp) return;
  var ans = inp.value.trim();
  if (!ans) { alert('请先写下你的回答'); return; }
  try {
    var today = new Date().toISOString().split('T')[0];
    var r = await fetch('/api/daily-question/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: ans, date: today })
    });
    var d = await r.json();
    if (d.success) {
      alert('✅ 回答已保存！深度评分：' + d.depthScore + '/5');
      loadDailyQuestion();
      if (typeof renderOverview === 'function') renderOverview();
    } else {
      alert('保存失败：' + d.message);
    }
  } catch(e) { alert('网络错误，请重试'); }
}

function viewQuestionHistory() {
  fetch('/api/daily-question/history')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var history = data.slice(0, 10);
      var msg = '📚 最近问答历史：\n\n';
      history.forEach(function(q) {
        var answer = q.answer || '未回答';
        msg += '📅 ' + q.date + '\n❓ ' + q.question + '\n💬 ' + answer + '\n\n';
      });
      alert(msg);
    })
    .catch(function(e) { alert('加载历史失败'); });
}

function renderHome(){
  var g = document.getElementById('focusGrid');
  g.innerHTML = FOCUS.map(function(f){
    var data = Array.isArray(dataCache[f.id]) ? dataCache[f.id] : [];
    var progress = Math.min(100, data.length * 5);
    var statusMap = {active:'活跃', learning:'学习中', steady:'稳定', paused:'暂停'};
    return '<div class="focus-card" onclick="openScene(\''+f.id+'\')"><div class="top"><span class="ic">'+f.icon+'</span><span class="status '+f.status+'">'+statusMap[f.status]+'</span></div><div class="nm">'+f.label+'</div><div class="br">'+f.desc+' · '+data.length+'条</div><div class="progress"><div class="fill" style="width:'+progress+'%"></div></div></div>';
  }).join('');

  var m = document.getElementById('quickModules');
  m.innerHTML = CORE_MODULES.map(function(mod){
    var cnt = Array.isArray(dataCache[mod.id]) ? dataCache[mod.id].length : 0;
    return '<div class="quick-module" onclick="openScene(\''+mod.id+'\')"><span class="ic">'+mod.icon+'</span><div class="nm">'+mod.label+'</div><div class="cnt">'+cnt+'条</div></div>';
  }).join('');

  var n = new Date();
  document.getElementById('todayD').textContent = n.toLocaleDateString('zh-CN', {year:'numeric', month:'long', day:'numeric', weekday:'short'});
  var h = n.getHours();
  var greet = h<6 ? '夜航中，船长' : h<9 ? '早安，船长' : h<12 ? '顺风，船长' : h<14 ? '午安，船长' : h<18 ? '午后，船长' : h<21 ? '傍晚，船长' : '夜深了，船长';
  document.getElementById('greetT').innerHTML = '<strong>'+greet+'</strong> · 今天状态如何？';

  renderOverview();
  renderHabits();
  renderGrowth();
  renderHomeInsights();
}

function renderOverview(){
  var sleep = dataCache.sleep || [], emotion = dataCache.emotion || [];
  var sl=0, em=0;
  sleep.slice(-7).forEach(function(s){ sl += parseFloat(s.hours) || 0; });
  emotion.slice(-7).forEach(function(e){ em += parseFloat(e.rating) || 0; });
  document.getElementById('ovSleep').textContent = (sleep.length ? (sl/Math.min(7,sleep.length)).toFixed(1) : '-') + 'h';
  document.getElementById('ovMood').textContent = (emotion.length ? (em/Math.min(7,emotion.length)).toFixed(1) : '-') + '/10';
  document.getElementById('ovDays').textContent = Math.max(sleep.length, emotion.length, 1);
}

async function renderHabits(){
  var grid = document.getElementById('habitsGrid');
  if(!grid) return;
  try {
    var r = await fetch('/api/habits');
    var habits = await r.json();
    if(!Array.isArray(habits) || habits.length === 0){
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = habits.slice(0,3).map(function(habit){
      var streak = parseInt(habit.streak) || 0;
      var pct = Math.min(100, (streak / 21) * 100);
      var deg = (streak / 21) * 360;
      if(deg > 360) deg = 360;
      var todayDone = !!habit.todayDone;
      var nameText = escapeHtml(habit.name) + (todayDone ? ' ✅' : '');
      return '<div onclick="checkinHabit(\''+escapeHtml(habit.id)+'\')" style="background:var(--c-surface);border-radius:14px;padding:12px 8px;text-align:center;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.05);transition:transform .2s;" onmousedown="this.style.transform=\'scale(0.96)\'" onmouseup="this.style.transform=\'scale(1)\'" onmouseleave="this.style.transform=\'scale(1)\'"><div style="width:56px;height:56px;border-radius:50%;background:conic-gradient(var(--c-primary) '+deg+'deg,#e5e7eb 0);display:flex;align-items:center;justify-content:center;margin:0 auto 6px;"><div style="width:40px;height:40px;border-radius:50%;background:var(--c-surface);display:flex;align-items:center;justify-content:center;font-size:20px;">'+escapeHtml(habit.icon||'📌')+'</div></div><div style="font-size:12px;font-weight:600;color:var(--c-fg);">'+nameText+'</div><div style="font-size:11px;color:var(--c-fg-2)">连续'+streak+'天</div></div>';
    }).join('');
  } catch(e) {
    grid.innerHTML = '';
  }
}

async function checkinHabit(habitId){
  try {
    await fetch('/api/habit/checkin', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({habitId: habitId}) });
  } catch(e) {}
  renderHabits();
}

function renderGrowth(){
  if(!insightsCache || !insightsCache.growth) return;
  var g = insightsCache.growth;
  var el1=document.getElementById('phaseLabel'); if(el1) el1.textContent = g.phase;
  var el2=document.getElementById('phaseBadge'); if(el2) el2.textContent = g.phase;
  var el3=document.getElementById('progressLabel'); if(el3) el3.textContent = g.progress + '%';
  var el4=document.getElementById('growthFill'); if(el4) el4.style.width = g.progress + '%';
  var el5=document.getElementById('phaseDesc'); if(el5) el5.textContent = g.phaseDesc + ' · 下一里程碑：' + g.nextMilestone;
}

function renderHomeInsights(){
  if(!insightsCache) return;
  var corrDiv = document.getElementById('homeCorrelations');
  if(corrDiv){
    if(insightsCache.correlations && insightsCache.correlations.length > 0){
      corrDiv.innerHTML = '<div style="font-size:12px;font-weight:600;color:var(--c-fg-2);margin:8px 0 4px">🔗 发现关联</div>' +
        insightsCache.correlations.slice(0,2).map(function(c){
          return '<div class="corr-item"><div class="title">'+escapeHtml(c.title)+'</div><div class="detail">'+escapeHtml(c.detail)+'</div></div>';
        }).join('');
    } else {
      corrDiv.innerHTML = '';
    }
  }
  var sugDiv = document.getElementById('homeSuggestions');
  if(sugDiv){
    if(insightsCache.suggestions && insightsCache.suggestions.length > 0){
      sugDiv.innerHTML = insightsCache.suggestions.slice(0,2).map(function(s){
        return '<div class="suggestion-item">'+escapeHtml(s.text)+'</div>';
      }).join('');
    } else {
      sugDiv.innerHTML = '';
    }
  }
}

function nlSubmit(){
  var text = document.getElementById('nlInput').value.trim();
  if(!text){ alert('请输入内容'); return; }
  var result = parseNL(text);
  alert(result);
  document.getElementById('nlInput').value = '';
  renderHome();
}

function parseNL(text){
  var modules = {
    finance:['花了','买了','消费','支出','收入','工资','提成','付了'],
    sleep:['睡了','醒','困','失眠','做梦','作息','熬夜'],
    exercise:['跑了','走了','跳了','练了','运动','力量','瑜伽','健身','出汗','拉伸'],
    emotion:['感觉','心情','开心','焦虑','平静','烦躁','情绪','状态','难过','兴奋'],
    diet:['吃了','喝了','早餐','午餐','晚餐','加餐','水果','零食','咖啡','饮'],
    photo:['拍了','相机','镜头','快门','光圈','街拍','人像','构图','调色','摄影'],
    think:['想了','复盘','决定','判断','认为','反思','方向','目标','纠结','思考'],
    diary:['发生','经历','今天','昨天','早上','下午','晚上']
  };
  var target = 'diary';
  for(var mod in modules){
    for(var i=0;i<modules[mod].length;i++){
      if(text.indexOf(modules[mod][i]) !== -1){ target = mod; break; }
    }
    if(target !== 'diary') break;
  }
  var record = { id: genId(), content: text, date: TODAY, created: new Date().toISOString() };
  if(!Array.isArray(dataCache[target])) dataCache[target] = [];
  dataCache[target].push(record);
  apiSave(target, dataCache[target]);
  var names = {finance:'财务',sleep:'睡眠',exercise:'锻炼',emotion:'情绪',diet:'饮食',photo:'摄影',think:'认知思考',diary:'日记'};
  return '✅ 已存入「' + (names[target] || target) + '」';
}

var THEMES = {
home:    {primary:'#D4A574',primary2:'#E0B585',tabAct:'#D4A574'},
record:  {primary:'#7A9CB0',primary2:'#8AACBE',tabAct:'#7A9CB0'},
insight: {primary:'#C9B07A',primary2:'#D9C08A',tabAct:'#C9B07A'},
me:      {primary:'#7BA07A',primary2:'#8BB08A',tabAct:'#7BA07A'}
};
function applyTheme(t){
var th=THEMES[t]||THEMES.home;
var r=document.documentElement.style;
// 深夜书房：只改强调色，背景恒为暖灰（暗色）或暖白（日间），由 data-theme 控制
r.setProperty('--c-primary',th.primary);
r.setProperty('--c-primary-2',th.primary2);
r.setProperty('--c-tab-act',th.tabAct);
r.setProperty('--c-accent',hexToRgba(th.primary,0.12));
r.setProperty('--c-accent-2',hexToRgba(th.primary2,0.18));
}
function hexToRgba(h,a){
h=h.replace('#','');
if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
var r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);
return'rgba('+r+','+g+','+b+','+a+')';
}

function switchTab(t){
document.querySelectorAll('.tab').forEach(function(el){ el.classList.remove('act'); });
document.querySelectorAll('.pg').forEach(function(el){ el.classList.remove('act'); });
// 用 data-tab 属性精确匹配，避免文本变化导致高亮失效
document.querySelectorAll('.tab').forEach(function(el){ if(el.getAttribute('data-tab')===t) el.classList.add('act'); });
var targetId = 'pg' + t.charAt(0).toUpperCase() + t.slice(1);
var pg = document.getElementById(targetId);
if(pg){
  pg.classList.add('act');
  // 触发卡片交错入场动画
  pg.classList.remove('stagger');
  void pg.offsetWidth;  // 强制重排，重置动画
  pg.classList.add('stagger');
}
applyTheme(t);
if(t==='record') renderRecord();
else if(t==='insight') renderInsight();
else if(t==='me') renderMe();
else if(t==='home') renderHome();
}

// ====== 设置抽屉 ======
function openDrawer(){
  var d = document.getElementById('drawer');
  var m = document.getElementById('drawerMask');
  if(d){ d.classList.add('act'); }
  if(m){ m.classList.add('act'); }
}
function closeDrawer(){
  var d = document.getElementById('drawer');
  var m = document.getElementById('drawerMask');
  if(d){ d.classList.remove('act'); }
  if(m){ m.classList.remove('act'); }
}

var budgetCache = null;
var petDashCache = null;

function openScene(id){
  curScene=id;
  editId = null;
  var s=SCENES.find(function(x){ return x.id===id });
  if(!s) s=CORE_MODULES.find(function(x){ return x.id===id });
  if(!s) s={name:id, icon:'📄'};
  document.getElementById('detailTitle').textContent = (s.icon||'📄')+' '+(s.label||s.name||id);
  document.getElementById('detail').classList.add('act');
  // 如果是财务场景，先加载预算数据
  if(id === 'finance'){
    fetch('/api/budget').then(function(r){ return r.json(); }).then(function(d){ budgetCache = d; renderDetail(id); }).catch(function(){ budgetCache = null; renderDetail(id); });
  } else if(id === 'pet'){
    // 宠物仪表盘：加载跨模块联动数据（花费+物资+就医）
    fetch('/api/pet-dashboard').then(function(r){ return r.json(); }).then(function(d){ petDashCache = d; renderDetail(id); }).catch(function(){ petDashCache = null; renderDetail(id); });
  } else {
    renderDetail(id);
  }
}

async function setBudget(){
  var input = document.getElementById('budgetInput');
  if(!input) return;
  var val = parseFloat(input.value);
  if(isNaN(val) || val <= 0){ alert('请输入有效金额'); return; }
  try {
    await fetch('/api/budget', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({budget: val}) });
    var d = await (await fetch('/api/budget')).json();
    budgetCache = d;
    renderDetail(curScene);
  } catch(e) { alert('设置失败'); }
}

function copyLast(){
  if(!curScene) return;
  var data = Array.isArray(dataCache[curScene]) ? dataCache[curScene] : [];
  if(data.length === 0){ alert('还没有上次记录'); return; }
  var lastItem = data[data.length - 1];
  try {
    localStorage.setItem('prefill_'+curScene, JSON.stringify(lastItem));
  } catch(e) {}
  openAdd();
}

function renderDetail(id){
  // 先渲染复制上次按钮
  var actionsEl = document.getElementById('detailActions');
  if(actionsEl){
    if(!editId){
      actionsEl.innerHTML = '<button onclick="copyLast()" style="background:linear-gradient(135deg,var(--c-primary),var(--c-primary-2));border:none;border-radius:10px;padding:6px 14px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px var(--c-shadow);">复制上次</button>';
    } else {
      actionsEl.innerHTML = '';
    }
  }
  var data=Array.isArray(dataCache[id])?dataCache[id]:[];
  var c=document.getElementById('detailContent');
  var extraHtml = '';
  // 财务场景：预算卡片
  if(id === 'finance'){
    var budget = budgetCache || {};
    var budgetAmount = parseFloat(budget.budget) || 0;
    var spent = parseFloat(budget.spent) || 0;
    var remaining = budgetAmount - spent;
    var over = remaining < 0;
    var pct = budgetAmount > 0 ? Math.min(100, (spent / budgetAmount) * 100) : 0;
    var barBg = over ? '#FEE2E2' : '#E5E7EB';
    var fillBg = over ? '#EF4444' : 'linear-gradient(90deg,var(--c-primary),var(--c-primary-2))';
    var textColor = over ? 'color:#EF4444;font-weight:700;' : '';
    extraHtml += '<div id="budgetPanel" style="background:var(--c-surface);border-radius:14px;padding:12px 14px;margin-bottom:14px;box-shadow:0 2px 10px rgba(0,0,0,.05);">';
    extraHtml += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
    extraHtml += '<span style="font-size:13px;font-weight:700;color:var(--c-fg);">💰 财务预算</span>';
    extraHtml += '<div style="display:flex;gap:6px;align-items:center;">';
    if(budgetAmount <= 0){
      extraHtml += '<input type="number" id="budgetInput" placeholder="本月预算" style="padding:6px 10px;border-radius:8px;border:1px solid #E5E7EB;background:#FAFAFC;color:var(--c-fg);font-size:12px;width:100px;">';
    } else {
      extraHtml += '<span style="font-size:12px;color:var(--c-fg-2);">本月预算 ¥'+budgetAmount+'</span>';
    }
    extraHtml += '<button onclick="setBudget()" style="background:linear-gradient(135deg,var(--c-primary),var(--c-primary-2));border:none;border-radius:8px;padding:6px 12px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;">设预算</button>';
    extraHtml += '</div></div>';
    if(budgetAmount > 0){
      extraHtml += '<div style="height:8px;border-radius:4px;overflow:hidden;margin:6px 0;background:'+barBg+';">';
      extraHtml += '<div style="height:100%;width:'+pct+'%;background:'+fillBg+';border-radius:4px;transition:width .5s;"></div>';
      extraHtml += '</div>';
      extraHtml += '<div style="display:flex;justify-content:space-between;font-size:11px;margin-top:4px;">';
      extraHtml += '<span style="color:var(--c-fg-2);">已用 ¥'+spent.toFixed(2)+'</span>';
      extraHtml += '<span style="color:var(--c-fg-2);">预算 ¥'+budgetAmount.toFixed(2)+'</span>';
      extraHtml += '<span style="'+textColor+'">剩余 ¥'+remaining.toFixed(2)+'</span>';
      extraHtml += '</div>';
      if(over){
        extraHtml += '<div style="margin-top:6px;font-size:12px;color:#EF4444;font-weight:700;">⚠️ 超支！已超出 ¥'+Math.abs(remaining).toFixed(2)+'</div>';
      }
    }
    extraHtml += '</div>';
  }
  // 库存预警面板：统计低于补货阈值的物品
  if(id === 'inventory' && data.length > 0){
    var lowItems = [];
    data.forEach(function(it){
      var qty = parseInt(it.quantity) || 0;
      // 阈值优先用 minStock，否则默认 ≤1 为低库存；忽略已闲置/已丢弃
      var declutter = it.declutter || '';
      if (declutter.indexOf('丢弃') !== -1 || declutter.indexOf('捐赠') !== -1 || declutter.indexOf('出售') !== -1) return;
      var threshold = parseInt(it.minStock);
      var isLow = isNaN(threshold) ? qty <= 1 : qty <= threshold;
      if (isLow) {
        lowItems.push({ name: it.name || '未命名', qty: qty, threshold: isNaN(threshold) ? 1 : threshold, usageFreq: it.usageFreq || '' });
      }
    });
    if (lowItems.length > 0) {
      // 按使用频率排序：每日 > 每周 > 每月 > 其他
      var freqOrder = {'每日':0,'每周':1,'每月':2};
      lowItems.sort(function(a,b){
        var oa = freqOrder[a.usageFreq] !== undefined ? freqOrder[a.usageFreq] : 9;
        var ob = freqOrder[b.usageFreq] !== undefined ? freqOrder[b.usageFreq] : 9;
        return oa - ob;
      });
      var urgentCount = lowItems.filter(function(x){ return x.usageFreq === '每日' || x.usageFreq === '每周'; }).length;
      var alertBg = urgentCount > 0 ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)';
      var alertBorder = urgentCount > 0 ? '#EF4444' : '#F59E0B';
      var alertTitle = urgentCount > 0 ? '⚠️ 急需补货' : '📦 低库存提醒';
      extraHtml += '<div style="background:'+alertBg+';border-radius:14px;padding:12px 14px;margin-bottom:14px;border-left:3px solid '+alertBorder+';box-shadow:0 2px 10px rgba(0,0,0,.04);">';
      extraHtml += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
      extraHtml += '<span style="font-size:13px;font-weight:700;color:'+alertBorder+';">'+alertTitle+' · '+lowItems.length+'件</span>';
      extraHtml += '<button onclick="openAdd()" style="background:linear-gradient(135deg,#F59E0B,#EA580C);border:none;border-radius:8px;padding:6px 12px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;">+ 补货</button>';
      extraHtml += '</div>';
      lowItems.forEach(function(it){
        var freqTag = it.usageFreq ? '<span style="font-size:10px;color:var(--c-fg-3);margin-left:6px;">'+escapeHtml(it.usageFreq)+'</span>' : '';
        extraHtml += '<div style="display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px dashed rgba(0,0,0,0.05);">';
        extraHtml += '<span style="color:var(--c-fg);">'+escapeHtml(it.name)+freqTag+'</span>';
        extraHtml += '<span style="color:'+alertBorder+';font-weight:600;">余 '+it.qty+' / 阈值 '+it.threshold+'</span>';
        extraHtml += '</div>';
      });
      extraHtml += '</div>';
    }
  }
  // 宠物仪表盘：跨模块联动面板（花费汇总 + 物资状态 + 就医记录）
  if(id === 'pet' && petDashCache && petDashCache.totalRecords !== undefined){
    var pd = petDashCache;
    extraHtml += '<div style="background:var(--c-surface);border-radius:14px;padding:12px 14px;margin-bottom:14px;box-shadow:0 2px 10px rgba(0,0,0,.05);">';
    extraHtml += '<div style="font-size:13px;font-weight:700;color:var(--c-fg);margin-bottom:8px;">🐾 宠物仪表盘 · 跨模块联动</div>';
    // 花费统计
    extraHtml += '<div style="display:flex;gap:12px;margin-bottom:8px;">';
    extraHtml += '<div style="flex:1;background:#F0FDF4;border-radius:8px;padding:8px 10px;"><div style="font-size:11px;color:var(--c-fg-2);">本月花费</div><div style="font-size:16px;font-weight:700;color:#16A34A;">¥'+pd.monthCost.toFixed(0)+'</div></div>';
    extraHtml += '<div style="flex:1;background:#FFF7ED;border-radius:8px;padding:8px 10px;"><div style="font-size:11px;color:var(--c-fg-2);">累计花费</div><div style="font-size:16px;font-weight:700;color:#EA580C;">¥'+pd.totalCost.toFixed(0)+'</div></div>';
    extraHtml += '<div style="flex:1;background:#EFF6FF;border-radius:8px;padding:8px 10px;"><div style="font-size:11px;color:var(--c-fg-2);">记录数</div><div style="font-size:16px;font-weight:700;color:#2563EB;">'+pd.totalRecords+'条</div></div>';
    extraHtml += '</div>';
    // 宠物概览
    if(pd.petSummary && pd.petSummary.length > 0){
      extraHtml += '<div style="margin-bottom:8px;">';
      pd.petSummary.forEach(function(p){
        extraHtml += '<div style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;">';
        extraHtml += '<span style="font-weight:600;color:var(--c-fg);">'+escapeHtml(p.name)+'</span>';
        if(p.type) extraHtml += '<span style="color:var(--c-fg-3);">'+escapeHtml(p.type)+'</span>';
        extraHtml += '<span style="color:var(--c-fg-2);">'+p.count+'条</span>';
        if(p.cost > 0) extraHtml += '<span style="color:#EA580C;">¥'+p.cost.toFixed(0)+'</span>';
        if(p.lastAction) extraHtml += '<span style="color:var(--c-fg-3);margin-left:auto;">最近:'+escapeHtml(p.lastAction)+'</span>';
        extraHtml += '</div>';
      });
      extraHtml += '</div>';
    }
    // 物资状态（从库存联动）
    if(pd.supplies && pd.supplies.length > 0){
      extraHtml += '<div style="font-size:11px;color:var(--c-fg-2);margin-top:6px;margin-bottom:4px;">📦 关联物资（来自库存）</div>';
      pd.supplies.forEach(function(s){
        var bg = s.lowStock ? '#FEF2F2' : '#F9FAFB';
        var color = s.lowStock ? '#EF4444' : '#6B7280';
        extraHtml += '<div style="display:flex;align-items:center;gap:6px;font-size:12px;padding:3px 8px;background:'+bg+';border-radius:6px;margin-bottom:3px;">';
        extraHtml += '<span style="color:var(--c-fg);font-weight:500;">'+escapeHtml(s.name||'')+'</span>';
        extraHtml += '<span style="color:'+color+';">x'+(s.quantity||0)+'</span>';
        if(s.lowStock) extraHtml += '<span style="color:#EF4444;font-weight:600;">⚠️需补货</span>';
        if(s.condition) extraHtml += '<span style="color:var(--c-fg-3);margin-left:auto;">'+escapeHtml(s.condition)+'</span>';
        extraHtml += '</div>';
      });
    }
    // 最近就医
    if(pd.recentVetVisits && pd.recentVetVisits.length > 0){
      extraHtml += '<div style="font-size:11px;color:var(--c-fg-2);margin-top:8px;margin-bottom:4px;">🏥 最近就医</div>';
      pd.recentVetVisits.forEach(function(v){
        extraHtml += '<div style="font-size:12px;padding:3px 8px;background:#F9FAFB;border-radius:6px;margin-bottom:3px;">';
        extraHtml += '<span style="color:var(--c-fg);">'+escapeHtml(v.date||'')+'</span> · ';
        extraHtml += '<span style="color:var(--c-fg-2);">'+escapeHtml(v.petName||'')+' '+escapeHtml(v.action||'')+'</span>';
        if(v.vetNote) extraHtml += '<span style="color:var(--c-fg-3);"> · '+escapeHtml(v.vetNote)+'</span>';
        extraHtml += '</div>';
      });
    }
    // 联动提示
    extraHtml += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:8px;padding-top:6px;border-top:1px dashed #E5E7EB;">💡 填写花费时自动同步到财务记账</div>';
    extraHtml += '</div>';
  }
  if(!data.length){ c.innerHTML=extraHtml+'<div class="empty"><span class="ic">📭</span>还没有记录，点 + 添加</div>'; return; }
  c.innerHTML=extraHtml+'<div>'+data.slice().reverse().map(function(item){
    var l='';
    if(id==='finance'){
      l=(item.type||'')+' · '+(item.category||'')+' · '+(item.content||item.note||'');
      if(item.amount) l+=' ¥'+item.amount;
    } else if(id==='sleep'){
      l=(item.hours||'?')+'小时 · '+(item.quality||'');
      if(item.content||item.note) l+=' · '+(item.content||item.note);
    } else if(id==='exercise'){
      l=(item.type||'运动')+' · '+(item.duration||'?')+'分钟 · '+(item.intensity||'');
      if(item.content) l+=' · '+item.content;
    } else if(id==='emotion'){
      l='情绪 '+(item.rating||'?')+'/10';
      if(item.content) l+=' · '+item.content;
    } else if(id==='diet'){
      l=(item.meal||'')+' · '+(item.content||'');
      if(item.calories) l+=' · '+item.calories+'卡';
      if(item.source) l+=' · '+item.source;
      if(item.nutrition) l+=' · 营养'+item.nutrition;
      if(item.emotional && item.emotional!=='否') l+=' · '+item.emotional;
    } else if(id==='photo'){
      l=item.title||'摄影作品';
      if(item.style) l+=' · '+item.style;
      if(item.location) l+=' · '+item.location;
      if(item.device) l+=' · '+item.device;
      if(item.quality) l+=' · ⭐'+item.quality;
      if(item.learnPoint) l+=' · '+String(item.learnPoint).substring(0,30);
    } else if(id==='think'){
      var thinkParts=[];
      if(item.category) thinkParts.push(item.category);
      if(item.title) thinkParts.push(item.title);
      l=thinkParts.length?thinkParts.join(' · '):(item.content||'思考');
      if(item.cognitiveLevel) l+=' · '+item.cognitiveLevel;
      if(item.rating) l+=' · 深度'+item.rating+'/5';
      if(item.principle) l+=' · 原则:'+String(item.principle).substring(0,30);
      if(item.action) l+=' · 行动:'+String(item.action).substring(0,30);
    } else if(id==='diary'){
      var diaryParts=[];
      if(item.mood) diaryParts.push(item.mood);
      if(item.weather) diaryParts.push(item.weather);
      if(item.energy) diaryParts.push('能量'+item.energy);
      l=diaryParts.length?diaryParts.join(' · '):(item.content||'日记');
      if(item.highlight) l+=' · 高光:'+String(item.highlight).substring(0,30);
      if(item.tomorrow) l+=' · 明日:'+String(item.tomorrow).substring(0,20);
    } else if(id==='learn'){
      l=(item.subject||'')+' · '+(item.content||'学习记录');
      if(item.duration) l+=' · '+item.duration+'分钟';
      if(item.understanding) l+=' · 理解'+item.understanding;
    } else if(id==='inventory'){
      var invParts=[];
      if(item.name) invParts.push(item.name);
      if(item.category) invParts.push(item.category);
      if(item.quantity) invParts.push('×'+item.quantity);
      l=invParts.length?invParts.join(' · '):(item.content||'物品');
      if(item.price) l+=' · ¥'+item.price;
      if(item.location) l+=' · '+item.location;
      if(item.usageFreq) l+=' · '+item.usageFreq;
      if(item.necessity) l+=' · '+item.necessity;
      if(item.declutter && item.declutter!=='保留') l+=' · ['+item.declutter+']';
    } else if(id==='space'){
      var spParts=[];
      if(item.name) spParts.push(item.name);
      if(item.function) spParts.push(item.function);
      l=spParts.length?spParts.join(' · '):(item.content||'空间');
      if(item.area) l+=' · '+item.area+'㎡';
      if(item.tidiness) l+=' · 整洁'+item.tidiness+'/5';
      if(item.comfort) l+=' · 舒适'+item.comfort+'/5';
      if(item.usageFreq) l+=' · '+item.usageFreq;
      if(item.improve) l+=' · 待改进:'+String(item.improve).substring(0,30);
    } else if(id==='body'){
      // 身体：优先显示症状/体重/血压
      var bodyParts=[];
      if(item.symptom) bodyParts.push(item.symptom);
      if(item.weight) bodyParts.push('体重'+item.weight+'kg');
      if(item.bloodPressure) bodyParts.push('血压'+item.bloodPressure);
      if(item.area) bodyParts.push(item.area);
      if(item.severity) bodyParts.push('严重度'+item.severity+'/5');
      l=bodyParts.length?bodyParts.join(' · '):(item.content||'身体记录');
      if(item.content && bodyParts.length) l+=' · '+item.content;
    } else if(id==='relation'){
      var relParts=[];
      if(item.person) relParts.push(item.person);
      if(item.role) relParts.push(item.role);
      if(item.interaction) relParts.push(item.interaction);
      if(item.favorType && item.favorType!=='无') relParts.push(item.favorType);
      l=relParts.length?relParts.join(' · '):(item.content||'关系记录');
      if(item.feel) l+=' · 感受'+item.feel+'/10';
      if(item.cost) l+=' · ¥'+item.cost;
      if(item.topic) l+=' · '+String(item.topic).substring(0,30);
    } else if(id==='work'){
      var workParts=[];
      if(item.role) workParts.push(item.role);
      if(item.task) workParts.push(String(item.task).substring(0,30));
      l=workParts.length?workParts.join(' · '):(item.content||'工作记录');
      if(item.focusLevel) l+=' · 专注'+item.focusLevel+'/5';
      if(item.income) l+=' · ¥'+item.income;
      if(item.meaning) l+=' · 价值'+item.meaning;
    } else if(id==='home'){
      var homeParts=[];
      if(item.space) homeParts.push(item.space);
      if(item.action) homeParts.push(item.action);
      if(item.items) homeParts.push(item.items);
      l=homeParts.length?homeParts.join(' · '):(item.content||'居住记录');
      if(item.cost) l+=' · ¥'+item.cost;
      if(item.security) l+=' · 安全感'+item.security;
    } else if(id==='travel'){
      var trvParts=[];
      if(item.purpose) trvParts.push(item.purpose);
      if(item.transport) trvParts.push(item.transport);
      if(item.from||item.to) trvParts.push((item.from||'?')+'→'+(item.to||'?'));
      l=trvParts.length?trvParts.join(' · '):(item.content||'出行记录');
      if(item.cost) l+=' · ¥'+item.cost;
      if(item.comfort) l+=' · 舒适'+item.comfort;
    } else if(id==='time'){
      var timeParts=[];
      if(item.category) timeParts.push(item.category);
      if(item.duration) timeParts.push(item.duration+'分钟');
      l=timeParts.length?timeParts.join(' · '):(item.content||'时间记录');
      if(item.value) l+=' · '+item.value;
      if(item.content) l+=' · '+String(item.content).substring(0,30);
    } else if(id==='growth' || id==='learn'){
      // id='learn' 为旧数据兼容，统一按成长新格式显示
      var growParts=[];
      if(item.type) growParts.push(item.type);
      if(item.skill) growParts.push(item.skill);
      else if(item.subject) growParts.push(item.subject); // 旧 learn 兼容
      if(item.method) growParts.push(item.method);
      if(item.duration) growParts.push(item.duration+'分钟');
      l=growParts.length?growParts.join(' · '):(item.content||'成长记录');
      if(item.progress) l+=' · 进步:'+String(item.progress).substring(0,30);
      else if(item.understanding) l+=' · 掌握'+item.understanding;
      if(item.output) l+=' · 产出:'+String(item.output).substring(0,20);
    } else if(id==='spirit'){
      var spiParts=[];
      if(item.mood) spiParts.push(item.mood);
      if(item.practice) spiParts.push(item.practice);
      if(item.duration) spiParts.push(item.duration+'分钟');
      l=spiParts.length?spiParts.join(' · '):(item.content||'精神记录');
      if(item.belief) l+=' · '+String(item.belief).substring(0,30);
    } else if(id==='pet'){
      var petParts=[];
      if(item.petName) petParts.push(item.petName);
      if(item.type) petParts.push(item.type);
      if(item.sceneType) petParts.push(item.sceneType);
      if(item.action) petParts.push(item.action);
      if(item.mood) petParts.push(item.mood);
      l=petParts.length?petParts.join(' · '):(item.content||'宠物记录');
      if(item.cost) l+=' · ¥'+item.cost;
      if(item.food) l+=' · '+item.food;
      if(item.healthNote) l+=' · '+item.healthNote;
      if(item.vetNote) l+=' · 就医:'+item.vetNote;
    } else if(id==='health' || id==='body' || id==='medical'){
      // id='body'/'medical' 为旧数据兼容，统一按 health 新格式显示
      var hParts=[];
      if(item.sceneType) hParts.push(item.sceneType);
      else if(id==='body') hParts.push('身体观察');
      else if(id==='medical') hParts.push(item.type||'就医');
      if(item.symptom) hParts.push(item.symptom);
      if(item.area) hParts.push(item.area);
      if(item.hospital) hParts.push(item.hospital);
      if(item.department) hParts.push(item.department);
      if(item.weight) hParts.push('体重'+item.weight+'kg');
      if(item.bloodPressure) hParts.push('血压'+item.bloodPressure);
      if(item.severity) hParts.push('严重度'+item.severity+'/5');
      l=hParts.length?hParts.join(' · '):(item.content||'健康记录');
      if(item.diagnosis) l+=' → '+item.diagnosis;
      if(item.cost) l+=' · ¥'+item.cost;
      if(item.nextVisit) l+=' · 复诊:'+item.nextVisit;
    } else if(id==='todo'){
      var todoParts=[];
      if(item.priority) todoParts.push(item.priority);
      if(item.status) todoParts.push(item.status);
      if(item.category) todoParts.push(item.category);
      l=todoParts.length?todoParts.join(' · '):(item.content||'待办');
      if(item.dueDate) l+=' · 截止:'+item.dueDate;
    } else {
      l=item.content||item.name||item.title||'记录';
      if(item.amount) l+=' ¥'+item.amount;
      if(item.rating) l+=' · 评分'+item.rating;
    }
    var dateStr=item.date?'<div class="sb">'+escapeHtml(item.date)+'</div>':'';
    return '<div class="rec"><div><div class="tt">'+escapeHtml(l)+'</div>'+dateStr+'</div><div class="ac"><button onclick="editRec(\''+escapeHtml(id)+'\',\''+escapeHtml(item.id)+'\')">✏️</button><button class="dl" onclick="delRec(\''+escapeHtml(id)+'\',\''+escapeHtml(item.id)+'\')">🗑️</button></div></div>';
  }).join('')+'</div>';
}

// 模块专属表单定义
var MODAL_FORMS = {
  finance: {
    title: '财务记录',
    fields: [
      {key:'type', label:'类型', type:'select', options:['支出','收入']},
      {key:'amount', label:'金额(¥)', type:'number', placeholder:'0.00'},
      {key:'category', label:'分类', type:'select', options:['餐饮','交通','购物','娱乐','医疗','教育','工资','奖金','其他']},
      {key:'paymentMethod', label:'支付方式', type:'select', options:['微信','支付宝','现金','银行卡','信用卡','其他']},
      {key:'necessity', label:'必要性', type:'select', options:['1-刚需','2-需要','3-想要','4-冲动']},
      {key:'account', label:'资金账户', type:'text', placeholder:'例：招商卡/余额宝/钱包'},
      {key:'content', label:'备注', type:'text', placeholder:'简要说明'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  sleep: {
    title: '睡眠记录',
    fields: [
      {key:'hours', label:'时长(小时)', type:'number', placeholder:'如 7.5'},
      {key:'sleepTime', label:'入睡时间', type:'time'},
      {key:'wakeTime', label:'起床时间', type:'time'},
      {key:'quality', label:'质量', type:'select', options:['很差','差','一般','好','很好']},
      {key:'nap', label:'午睡分钟', type:'number', placeholder:'如 30'},
      {key:'nightWakes', label:'夜醒次数', type:'select', options:['0','1','2','3','4+']},
      {key:'dream', label:'是否做梦', type:'select', options:['无/不记得','有好梦','有梦境','有噩梦']},
      {key:'content', label:'备注', type:'text', placeholder:'睡眠状况描述'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  exercise: {
    title: '锻炼记录',
    fields: [
      {key:'type', label:'类型', type:'select', options:['跑步','骑行','游泳','力量','瑜伽','拉伸','其他']},
      {key:'duration', label:'时长(分钟)', type:'number', placeholder:'30'},
      {key:'distance', label:'距离(km)', type:'number', placeholder:'如 5.2'},
      {key:'calories', label:'消耗卡路里', type:'number', placeholder:'如 350'},
      {key:'sets', label:'组数', type:'number', placeholder:'如 4'},
      {key:'reps', label:'每组次数', type:'number', placeholder:'如 12'},
      {key:'intensity', label:'强度', type:'select', options:['轻松','中等','剧烈']},
      {key:'bodyFeedback', label:'身体反馈', type:'select', options:['轻松','有点累','刚好','很累','酸痛']},
      {key:'content', label:'备注', type:'text', placeholder:'感受说明'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  emotion: {
    title: '情绪记录',
    fields: [
      {key:'rating', label:'情绪评分(1-10)', type:'select', options:['1','2','3','4','5','6','7','8','9','10']},
      {key:'trigger', label:'触发源/事件', type:'text', placeholder:'什么事引起的？'},
      {key:'physical', label:'身体感受', type:'text', placeholder:'如：胸口紧/头晕/胃胀'},
      {key:'action', label:'当时做了什么', type:'textarea', placeholder:'描述当时的行为...'},
      {key:'content', label:'描述', type:'text', placeholder:'心情如何？'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  diet: {
    title: '饮食记录',
    fields: [
      {key:'meal', label:'餐次', type:'select', options:['早餐','午餐','晚餐','加餐','夜宵']},
      {key:'content', label:'食物', type:'text', placeholder:'如：鸡胸肉沙拉+糙米饭'},
      {key:'satiety', label:'饱腹感', type:'select', options:['3分饱','5分饱','7分饱','9分饱','吃撑了']},
      {key:'source', label:'来源', type:'select', options:['自做','外卖','堂食','食堂','零食','朋友请']},
      {key:'cost', label:'花费(¥)', type:'number', placeholder:'外卖/堂食/零食金额，自动记账'},
      {key:'calories', label:'卡路里', type:'number', placeholder:'可选'},
      {key:'water', label:'饮水量(ml)', type:'number', placeholder:'如 1500'},
      {key:'nutrition', label:'营养均衡自评', type:'select', options:['1-单一','2-偏缺','3-一般','4-均衡','5-完美']},
      {key:'afterFeel', label:'餐后体感', type:'select', options:['精力充沛','舒适','困倦','腹胀','罪恶感','满足']},
      {key:'emotional', label:'情绪性进食', type:'select', options:['否','是-焦虑','是-孤独','是-压力','是-奖励']},
      {key:'trigger', label:'触发原因', type:'text', placeholder:'如：加班晚/看到广告/情绪低落'},
      {key:'improve', label:'下次改进', type:'textarea', placeholder:'如：提前备餐/减少外卖/多喝水'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  photo: {
    title: '摄影记录',
    fields: [
      {key:'title', label:'作品名称', type:'text', placeholder:'作品标题'},
      {key:'location', label:'拍摄地点', type:'text', placeholder:'如：西湖断桥'},
      {key:'device', label:'设备', type:'text', placeholder:'如：iPhone 15 / Sony A7M4'},
      {key:'style', label:'风格', type:'select', options:['人像','风景','街拍','美食','建筑','微距','夜景','黑白','纪实','其他']},
      {key:'aperture', label:'光圈', type:'text', placeholder:'如 f/2.8'},
      {key:'shutter', label:'快门', type:'text', placeholder:'如 1/125'},
      {key:'iso', label:'ISO', type:'number', placeholder:'如 400'},
      {key:'postProcess', label:'后期', type:'select', options:['原片直出','轻度调色','重度修图','黑白转换','HDR合成']},
      {key:'quality', label:'满意度(1-5)', type:'select', options:['1','2','3','4','5']},
      {key:'mood', label:'当时心境', type:'text', placeholder:'拍摄时的心情/感受'},
      {key:'learnPoint', label:'学习收获', type:'textarea', placeholder:'构图/光影/时机的感悟'},
      {key:'content', label:'描述', type:'textarea', placeholder:'作品说明...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  think: {
    title: '认真思考',
    fields: [
      {key:'category', label:'思考类型', type:'select', options:['决策权衡','事件复盘','灵感记录','疑问探究','原则提炼','反常识洞察','未来推演','人性观察']},
      {key:'title', label:'标题', type:'text', placeholder:'一句话概括'},
      {key:'content', label:'思考内容', type:'textarea', placeholder:'详细推演你的思考过程...'},
      {key:'context', label:'触发场景', type:'text', placeholder:'什么事/什么人引发的思考'},
      {key:'reasoning', label:'推演过程', type:'textarea', placeholder:'你的分析逻辑：因为...所以...但是...'},
      {key:'counter', label:'反面观点', type:'textarea', placeholder:'如果反过来想呢？反对者会怎么说？'},
      {key:'action', label:'转化为行动', type:'textarea', placeholder:'这个思考如何指导我的下一步？'},
      {key:'principle', label:'可提炼原则', type:'text', placeholder:'能否抽象成一条可复用原则？'},
      {key:'verify', label:'验证方式', type:'text', placeholder:'如何知道这个思考是对的？多久验证？'},
      {key:'cognitiveLevel', label:'认知层级', type:'select', options:['1-表象','2-规律','3-系统','4-本质','5-元认知']},
      {key:'rating', label:'深度(1-5)', type:'select', options:['1','2','3','4','5']},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  diary: {
    title: '日记',
    fields: [
      {key:'mood', label:'今日心情', type:'select', options:['😊开心','😐平淡','😔低落','😤烦躁','😴疲惫','🤔迷茫','😌平静','🥰感恩']},
      {key:'weather', label:'天气', type:'select', options:['晴','多云','阴','雨','雪','雾','大风']},
      {key:'highlight', label:'今日高光', type:'textarea', placeholder:'今天最值得记住的一件事'},
      {key:'lowlight', label:'今日不足', type:'textarea', placeholder:'今天哪里做得不够好？'},
      {key:'gratitude', label:'感恩三事', type:'textarea', placeholder:'1. ... 2. ... 3. ...'},
      {key:'content', label:'日记正文', type:'textarea', placeholder:'记录今天的经历、感受、对话...'},
      {key:'dialogue', label:'自我对话', type:'textarea', placeholder:'如果和明天的自己说一句话...'},
      {key:'tomorrow', label:'明日重点', type:'text', placeholder:'明天最该做的一件事'},
      {key:'energy', label:'能量值 1-10', type:'select', options:['1','2','3','4','5','6','7','8','9','10']},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  learn: {
    title: '学习记录',
    fields: [
      {key:'subject', label:'学科/主题', type:'text', placeholder:'如：英语、编程、设计'},
      {key:'content', label:'学习内容', type:'textarea', placeholder:'学了什么...'},
      {key:'output', label:'产出/成果', type:'textarea', placeholder:'例：做了3道题/写了笔记'},
      {key:'understanding', label:'理解度', type:'select', options:['1-听不明白','2-有点懂','3-懂了','4-会用','5-能教']},
      {key:'duration', label:'时长(分钟)', type:'number', placeholder:'30'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  growth: {
    title: '成长记录（学习/技能/习惯突破/心智）',
    fields: [
      {key:'type', label:'成长类型', type:'select', options:['学习','技能','习惯突破','心智模式','知识输出','身体突破','品格修炼']},
      {key:'skill', label:'方向/技能', type:'text', placeholder:'例：英语、编程、早起、跑步'},
      {key:'method', label:'方法', type:'select', options:['看书','听课','练习','复盘','请教','践行','输出作品','冥想反思']},
      {key:'duration', label:'时长(分钟)', type:'number', placeholder:'如 45'},
      {key:'understanding', label:'掌握度', type:'select', options:['1-入门','2-有点懂','3-懂了','4-会用','5-能教']},
      {key:'progress', label:'今日突破/进步', type:'textarea', placeholder:'取得了什么进步...'},
      {key:'obstacle', label:'遇到的障碍', type:'textarea', placeholder:'遇到了什么困难...'},
      {key:'plan', label:'下一步计划', type:'textarea', placeholder:'接下来怎么做...'},
      {key:'output', label:'产出/成果', type:'textarea', placeholder:'例：写了文章/跑了5km/通过考试'},
      {key:'content', label:'总结', type:'textarea', placeholder:'今日成长总结...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  health: {
    title: '健康记录（身体观察+就医行动）',
    fields: [
      {key:'sceneType', label:'场景类型', type:'select', options:['身体观察','体检','门诊','急诊','牙科','眼科','皮肤科','中医','心理咨询','复诊','疫苗','手术','住院','复查']},
      {key:'symptom', label:'症状/主诉', type:'text', placeholder:'如：发烧3天/咳嗽/体检'},
      {key:'area', label:'部位', type:'text', placeholder:'如：颈部/胃/全身体检'},
      {key:'severity', label:'严重度 1-5', type:'select', options:['1','2','3','4','5']},
      {key:'measure', label:'处理方式', type:'textarea', placeholder:'吃药/休息/就医/已预约...'},
      {key:'hospital', label:'医院/诊所', type:'text', placeholder:'如：市第一人民医院'},
      {key:'department', label:'科室', type:'text', placeholder:'如：内科/骨科'},
      {key:'doctor', label:'医生', type:'text', placeholder:'（可选）'},
      {key:'diagnosis', label:'诊断结果', type:'text', placeholder:'如：上呼吸道感染'},
      {key:'prescription', label:'处方/用药', type:'textarea', placeholder:'医生开的药和用量'},
      {key:'weight', label:'体重(kg)', type:'number', placeholder:'可选'},
      {key:'bloodPressure', label:'血压', type:'text', placeholder:'如：120/80'},
      {key:'cost', label:'花费(¥)', type:'number', placeholder:'0.00（自动同步到财务）'},
      {key:'paymentMethod', label:'支付方式', type:'select', options:['','医保','微信','支付宝','现金','银行卡','其他']},
      {key:'nextVisit', label:'下次复诊', type:'date'},
      {key:'content', label:'备注', type:'textarea', placeholder:'医嘱/注意事项/恢复情况...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  inventory: {
    title: '物品登记',
    fields: [
      {key:'name', label:'物品名称', type:'text', placeholder:'如：笔记本电脑'},
      {key:'category', label:'分类', type:'select', options:['电子产品','衣物','书籍','厨具','家具','美妆','运动','文具','其他']},
      {key:'quantity', label:'数量', type:'number', placeholder:'1'},
      {key:'minStock', label:'补货阈值', type:'number', placeholder:'低于此值提醒补货，如 2'},
      {key:'restockQty', label:'本次补货数量', type:'number', placeholder:'补货填此处，自动记账'},
      {key:'restockPrice', label:'本次补货单价(¥)', type:'number', placeholder:'补货单价，自动算总额记账'},
      {key:'price', label:'购入价格(¥)', type:'number', placeholder:'如 5999'},
      {key:'purchaseDate', label:'购入日期', type:'date'},
      {key:'location', label:'存放位置', type:'text', placeholder:'如：书房书架第二层'},
      {key:'usageFreq', label:'使用频率', type:'select', options:['每日','每周','每月','季节性','几乎不用','已闲置']},
      {key:'lifespan', label:'预期寿命', type:'text', placeholder:'如 3年/500次'},
      {key:'condition', label:'当前状态', type:'select', options:['全新','良好','有磨损','需维修','报废边缘']},
      {key:'necessity', label:'必需程度', type:'select', options:['1-刚需','2-常用','3-偶尔用','4-可替代','5-可丢弃']},
      {key:'declutter', label:'断舍离决策', type:'select', options:['保留','犹豫','考虑处理','即将丢弃','已捐赠/出售']},
      {key:'emotion', label:'情感价值', type:'text', placeholder:'如：礼物/纪念/无特殊'},
      {key:'content', label:'备注', type:'textarea', placeholder:'用途说明、保修信息等...'},
      {key:'date', label:'登记日期', type:'date'}
    ]
  },
  space: {
    title: '空间管理',
    fields: [
      {key:'name', label:'空间名称', type:'text', placeholder:'如：客厅/卧室/书房'},
      {key:'function', label:'功能定位', type:'select', options:['休息','工作','用餐','收纳','运动','休闲','混合']},
      {key:'area', label:'面积(㎡)', type:'number', placeholder:'可选'},
      {key:'usageFreq', label:'使用频率', type:'select', options:['每日','每周','偶尔','几乎不用']},
      {key:'stayHours', label:'日均停留(小时)', type:'number', placeholder:'如 8'},
      {key:'tidiness', label:'整洁度 1-5', type:'select', options:['1-混乱','2-偏乱','3-一般','4-整洁','5-极简']},
      {key:'comfort', label:'舒适度 1-5', type:'select', options:['1','2','3','4','5']},
      {key:'lighting', label:'采光', type:'select', options:['充足','适中','偏暗','昏暗']},
      {key:'ventilation', label:'通风', type:'select', options:['良好','一般','差']},
      {key:'itemCount', label:'物品数量估计', type:'number', placeholder:'如 30'},
      {key:'improve', label:'待改进项', type:'textarea', placeholder:'如：增加收纳/换灯泡/断舍离旧物'},
      {key:'plan', label:'改造计划', type:'text', placeholder:'如：本月清理书架/下月换窗帘'},
      {key:'content', label:'描述', type:'textarea', placeholder:'空间用途、整理情况...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  work: {
    title: '工作记录',
    fields: [
      {key:'role', label:'角色/岗位', type:'text', placeholder:'如：产品经理'},
      {key:'task', label:'今日任务', type:'textarea', placeholder:'完成了什么任务...'},
      {key:'focusLevel', label:'专注度', type:'select', options:['1-摸鱼','2-分心','3-正常','4-专注','5-心流']},
      {key:'income', label:'当日收入', type:'number', placeholder:'可选'},
      {key:'meaning', label:'价值感 1-5', type:'select', options:['1','2','3','4','5']},
      {key:'content', label:'总结', type:'textarea', placeholder:'今日工作总结...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  home: {
    title: '居住记录',
    fields: [
      {key:'space', label:'空间', type:'text', placeholder:'例：客厅/卧室'},
      {key:'action', label:'动作', type:'select', options:['打扫','整理','购买','丢弃','搬家','其他']},
      {key:'items', label:'涉及物品', type:'text', placeholder:'如：旧衣服/书架'},
      {key:'cost', label:'花费', type:'number', placeholder:'可选'},
      {key:'security', label:'安全感 1-5', type:'select', options:['1','2','3','4','5']},
      {key:'content', label:'备注', type:'textarea', placeholder:'说明备注...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  travel: {
    title: '出行记录',
    fields: [
      {key:'purpose', label:'目的', type:'select', options:['上班','办事','购物','约会','旅行','其他']},
      {key:'transport', label:'交通', type:'select', options:['步行','骑车','公交','地铁','打车','自驾','火车','飞机']},
      {key:'from', label:'起点', type:'text', placeholder:'如：家'},
      {key:'to', label:'终点', type:'text', placeholder:'如：公司'},
      {key:'cost', label:'花费', type:'number', placeholder:'可选'},
      {key:'comfort', label:'舒适度 1-5', type:'select', options:['1','2','3','4','5']},
      {key:'content', label:'备注', type:'textarea', placeholder:'出行备注...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  body: {
    title: '身体状况记录',
    fields: [
      {key:'symptom', label:'症状', type:'textarea', placeholder:'例：头晕/喉咙痛'},
      {key:'area', label:'部位', type:'text', placeholder:'例：颈部/胃'},
      {key:'severity', label:'严重度 1-5', type:'select', options:['1','2','3','4','5']},
      {key:'measure', label:'处理方式', type:'textarea', placeholder:'吃药/休息/就医...'},
      {key:'weight', label:'体重(kg)', type:'number', placeholder:'可选'},
      {key:'bloodPressure', label:'血压', type:'text', placeholder:'如：120/80'},
      {key:'content', label:'备注', type:'textarea', placeholder:'其他备注...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  relation: {
    title: '关系记录',
    fields: [
      {key:'person', label:'对方', type:'text', placeholder:'如：张三'},
      {key:'role', label:'关系', type:'select', options:['父母','伴侣','同事','朋友','领导','陌生人','其他']},
      {key:'interaction', label:'互动方式', type:'select', options:['见面','电话','微信','吵架','合作','其他']},
      {key:'topic', label:'话题/事件', type:'textarea', placeholder:'聊了什么/发生了什么...'},
      {key:'cost', label:'花费', type:'number', placeholder:'可选'},
      {key:'favorType', label:'人情类型', type:'select', options:['无','送礼','请客','随份子','借出','借入','帮人','被帮','还人情']},
      {key:'feel', label:'感受 1-10', type:'select', options:['1','2','3','4','5','6','7','8','9','10']},
      {key:'lesson', label:'收获/教训', type:'textarea', placeholder:'学到了什么...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  time: {
    title: '时间分配记录',
    fields: [
      {key:'category', label:'类型', type:'select', options:['工作','学习','运动','休息','娱乐','社交','家务','睡眠','其他']},
      {key:'duration', label:'时长(分钟)', type:'number', placeholder:'如 60'},
      {key:'value', label:'是否有价值', type:'select', options:['非常有','比较有','一般','浪费','后悔']},
      {key:'content', label:'做了什么', type:'textarea', placeholder:'具体描述...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  spirit: {
    title: '精神记录',
    fields: [
      {key:'mood', label:'心境', type:'select', options:['平静','喜悦','焦虑','低落','愤怒','迷茫','感恩']},
      {key:'practice', label:'修炼', type:'select', options:['冥想','读书','写日记','独处','祈祷','其他']},
      {key:'duration', label:'时长(分钟)', type:'number', placeholder:'如 20'},
      {key:'belief', label:'信念/感悟', type:'textarea', placeholder:'有什么感悟...'},
      {key:'gratitude', label:'感恩/觉察', type:'textarea', placeholder:'觉察到什么/感恩什么...'},
      {key:'content', label:'总结', type:'textarea', placeholder:'今日精神总结...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  pet: {
    title: '宠物记录',
    fields: [
      {key:'petName', label:'宠物名字', type:'text', placeholder:'如：小橘'},
      {key:'type', label:'宠物类型', type:'select', options:['猫','狗','兔','鸟','鱼','龟','仓鼠','蜥蜴','刺猬','其他']},
      {key:'sceneType', label:'场景类型', type:'select', options:['日常照料','健康医疗','行为训练','外出活动','特殊事件']},
      {key:'action', label:'本次行为', type:'select', options:[
        '喂食','换水/补水','铲屎/换砂','梳毛','剪指甲','洗澡','刷牙','清理耳朵',
        '遛弯','玩耍','互动陪伴','训练指令','社会化训练',
        '健康检查','量体温','称体重','喂药','涂药','打疫苗','驱虫','绝育/手术','就医看病',
        '美容造型','寄养/托管','接送出行','拍照记录',
        '领养/接回家','丢失/找回','走失预警','生病观察','去世/告别','其他'
      ]},
      {key:'mood', label:'宠物状态', type:'select', options:['活泼好动','正常','安静','嗜睡','焦虑','害怕','异常','生病','受伤','产后','老年迟缓']},
      {key:'food', label:'食物/用量', type:'text', placeholder:'如：猫粮50g / 零食 / 罐头1个'},
      {key:'cost', label:'花费(¥)', type:'number', placeholder:'0.00（自动同步到财务）'},
      {key:'healthNote', label:'健康备注', type:'text', placeholder:'如：精神好/有眼屎/拉稀/伤口愈合中'},
      {key:'vetNote', label:'就医备注', type:'text', placeholder:'医院/诊断/用药/复诊时间'},
      {key:'content', label:'记录内容', type:'textarea', placeholder:'今天和宠物的互动、趣事或观察...'},
      {key:'date', label:'日期', type:'date'}
    ]
  },
  medical: {
    title: '医疗记录',
    fields: [
      {key:'type', label:'就医类型', type:'select', options:['门诊','急诊','体检','牙科','眼科','皮肤科','中医','心理咨询','复诊','疫苗','手术','其他']},
      {key:'hospital', label:'医院/诊所', type:'text', placeholder:'如：市第一人民医院'},
      {key:'department', label:'科室', type:'text', placeholder:'如：内科/骨科'},
      {key:'doctor', label:'医生', type:'text', placeholder:'医生姓名（可选）'},
      {key:'symptom', label:'症状', type:'text', placeholder:'如：发烧3天/咳嗽/腹痛'},
      {key:'diagnosis', label:'诊断结果', type:'text', placeholder:'如：上呼吸道感染'},
      {key:'prescription', label:'处方/用药', type:'textarea', placeholder:'医生开的药和用量'},
      {key:'cost', label:'花费(¥)', type:'number', placeholder:'0.00（自动同步到财务）'},
      {key:'paymentMethod', label:'支付方式', type:'select', options:['','医保','微信','支付宝','现金','银行卡','其他']},
      {key:'nextVisit', label:'下次复诊', type:'date'},
      {key:'content', label:'备注', type:'textarea', placeholder:'医嘱/注意事项/恢复情况...'},
      {key:'date', label:'就诊日期', type:'date'}
    ]
  },
  todo: {
    title: '待办事项',
    fields: [
      {key:'title', label:'事项', type:'text', placeholder:'如：给猫打疫苗'},
      {key:'category', label:'分类', type:'select', options:['生活','工作','健康','宠物','家庭','财务','学习','出行','其他']},
      {key:'priority', label:'优先级', type:'select', options:['高-紧急','中-重要','低-有空做']},
      {key:'status', label:'状态', type:'select', options:['待办','进行中','已完成','已取消']},
      {key:'dueDate', label:'截止日期', type:'date'},
      {key:'content', label:'详情', type:'textarea', placeholder:'详细说明（可选）'},
      {key:'date', label:'创建日期', type:'date'}
    ]
  }
};

function getFormConfig(sceneId){
  if(MODAL_FORMS[sceneId]) return MODAL_FORMS[sceneId];
  return null;
}

// === 填写体验增强 ===
// 记忆上次填写的值
function getLastValues(sceneId){
  try { return JSON.parse(localStorage.getItem('fv_'+sceneId) || '{}'); } catch(e){ return {}; }
}
function saveLastValues(sceneId, data){
  // 只记忆适合作为下次默认值的字段（select/time/date），
  // 不记忆 text/textarea/number 内容字段，避免保存后填写框残留上次内容
  var config = getFormConfig(sceneId);
  var filtered = {};
  if(config){
    config.fields.forEach(function(f){
      var v = data[f.key];
      if(v === undefined || v === null || v === '') return;
      if(f.type === 'select' || f.type === 'time' || f.type === 'date'){
        filtered[f.key] = v;
      }
    });
  } else {
    if(data.date) filtered.date = data.date;
  }
  try { localStorage.setItem('fv_'+sceneId, JSON.stringify(filtered)); } catch(e){}
}
// 快捷标签：text 字段最近5次输入
function getRecentTexts(sceneId, key){
  try { return JSON.parse(localStorage.getItem('rt_'+sceneId+'_'+key) || '[]'); } catch(e){ return []; }
}
function addRecentText(sceneId, key, val){
  if(!val) return;
  try {
    var k = 'rt_'+sceneId+'_'+key;
    var arr = JSON.parse(localStorage.getItem(k) || '[]');
    arr = arr.filter(function(x){ return x !== val; });
    arr.unshift(val);
    arr = arr.slice(0, 5);
    localStorage.setItem(k, JSON.stringify(arr));
  } catch(e){}
}
// 必填字段配置
var REQUIRED_KEYS = {
  finance:['amount'], sleep:['hours'], exercise:['type','duration'],
  emotion:['rating'], diet:['content'], diary:['content'],
  think:['content'], learn:['subject'], photo:['title'],
  inventory:['name'], space:['name'],
  work:['task'], home:['space'], travel:['from'],
  body:[], relation:['person'], time:['duration','category'],
  growth:['type','skill'], spirit:['mood'], pet:['petName','action'],
  medical:['type','symptom'], todo:['title','status'], health:['sceneType']
};
function isFieldRequired(sceneId, fieldKey){
  var arr = REQUIRED_KEYS[sceneId] || [];
  return arr.indexOf(fieldKey) !== -1;
}
// 睡眠时长自动计算
function calcSleepHours(){
  var st = document.getElementById('f_sleepTime');
  var wt = document.getElementById('f_wakeTime');
  var h = document.getElementById('f_hours');
  if(st && wt && h && st.value && wt.value){
    var s = new Date('2000-01-01T'+st.value+':00');
    var w = new Date('2000-01-01T'+wt.value+':00');
    var diff = (w - s) / 3600000;
    if(diff < 0) diff += 24;
    h.value = diff.toFixed(1);
  }
}
function bindFormEvents(sceneId){
  if(sceneId === 'sleep'){
    var st = document.getElementById('f_sleepTime');
    var wt = document.getElementById('f_wakeTime');
    if(st) st.addEventListener('change', calcSleepHours);
    if(wt) wt.addEventListener('change', calcSleepHours);
  }
}
function applyQuickTag(key, encodedVal){
  var input = document.getElementById('f_'+key);
  if(input) input.value = decodeURIComponent(encodedVal);
}
function renderFormHtml(sceneId, item){
  var config = getFormConfig(sceneId);
  if(!config) return null;
  var lastVals = item ? {} : getLastValues(sceneId);
  // 读取 prefill 数据（仅新增时）
  var prefill = {};
  if(!item){
    try {
      var raw = localStorage.getItem('prefill_'+sceneId);
      if(raw){
        prefill = JSON.parse(raw) || {};
        localStorage.removeItem('prefill_'+sceneId);
      }
    } catch(e) {}
  }
  // 时间智能默认值
  var smartDefaults = {};
  if(!item){
    if(sceneId === 'diet'){
      var h = new Date().getHours();
      var mealDefault = '加餐';
      if(h <= 10) mealDefault = '早餐';
      else if(h <= 14) mealDefault = '午餐';
      else if(h <= 17) mealDefault = '加餐';
      else if(h <= 21) mealDefault = '晚餐';
      else mealDefault = '加餐';
      smartDefaults.meal = mealDefault;
    } else if(sceneId === 'sleep'){
      var lastSleep = getLastValues('sleep');
      smartDefaults.sleepTime = lastSleep.sleepTime || '23:00';
      smartDefaults.wakeTime = lastSleep.wakeTime || '07:00';
    } else if(sceneId === 'emotion'){
      smartDefaults.rating = '7';
    }
  }
  var html = '';
  var extraHtml = '';
  var reqs = REQUIRED_KEYS[sceneId] || [];
  var coreKeys = config.fields.slice(0,3).map(function(f){return f.key;}).concat(reqs).concat(['date']);
  var hasExtra = config.fields.length > 4;
  config.fields.forEach(function(f, idx){
    var val = '';
    if(item){
      val = item[f.key] || '';
    } else {
      if(prefill[f.key] !== undefined && prefill[f.key] !== ''){
        val = prefill[f.key];
      } else if(lastVals[f.key] !== undefined && lastVals[f.key] !== ''){
        val = lastVals[f.key];
      } else if(smartDefaults[f.key] !== undefined){
        val = smartDefaults[f.key];
      }
    }
    if(f.type === 'date' && !val) val = TODAY;
    var req = isFieldRequired(sceneId, f.key);
    var reqMark = req ? ' <span style="color:#EF4444">*</span>' : '';
    var fieldHtml = '<label>'+f.label+reqMark+'</label>';
    if(f.type === 'select'){
      fieldHtml += '<select id="f_'+f.key+'">';
      fieldHtml += '<option value="">请选择</option>';
      f.options.forEach(function(opt){
        var v = String(opt);
        var selected = String(val) === v ? ' selected' : '';
        fieldHtml += '<option value="'+escapeHtml(opt)+'"'+selected+'>'+escapeHtml(opt)+'</option>';
      });
      fieldHtml += '</select>';
    } else if(f.type === 'textarea'){
      fieldHtml += '<textarea id="f_'+f.key+'" rows="3" placeholder="'+escapeHtml(f.placeholder||'')+'">'+escapeHtml(val)+'</textarea>';
    } else {
      fieldHtml += '<input id="f_'+f.key+'" type="'+f.type+'" placeholder="'+escapeHtml(f.placeholder||'')+'" value="'+escapeHtml(val)+'">';
      if(f.type === 'text' && !item){
        var recents = getRecentTexts(sceneId, f.key);
        if(recents.length){
          fieldHtml += '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">';
          recents.forEach(function(r){
            fieldHtml += '<span onclick="applyQuickTag(\''+f.key+'\',\''+encodeURIComponent(r)+'\')" style="font-size:12px;padding:4px 10px;background:var(--c-accent);color:var(--c-primary);border-radius:12px;cursor:pointer">'+escapeHtml(r)+'</span>';
          });
          fieldHtml += '</div>';
        }
      }
    }
    var isCore = coreKeys.indexOf(f.key) !== -1 || idx < 3;
    if(isCore || !hasExtra){ html += fieldHtml; }
    else { extraHtml += fieldHtml; }
  });
  if(hasExtra && extraHtml){
    html += '<div id="extraFields" style="display:none;padding-top:8px;border-top:1px dashed var(--c-border);margin-top:8px">' + extraHtml + '</div>';
    html += '<div onclick="var e=document.getElementById(\'extraFields\');e.style.display=e.style.display===\'none\'?\'block\':\'none\';this.textContent=e.style.display===\'none\'?\'▽ 展开更多\' : \'△ 收起\'" style="text-align:center;font-size:13px;color:var(--c-primary);cursor:pointer;padding:8px;margin-top:4px">▽ 展开更多</div>';
  }
  return html;
}

function parseNumPrefix(v){
  if(v === undefined || v === null || v === '') return v;
  var s = String(v);
  var m = s.match(/^(\d+)/);
  if(m) return parseInt(m[1]);
  if(s === '4+') return 4;
  if(s === '吃撑了') return 10;
  return v;
}
var INT_SELECT_KEYS = {
  necessity:true, focusLevel:true, satiety:true, understanding:true,
  meaning:true, security:true, comfort:true, severity:true,
  feel:true, nightWakes:true, rating:true, quality:true
};
function readFormData(sceneId){
  var config = getFormConfig(sceneId);
  var data = {};
  if(!config){
    data.content = document.getElementById('f_c').value.trim();
    data.date = document.getElementById('f_d').value;
    var rv = document.getElementById('f_r').value;
    data.rating = rv ? parseInt(rv) : rv;
    data.note = document.getElementById('f_n').value;
    return data;
  }
  config.fields.forEach(function(f){
    var el = document.getElementById('f_'+f.key);
    if(!el) return;
    var v = el.value;
    if(f.type === 'select' && INT_SELECT_KEYS[f.key] && v !== ''){
      data[f.key] = parseNumPrefix(v);
    } else if(f.type === 'number' && v !== ''){
      data[f.key] = parseFloat(v);
    } else {
      data[f.key] = v;
    }
  });
  return data;
}

function openAdd(){
  editId=null;
  var config = getFormConfig(curScene);
  var title = config ? config.title : '添加记录';
  document.getElementById('modalTitle').textContent = title;
  var formHtml = renderFormHtml(curScene, null);
  if(formHtml){
    document.getElementById('modalBody').innerHTML = formHtml;
  } else {
    document.getElementById('modalBody').innerHTML = '<label>内容</label><input id="f_c" placeholder="记录内容"><label>日期</label><input type="date" id="f_d" value="'+TODAY+'"><label>评分(可选)</label><select id="f_r"><option value="">无</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select><label>备注</label><textarea id="f_n" rows="2"></textarea>';
  }
  bindFormEvents(curScene);
  document.getElementById('modal').classList.add('act');
}

function editRec(sceneId,id){
  var data=Array.isArray(dataCache[sceneId])?dataCache[sceneId]:[];
  var item=data.find(function(x){ return String(x.id)===String(id); });
  if(!item) return;
  editId=item.id;
  var config = getFormConfig(sceneId);
  var title = config ? '编辑'+config.title : '编辑记录';
  document.getElementById('modalTitle').textContent = title;
  var formHtml = renderFormHtml(sceneId, item);
  if(formHtml){
    document.getElementById('modalBody').innerHTML = formHtml;
  } else {
    document.getElementById('modalBody').innerHTML = '<label>内容</label><input id="f_c" value="'+escapeHtml(item.content||'')+'"><label>日期</label><input type="date" id="f_d" value="'+escapeHtml(item.date||TODAY)+'"><label>评分</label><select id="f_r"><option value="">无</option>'+[1,2,3,4,5].map(function(r){ return '<option '+(item.rating==r?'selected':'')+'>'+r+'</option>'; }).join('')+'</select><label>备注</label><textarea id="f_n" rows="2">'+escapeHtml(item.note||'')+'</textarea>';
  }
  bindFormEvents(sceneId);
  document.getElementById('modal').classList.add('act');
}

async function saveRecord(){
  var config = getFormConfig(curScene);
  var formData = readFormData(curScene);
  if(!config){
    var c = formData.content;
    if(!c){ alert('请填写内容'); return; }
  } else {
    var reqs = REQUIRED_KEYS[curScene] || [];
    for(var i=0; i<reqs.length; i++){
      var fk = reqs[i];
      var fd = config.fields.find(function(f){ return f.key === fk; });
      if(fd && (formData[fk] === '' || formData[fk] === undefined || formData[fk] === null)){
        alert('请填写'+fd.label.replace(/\s*1-\d.*/,'').replace(/\s*\(.*\)/,''));
        return;
      }
    }
    // body 模块特殊：至少填 symptom/weight/bloodPressure 其一
    if(curScene === 'body'){
      var hasAny = formData.symptom || formData.weight || formData.bloodPressure;
      if(!hasAny){ alert('请至少填写症状/体重/血压其一'); return; }
    }
  }
  // 走认知引擎 API（带反思/关联/风险反馈）
  try {
    var body = { mid: curScene, data: formData };
    if (editId) body.editId = editId;
    var r = await fetch('/api/record/add', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    var res = await r.json();
    if (res.success) {
      // 记忆本次填写值 + 快捷标签
      if(!editId){
        saveLastValues(curScene, formData);
        config.fields.forEach(function(f){
          if(f.type === 'text' && formData[f.key]) addRecentText(curScene, f.key, formData[f.key]);
        });
      }
      // 同步前端 dataCache
      if (!Array.isArray(dataCache[curScene])) dataCache[curScene] = [];
      if (editId) {
        var item = dataCache[curScene].find(function(x){ return String(x.id)===String(editId); });
        if (item) Object.assign(item, res.item);
      } else {
        dataCache[curScene].push(res.item);
      }
      // 刷新联动模块的 dataCache（联动记录立即可见）
      if (res.linkedModules && res.linkedModules.length) {
        res.linkedModules.forEach(function(mod) {
          if (mod !== curScene) {
            apiFetch(mod).then(function() {
              if (curScene === mod || document.querySelector('[data-scene="' + mod + '"]')) {
                renderDetail(mod);
              }
            });
          }
        });
      }
      closeModal();
      renderDetail(curScene);
      renderHome();
      showCognitiveFeedback(res);
    } else {
      alert(res.message || '保存失败');
    }
  } catch(e) {
    // 网络错误：入离线队列，本地立即生效（UI与旧逻辑一致）
    var data = Array.isArray(dataCache[curScene]) ? dataCache[curScene] : (dataCache[curScene] = []);
    var lItemId = null;
    if (editId) {
      var it = data.find(function(x){ return String(x.id)===String(editId); });
      if (it) Object.assign(it, formData);
      lItemId = editId;
      // 编辑场景：也入 add_record 队列（editId 不为空后端按编辑处理）
      pendingQueueAdd({ operation: 'add_record', module: curScene, data: formData, editId: editId });
    } else {
      var newItem = Object.assign({id:genId(), created:new Date().toISOString()}, formData);
      data.push(newItem);
      lItemId = newItem.id;
      // 新增入 add_record 队列
      pendingQueueAdd({ operation: 'add_record', module: curScene, data: newItem });
    }
    closeModal();
    renderDetail(curScene);
    renderHome();
    showToast('已暂存本地，上线自动同步', 'warn');
  }
}

async function delRec(sceneId,id){
  if(!confirm('确定删除？可在回收站30天内恢复')) return;
  try {
    var r = await fetch('/api/'+sceneId+'/'+id, { method: 'DELETE' });
    var d = await r.json();
    if(!d.success){ alert('删除失败：'+(d.message||'')); return; }
    var data=Array.isArray(dataCache[sceneId])?dataCache[sceneId]:[];
    dataCache[sceneId]=data.filter(function(x){ return String(x.id)!==String(id); });
    renderDetail(sceneId);
    renderHome();
  } catch(e) {
    // 离线删除：入队列 + 本地立即移除
    pendingQueueAdd({ operation: 'delete', module: sceneId, targetId: id });
    var data2=Array.isArray(dataCache[sceneId])?dataCache[sceneId]:[];
    dataCache[sceneId]=data2.filter(function(x){ return String(x.id)!==String(id); });
    renderDetail(sceneId);
    renderHome();
    showToast('已离线删除，上线同步服务端', 'warn');
  }
}

function closeModal(){ document.getElementById('modal').classList.remove('act'); editId=null; }

// ============================================================
// 认知引擎（Phase 1）：modal2 + 原则库 + 决策推演 + 反馈弹窗
// ============================================================
function closeModal2(){ document.getElementById('modal2').classList.remove('act'); }

// 回收站
async function openTrash(){
  openModal2('♻️ 回收站', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/trash');
    var list = await r.json();
    if(!list.length){
      openModal2('♻️ 回收站（空）', '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px">回收站为空<br>删除的记录会在这里保留30天</div>');
      return;
    }
    var html = '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:8px">共 '+list.length+' 条 · 30天后自动清理</div>';
    list.forEach(function(t){
      var modName = {finance:'财务',sleep:'睡眠',exercise:'锻炼',emotion:'情绪',diet:'饮食',diary:'日记',learn:'学习',photo:'摄影',think:'思考',work:'工作',home:'居住',travel:'出行',body:'身体',relation:'关系',time:'时间',growth:'成长',spirit:'精神',pet:'宠物',medical:'医疗',todo:'待办',health:'健康'}[t._module] || t._module;
      var title = t.content || t.name || t.title || t.symptom || t.person || '记录';
      var delDate = (t._deletedAt||'').split('T')[0];
      html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid #F59E0B">';
      html += '<div style="font-size:13px;color:var(--c-fg)">'+escapeHtml(String(title).substring(0,40))+'</div>';
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:2px">'+modName+' · 删于'+delDate+'</div>';
      html += '<div style="display:flex;gap:12px;margin-top:6px">';
      html += '<span style="font-size:12px;color:#10B981;cursor:pointer" onclick="restoreTrash(\''+t.id+'\')">↩️ 恢复</span>';
      html += '<span style="font-size:12px;color:#EF4444;cursor:pointer" onclick="deleteTrash(\''+t.id+'\')">彻底删除</span>';
      html += '</div></div>';
    });
    html += '<button onclick="emptyTrash()" style="width:100%;margin-top:8px;padding:10px;border:1px solid #EF4444;border-radius:10px;background:transparent;color:#EF4444;font-size:13px;cursor:pointer">清空回收站</button>';
    openModal2('♻️ 回收站（'+list.length+'）', html);
  } catch(e) {
    openModal2('♻️ 回收站', '<div style="color:#EF4444;padding:20px">加载失败</div>');
  }
}
async function restoreTrash(id){
  try {
    await fetch('/api/trash/'+id+'/restore', { method:'POST' });
    openTrash();
  } catch(e) { alert('恢复失败'); }
}
async function deleteTrash(id){
  if(!confirm('彻底删除？此操作不可撤销。')) return;
  try {
    await fetch('/api/trash/'+id, { method:'DELETE' });
    openTrash();
  } catch(e) { alert('删除失败'); }
}
async function emptyTrash(){
  if(!confirm('清空回收站？所有记录将永久删除。')) return;
  try {
    await fetch('/api/trash', { method:'DELETE' });
    openTrash();
  } catch(e) { alert('操作失败'); }
}
function openModal2(title, bodyHtml, actionsHtml){
  document.getElementById('modal2Title').textContent = title;
  document.getElementById('modal2Body').innerHTML = bodyHtml;
  document.getElementById('modal2Actions').innerHTML = actionsHtml || '<button class="cn" onclick="closeModal2()">关闭</button>';
  document.getElementById('modal2').classList.add('act');
}

// ---- 原则库 ----
async function openPrinciples(){
  openModal2('📐 原则库', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/principles');
    var list = await r.json();
    var html = '<div style="margin-bottom:14px">';
    html += '<textarea id="newPrincipleText" placeholder="提炼一条你的人生原则..." style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:14px;font-family:inherit;min-height:60px;resize:vertical"></textarea>';
    html += '<input id="newPrincipleSource" placeholder="来源（可选：范仲淹/自我感悟/反思提炼）" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-top:6px">';
    html += '<button onclick="addPrinciple()" style="width:100%;margin-top:8px;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary),var(--c-primary-2));color:#fff;font-weight:600;cursor:pointer">添加原则</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有原则。<br>每次反思后提炼一条，这是你的人生智慧积累。<br><br>例如：「不以物喜，不以己悲」「权衡利弊，先看势再看人」「能量不足时不做重要决策」</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">共 '+list.length+' 条</div>';
      list.forEach(function(p){
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid var(--c-primary)">';
        html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.5">'+escapeHtml(p.text)+'</div>';
        if (p.source) html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:4px">— '+escapeHtml(p.source)+'</div>';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span style="font-size:10px;color:#475569">'+(p.createdAt||'').split('T')[0]+'</span><span style="font-size:11px;color:#EF4444;cursor:pointer" onclick="delPrinciple(\''+p.id+'\')">删除</span></div>';
        html += '</div>';
      });
    }
    openModal2('📐 原则库（'+list.length+'）', html);
  } catch(e) { openModal2('📐 原则库', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function addPrinciple(){
  var text = document.getElementById('newPrincipleText').value.trim();
  var source = document.getElementById('newPrincipleSource').value.trim();
  if (!text) { alert('请输入原则'); return; }
  try {
    var r = await fetch('/api/principles', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:text, source:source}) });
    var d = await r.json();
    if (d.success) { openPrinciples(); loadCognitiveCounts(); }
    else alert(d.message || '添加失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delPrinciple(id){
  if (!confirm('删除这条原则？')) return;
  try {
    await fetch('/api/principles/'+id, { method:'DELETE' });
    openPrinciples(); loadCognitiveCounts();
  } catch(e) { alert('网络错误'); }
}

// ---- 决策推演台 ----
async function openDecisions(){
  openModal2('🎯 决策推演台', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/decisions');
    var list = await r.json();
    var html = '<div style="margin-bottom:14px;background:rgba(245,158,11,0.06);border-radius:10px;padding:12px;border:1px solid rgba(245,158,11,0.15)">';
    html += '<div style="font-size:11px;color:#FBBF24;margin-bottom:8px">📝 记录当下的推理，日后回溯判断力</div>';
    html += '<input id="decTitle" placeholder="决策标题（如：是否跳槽）" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<textarea id="decReason" placeholder="推理过程：基于什么事实？考虑了什么？权衡了什么？" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:60px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<input id="decExpected" placeholder="预期结果" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<input id="decDeadline" type="date" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<button onclick="addDecision()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#F59E0B,#FBBF24);color:#fff;font-weight:600;cursor:pointer">记录决策</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有决策记录。<br>面对重要选择时，记录你的推理过程，<br>日后回溯能看出你的判断力在演化。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">共 '+list.length+' 条决策</div>';
      list.forEach(function(d){
        var reviewed = d.reviewed;
        var correct = d.correct;
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:8px;border-left:3px solid '+(reviewed?(correct===true?'#22C55E':correct===false?'#EF4444':'#94A3B8'):'#FBBF24')+'">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:13px;color:var(--c-fg)">'+escapeHtml(d.title)+'</b>';
        html += '<span style="font-size:10px;padding:2px 8px;border-radius:8px;'+(reviewed?'background:rgba(34,197,94,0.15);color:#22C55E':'background:rgba(251,191,36,0.15);color:#FBBF24')+'">'+(reviewed?'已回溯':'待回溯')+'</span></div>';
        if (d.reasoning) html += '<div style="font-size:12px;color:var(--c-fg-2);margin-top:6px;line-height:1.5"><b>推理：</b>'+escapeHtml(d.reasoning)+'</div>';
        if (d.expected) html += '<div style="font-size:12px;color:var(--c-fg-2);margin-top:4px"><b>预期：</b>'+escapeHtml(d.expected)+'</div>';
        if (d.deadline) html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:4px">📅 截止：'+d.deadline+'</div>';
        if (reviewed) {
          if (d.outcome) html += '<div style="font-size:12px;color:#4B5563;margin-top:6px;padding:6px 8px;background:var(--c-surface);border-radius:6px"><b>结果：</b>'+escapeHtml(d.outcome)+'</div>';
          html += '<div style="font-size:11px;color:'+(correct===true?'#22C55E':correct===false?'#EF4444':'#94A3B8')+';margin-top:4px">'+(correct===true?'✅ 判断正确':correct===false?'❌ 判断错误':'⚖️ 中性')+'</div>';
        } else {
          html += '<button onclick="reviewDecision(\''+d.id+'\')" style="margin-top:6px;font-size:11px;padding:4px 12px;border-radius:8px;background:transparent;color:var(--c-primary);cursor:pointer">回溯结果</button>';
        }
        html += '</div>';
      });
    }
    openModal2('🎯 决策推演台（'+list.length+'）', html);
  } catch(e) { openModal2('🎯 决策推演台', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function addDecision(){
  var title = document.getElementById('decTitle').value.trim();
  var reasoning = document.getElementById('decReason').value.trim();
  var expected = document.getElementById('decExpected').value.trim();
  var deadline = document.getElementById('decDeadline').value;
  if (!title) { alert('请输入决策标题'); return; }
  try {
    var r = await fetch('/api/decisions', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:title, reasoning:reasoning, expected:expected, deadline:deadline}) });
    var d = await r.json();
    if (d.success) { openDecisions(); loadCognitiveCounts(); }
    else alert(d.message || '添加失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

function reviewDecision(id){
  var outcome = prompt('实际结果是什么？');
  if (outcome === null) return;
  var correct = confirm('判断是否正确？\n确定=正确，取消=错误') ? true : confirm('判断错误？确定=是，取消=中性') ? false : null;
  fetch('/api/decisions/'+id+'/review', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({outcome:outcome, correct:correct}) })
    .then(function(){ openDecisions(); })
    .catch(function(){ alert('网络错误'); });
}

// ============================================================
// Phase 2：深度闭环 - 5个功能弹窗
// ============================================================

// ---- 1. 5Why 根因分析 ----
async function openRootCause(){
  openModal2('🔬 5Why 根因分析', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/root-cause'); var list = await r.json();
    var html = '<div style="background:rgba(16,185,129,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid rgba(16,185,129,0.15)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 新根因分析</div>';
    html += '<label style="font-size:11px;color:var(--c-fg-2)">触发事件（让你情绪波动/决策失误的事）</label>';
    html += '<textarea id="rcTrigger" placeholder="如：今天和同事吵了一架 / 又熬夜了 / 冲动消费了" style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:14px;font-family:inherit;min-height:50px;resize:vertical;margin-bottom:8px"></textarea>';
    html += '<div id="rcWhys" style="margin-bottom:8px"></div>';
    html += '<div style="display:flex;gap:6px;margin-bottom:8px"><button onclick="addWhy()" style="flex:1;padding:8px;border:1px dashed rgba(16,185,129,0.4);border-radius:8px;background:rgba(16,185,129,0.04);color:#10B981;font-size:12px;cursor:pointer">+ 追加一层追问</button></div>';
    html += '<label style="font-size:11px;color:var(--c-fg-2)">根因（一句话，必须是你能改变的）</label>';
    html += '<input id="rcRoot" placeholder="如：我在压力下习惯性逃避对话" style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:14px;margin-bottom:8px">';
    html += '<button onclick="saveRootCause()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#10B981,#34D399);color:#fff;font-weight:600;cursor:pointer">保存根因分析</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有根因记录。<br>当你遇到反复发生的问题时，用5Why挖到底——<br>表层原因解决一次，根因解决一辈子。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">共 '+list.length+' 条</div>';
      list.forEach(function(rc){
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid '+(rc.resolved?'#22C55E':'#F59E0B')+'">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:11px;color:var(--c-fg-3)">'+rc.date+'</span><span style="font-size:10px;padding:2px 8px;border-radius:10px;background:'+(rc.resolved?'rgba(34,197,94,0.15)':'rgba(245,158,11,0.15)')+';color:'+(rc.resolved?'#22C55E':'#F59E0B')+'">'+(rc.resolved?'已解决':'待解决')+'</span></div>';
        html += '<div style="font-size:13px;color:var(--c-fg);margin-top:6px"><b>触发：</b>'+escapeHtml(rc.trigger)+'</div>';
        if (rc.whys && rc.whys.length) {
          html += '<div style="margin-top:6px">';
          rc.whys.forEach(function(w, i){ html += '<div style="font-size:12px;color:#4B5563;padding:3px 0;white-space:pre-wrap"><span style="color:#10B981">'+(i+1)+'. 为什么：</span>'+escapeHtml(w)+'</div>'; });
          html += '</div>';
        }
        if (rc.root) html += '<div style="font-size:12px;color:#10B981;margin-top:6px;padding:6px 10px;background:rgba(16,185,129,0.06);border-radius:6px"><b>根因：</b>'+escapeHtml(rc.root)+'</div>';
        if (rc.resolved && rc.resolvedAction) html += '<div style="font-size:11px;color:#22C55E;margin-top:4px">✓ 采取行动：'+escapeHtml(rc.resolvedAction)+'</div>';
        html += '<div style="display:flex;gap:8px;margin-top:8px">';
        if (!rc.resolved) html += '<button onclick="resolveRootCause(\''+rc.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(34,197,94,0.3);border-radius:8px;background:rgba(34,197,94,0.06);color:#22C55E;cursor:pointer">标记已解决</button>';
        html += '<button onclick="delRootCause(\''+rc.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button>';
        html += '</div></div>';
      });
    }
    addWhyCount = 0;
    renderWhyInputs();
    openModal2('🔬 5Why 根因分析（'+list.length+'）', html);
  } catch(e) { openModal2('🔬 5Why 根因分析', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

var addWhyCount = 0;
function renderWhyInputs(){
  var c = document.getElementById('rcWhys'); if(!c) return;
  var html = '';
  for (var i=0; i<addWhyCount+1; i++) {
    html += '<label style="font-size:11px;color:var(--c-fg-2)">第 '+(i+1)+' 层 为什么？</label>';
    html += '<input id="rcWhy'+i+'" placeholder="因为..." style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
  }
  c.innerHTML = html;
}
function addWhy(){ addWhyCount++; renderWhyInputs(); }

async function saveRootCause(){
  var trigger = document.getElementById('rcTrigger').value.trim();
  var root = document.getElementById('rcRoot').value.trim();
  var whys = [];
  for (var i=0; i<=addWhyCount; i++) {
    var v = document.getElementById('rcWhy'+i).value.trim();
    if (v) whys.push(v);
  }
  if (!trigger) { alert('请填写触发事件'); return; }
  if (whys.length === 0) { alert('请至少填写一层"为什么"'); return; }
  try {
    var r = await fetch('/api/root-cause', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({trigger:trigger, whys:whys, root:root}) });
    var d = await r.json();
    if (d.success) {
      openRootCause(); loadCognitiveCounts();
      if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection});
    } else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function resolveRootCause(id){
  var action = prompt('你采取了什么行动来解决这个根因？');
  if (action === null) return;
  try {
    await fetch('/api/root-cause/'+id+'/resolve', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:action}) });
    openRootCause(); loadCognitiveCounts();
  } catch(e) { alert('网络错误'); }
}

async function delRootCause(id){
  if (!confirm('删除这条根因记录？')) return;
  try {
    await fetch('/api/root-cause/'+id, { method:'DELETE' });
    openRootCause(); loadCognitiveCounts();
  } catch(e) { alert('网络错误'); }
}

// ---- 2. 人际博弈日志 ----
async function openInterpersonal(){
  openModal2('♟️ 人际博弈日志', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/interpersonal'); var list = await r.json();
    var html = '<div style="background:rgba(245,158,11,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid rgba(245,158,11,0.15)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 新博弈记录</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px"><input id="ipPerson" placeholder="对象姓名" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"><input id="ipRole" placeholder="角色（同事/家人/朋友）" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"></div>';
    html += '<textarea id="ipEvent" placeholder="发生了什么事？" style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:50px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px"><input id="ipMyGoal" placeholder="我要什么？" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"><input id="ipTheirGoal" placeholder="他/她要什么？" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"></div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px"><input id="ipMyMove" placeholder="我做了什么" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"><input id="ipTheirMove" placeholder="他/她做了什么" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"></div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px"><input id="ipMyCost" type="number" placeholder="我的成本(0-10)" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"><input id="ipMyGain" type="number" placeholder="我的收益(0-10)" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"></div>';
    html += '<textarea id="ipLesson" placeholder="一句教训/收获" style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:40px;resize:vertical;margin-bottom:8px"></textarea>';
    html += '<button onclick="saveInterpersonal()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#F59E0B,#FBBF24);color:#fff;font-weight:600;cursor:pointer">保存博弈</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有博弈记录。<br>鬼谷子：知彼知己，胜乃不殆；知天知地，胜乃可全。<br>记录每次重要互动，看清背后的利益/成本结构。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">共 '+list.length+' 条</div>';
      list.forEach(function(it){
        var netColor = it.net > 0 ? '#22C55E' : it.net < 0 ? '#EF4444' : '#94A3B8';
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid '+netColor+'">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;color:var(--c-fg);font-weight:600">'+escapeHtml(it.person)+(it.role?' · '+escapeHtml(it.role):'')+'</span><span style="font-size:10px;color:var(--c-fg-3)">'+it.date+'</span></div>';
        html += '<div style="font-size:12px;color:#4B5563;margin-top:4px">'+escapeHtml(it.event)+'</div>';
        if (it.myGoal) html += '<div style="font-size:11px;color:var(--c-fg-2);margin-top:4px">我要：'+escapeHtml(it.myGoal)+'</div>';
        if (it.theirGoal) html += '<div style="font-size:11px;color:var(--c-fg-2)">他要：'+escapeHtml(it.theirGoal)+'</div>';
        html += '<div style="font-size:11px;color:'+netColor+';margin-top:4px">净收益：'+(it.net>=0?'+':'')+it.net+'（成本'+it.myCost+' / 收益'+it.myGain+'）</div>';
        if (it.lesson) html += '<div style="font-size:11px;color:#FBBF24;margin-top:4px;padding:4px 8px;background:rgba(251,191,36,0.06);border-radius:6px">💡 '+escapeHtml(it.lesson)+'</div>';
        html += '<div style="margin-top:6px"><button onclick="delInterpersonal(\''+it.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button></div>';
        html += '</div>';
      });
    }
    openModal2('♟️ 人际博弈日志（'+list.length+'）', html);
  } catch(e) { openModal2('♟️ 人际博弈日志', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveInterpersonal(){
  var data = {
    person: document.getElementById('ipPerson').value.trim(),
    role: document.getElementById('ipRole').value.trim(),
    event: document.getElementById('ipEvent').value.trim(),
    myGoal: document.getElementById('ipMyGoal').value.trim(),
    theirGoal: document.getElementById('ipTheirGoal').value.trim(),
    myMove: document.getElementById('ipMyMove').value.trim(),
    theirMove: document.getElementById('ipTheirMove').value.trim(),
    myCost: document.getElementById('ipMyCost').value,
    myGain: document.getElementById('ipMyGain').value,
    lesson: document.getElementById('ipLesson').value.trim()
  };
  if (!data.person || !data.event) { alert('请填写对象和事件'); return; }
  try {
    var r = await fetch('/api/interpersonal', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openInterpersonal(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delInterpersonal(id){
  if (!confirm('删除这条博弈记录？')) return;
  try { await fetch('/api/interpersonal/'+id, { method:'DELETE' }); openInterpersonal(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 3. 定力训练 ----
async function openMindfulness(){
  openModal2('🧘 定力训练', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r1 = await fetch('/api/mindfulness'); var list = await r1.json();
    var r2 = await fetch('/api/mindfulness/baseline'); var base = await r2.json();
    var html = '';
    if (base && base.interpretation) {
      html += '<div style="background:var(--c-accent);border-radius:10px;padding:12px;margin-bottom:14px;border-left:3px solid var(--c-primary)">';
      html += '<div style="font-size:12px;color:var(--c-primary);margin-bottom:6px">📊 心境基线</div>';
      html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.6;white-space:pre-wrap">'+escapeHtml(base.interpretation)+'</div>';
      html += '</div>';
    }
    html += '<div style="background:var(--c-accent);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid var(--c-border)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 新训练记录</div>';
    html += '<label style="font-size:11px;color:var(--c-fg-2)">类型</label>';
    html += '<select id="mfType" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<option value="情绪冲击">情绪冲击（被激怒/焦虑）</option>';
    html += '<option value="诱惑">诱惑（想吃/想买/想刷）</option>';
    html += '<option value="延迟满足">延迟满足</option>';
    html += '<option value="冥想">主动冥想</option>';
    html += '<option value="停顿">停顿3秒</option>';
    html += '</select>';
    html += '<input id="mfTrigger" placeholder="触发事件（如：被领导批评）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px"><div><label style="font-size:11px;color:var(--c-fg-2)">触发前心境(1-5)</label><input id="mfBefore" type="number" min="1" max="5" value="3" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"></div><div><label style="font-size:11px;color:var(--c-fg-2)">触发后心境(1-5)</label><input id="mfAfter" type="number" min="1" max="5" value="3" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"></div></div>';
    html += '<input id="mfMethod" placeholder="用了什么方法（深呼吸/离开现场/数到10）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<textarea id="mfNote" placeholder="感悟（可选）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:40px;resize:vertical;margin-bottom:8px"></textarea>';
    html += '<button onclick="saveMindfulness()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary),var(--c-primary));color:#fff;font-weight:600;cursor:pointer">保存训练</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有训练记录。<br>定力不是"忍住"，是"看见而不被带走"。<br>每次情绪冲击，都是一次训练机会——记录下来，看清自己的反应模式。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">共 '+list.length+' 条</div>';
      list.forEach(function(m){
        var dColor = m.delta > 0 ? '#22C55E' : m.delta < 0 ? '#EF4444' : '#94A3B8';
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid '+dColor+'">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:12px;color:var(--c-fg);font-weight:600">'+escapeHtml(m.type)+'</span><span style="font-size:10px;color:var(--c-fg-3)">'+m.date+'</span></div>';
        if (m.trigger) html += '<div style="font-size:12px;color:#4B5563;margin-top:4px">触发：'+escapeHtml(m.trigger)+'</div>';
        html += '<div style="font-size:11px;color:'+dColor+';margin-top:4px">心境 '+m.beforeLevel+' → '+m.afterLevel+' ('+(m.delta>=0?'+':'')+m.delta+')</div>';
        if (m.method) html += '<div style="font-size:11px;color:var(--c-fg-2);margin-top:2px">方法：'+escapeHtml(m.method)+'</div>';
        if (m.note) html += '<div style="font-size:11px;color:var(--c-primary);margin-top:4px;padding:4px 8px;background:var(--c-accent);border-radius:6px">📝 '+escapeHtml(m.note)+'</div>';
        html += '<div style="margin-top:6px"><button onclick="delMindfulness(\''+m.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button></div>';
        html += '</div>';
      });
    }
    openModal2('🧘 定力训练（'+list.length+'）', html);
  } catch(e) { openModal2('🧘 定力训练', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveMindfulness(){
  var data = {
    type: document.getElementById('mfType').value,
    trigger: document.getElementById('mfTrigger').value.trim(),
    beforeLevel: document.getElementById('mfBefore').value,
    afterLevel: document.getElementById('mfAfter').value,
    method: document.getElementById('mfMethod').value.trim(),
    note: document.getElementById('mfNote').value.trim()
  };
  try {
    var r = await fetch('/api/mindfulness', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openMindfulness(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delMindfulness(id){
  if (!confirm('删除这条训练记录？')) return;
  try { await fetch('/api/mindfulness/'+id, { method:'DELETE' }); openMindfulness(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 4. 能量审计 ----
async function openEnergy(){
  openModal2('⚡ 能量审计', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r1 = await fetch('/api/energy'); var list = await r1.json();
    var r2 = await fetch('/api/energy/audit'); var audit = await r2.json();
    var html = '';
    if (audit && audit.interpretation) {
      var netColor = audit.net > 0 ? '#22C55E' : audit.net < 0 ? '#EF4444' : '#94A3B8';
      html += '<div style="background:rgba(245,158,11,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border-left:3px solid '+netColor+'">';
      html += '<div style="font-size:12px;color:#FBBF24;margin-bottom:6px">📊 本周能量报表</div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center;margin-bottom:8px"><div><div style="font-size:11px;color:#EF4444">消耗</div><div style="font-size:18px;color:#EF4444;font-weight:700">'+audit.totalDrain+'</div></div><div><div style="font-size:11px;color:#22C55E">充能</div><div style="font-size:18px;color:#22C55E;font-weight:700">'+audit.totalGain+'</div></div><div><div style="font-size:11px;color:var(--c-fg-2)">净</div><div style="font-size:18px;color:'+netColor+';font-weight:700">'+(audit.net>=0?'+':'')+audit.net+'</div></div></div>';
      html += '<div style="font-size:12px;color:var(--c-fg);line-height:1.6;white-space:pre-wrap">'+escapeHtml(audit.interpretation)+'</div>';
      html += '</div>';
    }
    html += '<div style="background:rgba(245,158,11,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid rgba(245,158,11,0.15)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 记录能量</div>';
    html += '<label style="font-size:11px;color:var(--c-fg-2)">类型</label>';
    html += '<select id="egType" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<option value="drain">消耗（让我累）</option>';
    html += '<option value="gain">充能（让我有力）</option>';
    html += '</select>';
    html += '<input id="egSource" placeholder="来源（如：刷短视频/深度对话/运动）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<label style="font-size:11px;color:var(--c-fg-2)">强度(1-10)</label>';
    html += '<input id="egAmount" type="number" min="1" max="10" value="5" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<textarea id="egNote" placeholder="备注（可选）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:40px;resize:vertical;margin-bottom:8px"></textarea>';
    html += '<button onclick="saveEnergy()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#F59E0B,#FBBF24);color:#fff;font-weight:600;cursor:pointer">记录</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有能量记录。<br>看不见的能量，管不住。<br>记录一周，你会看清自己的能量黑洞和能量源泉。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">最近 '+list.length+' 条</div>';
      list.slice(0, 15).forEach(function(e){
        var color = e.type === 'drain' ? '#EF4444' : '#22C55E';
        var icon = e.type === 'drain' ? '🔴' : '🟢';
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:8px 12px;margin-bottom:4px;border-left:3px solid '+color+'">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:12px;color:var(--c-fg)">'+icon+' '+escapeHtml(e.source)+'</span><span style="font-size:11px;color:'+color+';font-weight:600">'+(e.type==='drain'?'-':'+')+e.amount+'</span></div>';
        if (e.note) html += '<div style="font-size:11px;color:var(--c-fg-2);margin-top:2px">'+escapeHtml(e.note)+'</div>';
        html += '<div style="font-size:10px;color:var(--c-fg-3)">'+e.date+'</div>';
        html += '</div>';
      });
    }
    openModal2('⚡ 能量审计', html);
  } catch(e) { openModal2('⚡ 能量审计', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveEnergy(){
  var data = {
    type: document.getElementById('egType').value,
    source: document.getElementById('egSource').value.trim(),
    amount: document.getElementById('egAmount').value,
    note: document.getElementById('egNote').value.trim()
  };
  if (!data.source) { alert('请填写能量来源'); return; }
  try {
    var r = await fetch('/api/energy', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openEnergy(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delEnergy(id){
  if (!confirm('删除这条能量记录？')) return;
  try { await fetch('/api/energy/'+id, { method:'DELETE' }); openEnergy(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 5. 周月复盘 ----
async function openReview(){
  openModal2('📅 周/月复盘', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r1 = await fetch('/api/reviews'); var list = await r1.json();
    var r2 = await fetch('/api/review/auto?period=week'); var autoWeek = await r2.json();
    var r3 = await fetch('/api/review/auto?period=month'); var autoMonth = await r3.json();

    var html = '<div style="background:var(--c-accent);border-radius:10px;padding:12px;margin-bottom:10px;border-left:3px solid var(--c-primary)">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:13px;font-weight:600;color:var(--c-fg)">🤖 本周自动复盘</span><span style="font-size:10px;color:var(--c-fg-3)">'+autoWeek.range+'</span></div>';
    html += '<div style="font-size:12px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap;margin-bottom:6px">'+escapeHtml(autoWeek.summary)+'</div>';
    if (autoWeek.suggestions && autoWeek.suggestions.length) {
      html += '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #F3F4F6">';
      autoWeek.suggestions.forEach(function(s){ html += '<div style="font-size:11px;color:#FBBF24;padding:2px 0">⚠️ '+escapeHtml(s)+'</div>'; });
      html += '</div>';
    }
    html += '</div>';

    html += '<div style="background:rgba(59,130,246,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border-left:3px solid #3B82F6">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:13px;font-weight:600;color:var(--c-fg)">🤖 本月自动复盘</span><span style="font-size:10px;color:var(--c-fg-3)">'+autoMonth.range+'</span></div>';
    html += '<div style="font-size:12px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap">'+escapeHtml(autoMonth.summary)+'</div>';
    html += '</div>';

    html += '<div style="background:var(--c-accent);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid var(--c-border)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 写一条自己的复盘</div>';
    html += '<select id="rvPeriod" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px"><option value="week">本周</option><option value="month">本月</option></select>';
    html += '<textarea id="rvContent" placeholder="这周/月你最重要的反思是什么？" style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:60px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<input id="rvHighlights" placeholder="亮点（可选）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<input id="rvRegrets" placeholder="遗憾（可选）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<input id="rvNextActions" placeholder="下周/月要做什么" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:8px">';
    html += '<button onclick="saveReview()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary),var(--c-primary-2));color:#fff;font-weight:600;cursor:pointer">保存复盘</button>';
    html += '</div>';

    if (list.length > 0) {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">历史复盘 '+list.length+' 条</div>';
      list.forEach(function(rv){
        var pLabel = rv.period === 'month' ? '月度' : '周度';
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid var(--c-primary)">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:11px;color:var(--c-primary)">'+pLabel+'复盘</span><span style="font-size:10px;color:var(--c-fg-3)">'+rv.date+'</span></div>';
        html += '<div style="font-size:12px;color:var(--c-fg);margin-top:4px;line-height:1.6">'+escapeHtml(rv.content)+'</div>';
        if (rv.highlights) html += '<div style="font-size:11px;color:#22C55E;margin-top:4px">✨ '+escapeHtml(rv.highlights)+'</div>';
        if (rv.regrets) html += '<div style="font-size:11px;color:#EF4444;margin-top:2px">💭 '+escapeHtml(rv.regrets)+'</div>';
        if (rv.nextActions) html += '<div style="font-size:11px;color:#FBBF24;margin-top:2px">→ '+escapeHtml(rv.nextActions)+'</div>';
        html += '<div style="margin-top:6px"><button onclick="delReview(\''+rv.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button></div>';
        html += '</div>';
      });
    }
    openModal2('📅 周/月复盘（'+list.length+'）', html);
  } catch(e) { openModal2('📅 周/月复盘', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveReview(){
  var data = {
    period: document.getElementById('rvPeriod').value,
    content: document.getElementById('rvContent').value.trim(),
    highlights: document.getElementById('rvHighlights').value.trim(),
    regrets: document.getElementById('rvRegrets').value.trim(),
    nextActions: document.getElementById('rvNextActions').value.trim()
  };
  if (!data.content) { alert('请写下你的反思'); return; }
  try {
    var r = await fetch('/api/reviews', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openReview(); loadCognitiveCounts(); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delReview(id){
  if (!confirm('删除这条复盘？')) return;
  try { await fetch('/api/reviews/'+id, { method:'DELETE' }); openReview(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ============================================================
// Phase 3：成长轴 - 5个功能弹窗
// ============================================================

// ---- 1. 信念追踪 ----
async function openBeliefs(){
  openModal2('💎 信念追踪', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/beliefs'); var list = await r.json();
    var html = '<div style="background:rgba(139,92,246,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid rgba(139,92,246,0.15)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 记录一条信念</div>';
    html += '<textarea id="blBelief" placeholder="你坚信的事，如：努力会有回报 / 人性本善 / 我能掌控自己" style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:50px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<input id="blSource" placeholder="来源（自己验证/父母教的/书上看的/创伤形成的）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px"><div><label style="font-size:11px;color:var(--c-fg-2)">信心(1-5)</label><input id="blConfidence" type="number" min="1" max="5" value="3" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"></div><div><label style="font-size:11px;color:var(--c-fg-2)">分类</label><select id="blCategory" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"><option>人生</option><option>金钱</option><option>关系</option><option>工作</option><option>自己</option></select></div></div>';
    html += '<button onclick="saveBelief()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary-2),#F472B6);color:#fff;font-weight:600;cursor:pointer">记录信念</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有信念记录。<br>信念是人生的操作系统——你所有的决策都基于它。<br>但很多信念你从没验证过，只是"以为"它对。<br>记录下来，定期让现实打脸。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">共 '+list.length+' 条信念</div>';
      list.forEach(function(b){
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid var(--c-primary-2)">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:11px;color:var(--c-fg-2)">'+b.category+' · 信心'+b.confidence+'/5</span><span style="font-size:10px;color:var(--c-fg-3)">'+b.date+'</span></div>';
        html += '<div style="font-size:13px;color:var(--c-fg);margin-top:4px;font-weight:500">'+escapeHtml(b.belief)+'</div>';
        if (b.source) html += '<div style="font-size:11px;color:var(--c-fg-2);margin-top:2px">来源：'+escapeHtml(b.source)+'</div>';
        if (b.tested > 0) html += '<div style="font-size:11px;color:var(--c-primary);margin-top:4px">已检验'+b.tested+'次 · 成立'+b.heldUp+' · 被打破'+b.broken+'</div>';
        html += '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">';
        html += '<button onclick="testBelief(\''+b.id+'\',\'held\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(34,197,94,0.3);border-radius:8px;background:rgba(34,197,94,0.06);color:#22C55E;cursor:pointer">✓ 成立</button>';
        html += '<button onclick="testBelief(\''+b.id+'\',\'broken\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.3);border-radius:8px;background:rgba(239,68,68,0.06);color:#EF4444;cursor:pointer">✗ 打破</button>';
        html += '<button onclick="delBelief(\''+b.id+'\')" style="font-size:11px;padding:4px 10px;border-radius:8px;background:transparent;color:var(--c-fg-2);cursor:pointer">删除</button>';
        html += '</div></div>';
      });
    }
    openModal2('💎 信念追踪（'+list.length+'）', html);
  } catch(e) { openModal2('💎 信念追踪', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveBelief(){
  var data = {
    belief: document.getElementById('blBelief').value.trim(),
    source: document.getElementById('blSource').value.trim(),
    confidence: document.getElementById('blConfidence').value,
    category: document.getElementById('blCategory').value
  };
  if (!data.belief) { alert('请写下你的信念'); return; }
  try {
    var r = await fetch('/api/beliefs', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openBeliefs(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function testBelief(id, result){
  var note = prompt(result === 'held' ? '什么事件验证了它？' : '什么事件打破了它？简述');
  if (note === null) return;
  try {
    var r = await fetch('/api/beliefs/'+id+'/test', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({result:result, note:note}) });
    var d = await r.json();
    openBeliefs();
    if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection});
  } catch(e) { alert('网络错误'); }
}

async function delBelief(id){
  if (!confirm('删除这条信念？')) return;
  try { await fetch('/api/beliefs/'+id, { method:'DELETE' }); openBeliefs(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 2. 品格雷达 ----
async function openCharacter(){
  openModal2('🎯 品格雷达', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r1 = await fetch('/api/character/radar'); var radar = await r1.json();
    var r2 = await fetch('/api/character'); var list = await r2.json();
    var html = '';
    if (radar.interpretation) {
      html += '<div style="background:rgba(168,85,247,0.08);border-radius:10px;padding:12px;margin-bottom:14px;border-left:3px solid var(--c-primary-2)">';
      html += '<div style="font-size:12px;color:var(--c-primary-2);margin-bottom:6px">📊 品格演化</div>';
      html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.6;white-space:pre-wrap">'+escapeHtml(radar.interpretation)+'</div>';
      html += '</div>';
    }
    html += '<div style="background:rgba(168,85,247,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid rgba(168,85,247,0.15)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 新自评（0-10）</div>';
    var dims = [['honesty','诚实'],['courage','勇气'],['resilience','韧性'],['restraint','克制'],['responsibility','担当'],['altruism','利他']];
    dims.forEach(function(d){
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:13px;color:var(--c-fg);width:50px">'+d[1]+'</span><input id="ch_'+d[0]+'" type="range" min="0" max="10" value="5" style="flex:1" oninput="document.getElementById(\'ch_'+d[0]+'_v\').textContent=this.value"><span id="ch_'+d[0]+'_v" style="font-size:13px;color:var(--c-primary-2);width:24px;text-align:right">5</span></div>';
    });
    html += '<textarea id="chNote" placeholder="为什么这次这么评？（可选）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:40px;resize:vertical;margin-bottom:8px"></textarea>';
    html += '<button onclick="saveCharacter()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary-2),#C084FC);color:#fff;font-weight:600;cursor:pointer">保存自评</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有品格记录。<br>诚实是所有品格的基石——先诚实，再谈其他。<br>每月自评一次，看自己的演化轨迹。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">历史 '+list.length+' 份</div>';
      list.slice(0, 6).forEach(function(c){
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid var(--c-primary-2)">';
        html += '<div style="font-size:11px;color:var(--c-fg-3)">'+c.date+'</div>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:6px;font-size:11px">';
        dims.forEach(function(d){ html += '<div style="color:var(--c-fg-2)">'+d[1]+'：<span style="color:var(--c-fg);font-weight:600">'+c[d[0]]+'</span></div>'; });
        html += '</div>';
        if (c.note) html += '<div style="font-size:11px;color:var(--c-primary-2);margin-top:4px;padding:4px 8px;background:rgba(168,85,247,0.06);border-radius:6px">📝 '+escapeHtml(c.note)+'</div>';
        html += '<div style="margin-top:6px"><button onclick="delCharacter(\''+c.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button></div>';
        html += '</div>';
      });
    }
    openModal2('🎯 品格雷达', html);
  } catch(e) { openModal2('🎯 品格雷达', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveCharacter(){
  var data = {
    honesty: document.getElementById('ch_honesty').value,
    courage: document.getElementById('ch_courage').value,
    resilience: document.getElementById('ch_resilience').value,
    restraint: document.getElementById('ch_restraint').value,
    responsibility: document.getElementById('ch_responsibility').value,
    altruism: document.getElementById('ch_altruism').value,
    note: document.getElementById('chNote').value.trim()
  };
  try {
    var r = await fetch('/api/character', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openCharacter(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delCharacter(id){
  if (!confirm('删除这份自评？')) return;
  try { await fetch('/api/character/'+id, { method:'DELETE' }); openCharacter(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 3. 自我画像 ----
async function openSelfPortrait(){
  openModal2('🪞 自我画像', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/self-portrait'); var list = await r.json();
    var html = '<div style="background:linear-gradient(135deg,rgba(139,92,246,0.1),rgba(168,85,247,0.06));border-radius:12px;padding:14px;margin-bottom:14px;border:1px solid rgba(139,92,246,0.2);text-align:center">';
    html += '<button onclick="generatePortrait()" style="padding:10px 24px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary-2),var(--c-primary-2));color:#fff;font-weight:600;cursor:pointer">🪞 生成当前画像</button>';
    html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:6px">基于你所有记录，系统会画出"你是谁"</div>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有画像。<br>画像不是你想成为谁，是你实际是谁。<br>基于你的记录，系统会诚实地告诉你答案。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">历史画像 '+list.length+' 份（最多保留12份）</div>';
      list.forEach(function(p){
        html += '<div style="background:var(--c-surface);border-radius:12px;padding:12px;margin-bottom:8px;border-left:3px solid var(--c-primary-2)">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:11px;color:var(--c-primary-2)">'+p.date+' 画像</span><span style="font-size:10px;color:var(--c-fg-3)">基于'+p.sampleSize+'条</span></div>';
        if (p.oneLine) html += '<div style="font-size:14px;color:var(--c-fg);font-weight:600;margin-top:6px">'+escapeHtml(p.oneLine)+'</div>';
        if (p.narrative) html += '<div style="font-size:12px;color:#4B5563;margin-top:6px;line-height:1.7;white-space:pre-wrap">'+escapeHtml(p.narrative)+'</div>';
        html += '<div style="margin-top:6px"><button onclick="delPortrait(\''+p.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button></div>';
        html += '</div>';
      });
    }
    openModal2('🪞 自我画像演化', html);
  } catch(e) { openModal2('🪞 自我画像', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function generatePortrait(){
  try {
    var r = await fetch('/api/self-portrait/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({}) });
    var d = await r.json();
    if (d.success) { openSelfPortrait(); loadCognitiveCounts(); if (d.item && d.item.narrative) showCognitiveFeedback({success:true, reflection:d.item.narrative}); }
    else alert(d.message || '生成失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delPortrait(id){
  if (!confirm('删除这份画像？')) return;
  try { await fetch('/api/self-portrait/'+id, { method:'DELETE' }); openSelfPortrait(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 4. 反熵增监控 ----
async function openEntropy(){
  openModal2('📉 反熵增监控', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r1 = await fetch('/api/entropy'); var monitor = await r1.json();
    var r2 = await fetch('/api/entropy/logs'); var logs = await r2.json();
    var scoreColor = monitor.entropyScore > 8 ? '#EF4444' : monitor.entropyScore > 4 ? '#F59E0B' : '#22C55E';
    var html = '<div style="background:rgba(245,158,11,0.08);border-radius:12px;padding:14px;margin-bottom:14px;border-left:3px solid '+scoreColor+'">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-size:13px;font-weight:600;color:var(--c-fg)">📊 当前熵增</span><span style="font-size:18px;font-weight:700;color:'+scoreColor+'">'+monitor.entropyScore+'</span></div>';
    html += '<div style="font-size:12px;color:var(--c-fg);line-height:1.6;white-space:pre-wrap">'+escapeHtml(monitor.interpretation)+'</div>';
    html += '</div>';
    if (monitor.signals && monitor.signals.length > 0) {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0 8px">⚠️ 信号 '+monitor.signals.length+' 条</div>';
      monitor.signals.forEach(function(s){
        var sc = s.severity === 'high' ? '#EF4444' : s.severity === 'med' ? '#F59E0B' : '#94A3B8';
        html += '<div style="background:var(--c-surface);border-radius:8px;padding:8px 10px;margin-bottom:4px;border-left:3px solid '+sc+'">';
        html += '<div style="font-size:12px;color:var(--c-fg)">'+escapeHtml(s.signal)+'</div>';
        if (s.suggestion) html += '<div style="font-size:11px;color:var(--c-fg-2);margin-top:2px">→ '+escapeHtml(s.suggestion)+'</div>';
        html += '</div>';
      });
    }
    html += '<div style="background:var(--c-surface);border-radius:10px;padding:12px;margin-top:10px;border:1px solid #FFFFFF">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:6px">📝 手动记录熵增信号</div>';
    html += '<select id="epDim" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px"><option>健康</option><option>关系</option><option>财务</option><option>工作</option><option>情绪</option><option>习惯</option></select>';
    html += '<input id="epSignal" placeholder="信号（如：连续3天没联系家人）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<select id="epSev" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px"><option value="low">轻度</option><option value="med" selected>中度</option><option value="high">严重</option></select>';
    html += '<button onclick="saveEntropyLog()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#F59E0B,#FBBF24);color:#fff;font-weight:600;cursor:pointer">记录信号</button>';
    html += '</div>';
    if (logs.length > 0) {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:10px 0 6px">手动记录 '+logs.length+' 条</div>';
      logs.forEach(function(l){
        var sc = l.severity === 'high' ? '#EF4444' : l.severity === 'med' ? '#F59E0B' : '#94A3B8';
        html += '<div style="background:var(--c-surface);border-radius:8px;padding:8px 10px;margin-bottom:4px;border-left:3px solid '+(l.resolved?'#22C55E':sc)+'">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:11px;color:var(--c-fg-2)">'+l.dimension+'</span>'+(l.resolved?'<span style="font-size:10px;color:#22C55E">已处理</span>':'')+'</div>';
        html += '<div style="font-size:12px;color:var(--c-fg);margin-top:2px">'+escapeHtml(l.signal)+'</div>';
        if (l.note) html += '<div style="font-size:11px;color:var(--c-fg-2);margin-top:2px">'+escapeHtml(l.note)+'</div>';
        if (!l.resolved) html += '<button onclick="resolveEntropy(\''+l.id+'\')" style="font-size:10px;padding:3px 8px;border:1px solid rgba(34,197,94,0.3);border-radius:6px;background:rgba(34,197,94,0.06);color:#22C55E;cursor:pointer;margin-top:4px">标记已处理</button>';
        html += '</div>';
      });
    }
    openModal2('📉 反熵增监控', html);
  } catch(e) { openModal2('📉 反熵增监控', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveEntropyLog(){
  var data = {
    dimension: document.getElementById('epDim').value,
    signal: document.getElementById('epSignal').value.trim(),
    severity: document.getElementById('epSev').value
  };
  if (!data.signal) { alert('请填写信号'); return; }
  try {
    var r = await fetch('/api/entropy/log', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openEntropy(); loadCognitiveCounts(); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function resolveEntropy(id){
  try { await fetch('/api/entropy/log/'+id+'/resolve', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({}) }); openEntropy(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 5. 反脆弱缓冲评估 ----
async function openAntifragile(){
  openModal2('🛡️ 反脆弱评估', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r1 = await fetch('/api/antifragile'); var cur = await r1.json();
    var r2 = await fetch('/api/antifragile/logs'); var list = await r2.json();
    var html = '';
    if (cur && cur.interpretation) {
      html += '<div style="background:rgba(34,197,94,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border-left:3px solid #22C55E">';
      html += '<div style="font-size:12px;color:#22C55E;margin-bottom:6px">📊 当前评估</div>';
      html += '<div style="font-size:13px;color:var(--c-fg);line-height:1.6;white-space:pre-wrap">'+escapeHtml(cur.interpretation)+'</div>';
      html += '</div>';
    }
    html += '<div style="background:rgba(34,197,94,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid rgba(34,197,94,0.15)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 新评估（0-10）</div>';
    var dims = [['financial','💰 财务缓冲','存6个月生活费前不算自由'],['skill','🎯 技能冗余','只会一件事是单点故障'],['social','👥 关系网络','深交3人胜过认识100人'],['health','💪 身体储备','健康归零一切归零'],['mental','🧠 心智韧性','遭遇挫折的反弹力']];
    dims.forEach(function(d){
      html += '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;color:var(--c-fg)">'+d[1]+'</span><span id="af_'+d[0]+'_v" style="font-size:13px;color:#22C55E;font-weight:600">5</span></div><input id="af_'+d[0]+'" type="range" min="0" max="10" value="5" style="width:100%" oninput="document.getElementById(\'af_'+d[0]+'_v\').textContent=this.value"></div>';
      html += '<div style="font-size:10px;color:var(--c-fg-3);margin-bottom:4px">'+d[2]+'</div>';
    });
    html += '<textarea id="afNote" placeholder="备注（可选）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:40px;resize:vertical;margin-bottom:8px"></textarea>';
    html += '<button onclick="saveAntifragile()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#22C55E,#34D399);color:#fff;font-weight:600;cursor:pointer">保存评估</button>';
    html += '</div>';
    if (list.length > 0) {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">历史 '+list.length+' 份</div>';
      list.slice(0, 5).forEach(function(a){
        var total = a.financial + a.skill + a.social + a.health + a.mental;
        var avg = (total/5).toFixed(1);
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid #22C55E">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:11px;color:var(--c-fg-3)">'+a.date+'</span><span style="font-size:13px;color:#22C55E;font-weight:600">均'+avg+'</span></div>';
        html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr;gap:4px;margin-top:6px;font-size:10px;text-align:center">';
        html += '<div><div style="color:var(--c-fg-3)">财务</div><div style="color:var(--c-fg)">'+a.financial+'</div></div>';
        html += '<div><div style="color:var(--c-fg-3)">技能</div><div style="color:var(--c-fg)">'+a.skill+'</div></div>';
        html += '<div><div style="color:var(--c-fg-3)">关系</div><div style="color:var(--c-fg)">'+a.social+'</div></div>';
        html += '<div><div style="color:var(--c-fg-3)">身体</div><div style="color:var(--c-fg)">'+a.health+'</div></div>';
        html += '<div><div style="color:var(--c-fg-3)">心智</div><div style="color:var(--c-fg)">'+a.mental+'</div></div>';
        html += '</div>';
        html += '</div>';
      });
    }
    openModal2('🛡️ 反脆弱缓冲评估', html);
  } catch(e) { openModal2('🛡️ 反脆弱评估', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveAntifragile(){
  var data = {
    financial: document.getElementById('af_financial').value,
    skill: document.getElementById('af_skill').value,
    social: document.getElementById('af_social').value,
    health: document.getElementById('af_health').value,
    mental: document.getElementById('af_mental').value,
    note: document.getElementById('afNote').value.trim()
  };
  try {
    var r = await fetch('/api/antifragile', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openAntifragile(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

// ============================================================
// Phase 4：船长工具 - 5个功能弹窗
// ============================================================

// ---- 1. 北极星 ----
async function openNorthStar(){
  openModal2('⭐ 北极星坐标系', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/north-star'); var data = (await r.json())[0];
    var html = '<div style="background:linear-gradient(135deg,rgba(245,158,11,0.1),rgba(239,68,68,0.06));border-radius:12px;padding:14px;margin-bottom:14px;border:1px solid rgba(245,158,11,0.2)">';
    html += '<div style="font-size:12px;color:#F59E0B;margin-bottom:10px">🧭 你的坐标系</div>';
    html += '<label style="font-size:11px;color:#F59E0B;font-weight:600">⭐ 终局（你想活成什么样）</label>';
    html += '<textarea id="nsUltimate" placeholder="如：一个自由、有爱、有创造力的人" style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:50px;resize:vertical;margin:4px 0 8px">'+escapeHtml(data ? data.ultimate || '' : '')+'</textarea>';
    html += '<label style="font-size:11px;color:#F59E0B">5年目标</label>';
    html += '<input id="nsFiveYear" placeholder="5年后要成为什么" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin:4px 0 8px" value="'+escapeHtml(data ? data.fiveYear || '' : '')+'">';
    html += '<label style="font-size:11px;color:#F59E0B">1年目标</label>';
    html += '<input id="nsOneYear" placeholder="今年要达成什么" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin:4px 0 8px" value="'+escapeHtml(data ? data.oneYear || '' : '')+'">';
    html += '<label style="font-size:11px;color:#F59E0B">本季度</label>';
    html += '<input id="nsQuarter" placeholder="这3个月做什么" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin:4px 0 8px" value="'+escapeHtml(data ? data.thisQuarter || '' : '')+'">';
    html += '<label style="font-size:11px;color:#F59E0B">本周</label>';
    html += '<input id="nsWeek" placeholder="这周做什么" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin:4px 0 8px" value="'+escapeHtml(data ? data.thisWeek || '' : '')+'">';
    html += '<label style="font-size:11px;color:#F59E0B">今天</label>';
    html += '<input id="nsToday" placeholder="今天做什么让终局近1%" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin:4px 0 8px" value="'+escapeHtml(data ? data.today || '' : '')+'">';
    html += '<button onclick="saveNorthStar()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#F59E0B,#FBBF24);color:#fff;font-weight:600;cursor:pointer">保存坐标系</button>';
    html += '</div>';
    if (!data || !data.ultimate) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:16px;font-size:13px;line-height:1.6">没有终局，所有努力都是漂移。<br>写下你的北极星——所有日常记录都将对齐它。</div>';
    }
    openModal2('⭐ 北极星坐标系', html);
  } catch(e) { openModal2('⭐ 北极星', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveNorthStar(){
  var data = {
    ultimate: document.getElementById('nsUltimate').value.trim(),
    fiveYear: document.getElementById('nsFiveYear').value.trim(),
    oneYear: document.getElementById('nsOneYear').value.trim(),
    thisQuarter: document.getElementById('nsQuarter').value.trim(),
    thisWeek: document.getElementById('nsWeek').value.trim(),
    today: document.getElementById('nsToday').value.trim()
  };
  try {
    var r = await fetch('/api/north-star', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openNorthStar(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

// ---- 2. 危机预案 ----
async function openCrisisPlan(){
  openModal2('🚨 危机预案', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/crisis-plan'); var list = await r.json();
    var html = '<div style="background:rgba(239,68,68,0.06);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid rgba(239,68,68,0.15)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">📝 新危机预案</div>';
    html += '<input id="cpScenario" placeholder="危机场景（如：失业/生病/分手）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px"><select id="cpProb" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"><option value="low">低概率</option><option value="med" selected>中概率</option><option value="high">高概率</option></select><select id="cpImpact" style="padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px"><option value="low">轻度</option><option value="med">中度</option><option value="high" selected>严重</option><option value="critical">致命</option></select></div>';
    html += '<input id="cpPrecondition" placeholder="前置信号（如：连续3个月入不敷出）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px">';
    html += '<textarea id="cpImmediate" placeholder="立即行动（头24小时做什么）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:50px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<textarea id="cpThreeDay" placeholder="3天计划（止血、稳住）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:50px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<textarea id="cpRecovery" placeholder="恢复计划（长期）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:50px;resize:vertical;margin-bottom:8px"></textarea>';
    html += '<button onclick="saveCrisisPlan()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#EF4444,#F87171);color:#fff;font-weight:600;cursor:pointer">保存预案</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有危机预案。<br>危机来时，人会因为恐慌而冻结——预案的意义，是不用临时决策。<br>预想3-5个最可能的危机，写下应对剧本。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">共 '+list.length+' 个预案</div>';
      list.forEach(function(c){
        var pColor = c.probability === 'high' ? '#EF4444' : c.probability === 'med' ? '#F59E0B' : '#94A3B8';
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid '+pColor+'">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;color:var(--c-fg);font-weight:600">'+escapeHtml(c.scenario)+'</span>'+(c.rehearsed?'<span style="font-size:10px;color:#22C55E">已演练</span>':'')+'</div>';
        html += '<div style="font-size:11px;color:'+pColor+';margin-top:4px">概率'+c.probability+' · 影响'+c.impact+'</div>';
        if (c.immediateAction) html += '<div style="font-size:11px;color:#4B5563;margin-top:4px"><b>立即：</b>'+escapeHtml(c.immediateAction)+'</div>';
        if (c.threeDayPlan) html += '<div style="font-size:11px;color:#4B5563;margin-top:2px"><b>3天：</b>'+escapeHtml(c.threeDayPlan)+'</div>';
        if (c.recoveryPlan) html += '<div style="font-size:11px;color:#4B5563;margin-top:2px"><b>恢复：</b>'+escapeHtml(c.recoveryPlan)+'</div>';
        html += '<div style="display:flex;gap:6px;margin-top:6px">';
        if (!c.rehearsed) html += '<button onclick="rehearseCrisis(\''+c.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(245,158,11,0.3);border-radius:8px;background:rgba(245,158,11,0.06);color:#F59E0B;cursor:pointer">演练</button>';
        html += '<button onclick="delCrisisPlan(\''+c.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button>';
        html += '</div></div>';
      });
    }
    openModal2('🚨 危机预案（'+list.length+'）', html);
  } catch(e) { openModal2('🚨 危机预案', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveCrisisPlan(){
  var data = {
    scenario: document.getElementById('cpScenario').value.trim(),
    probability: document.getElementById('cpProb').value,
    impact: document.getElementById('cpImpact').value,
    precondition: document.getElementById('cpPrecondition').value.trim(),
    immediateAction: document.getElementById('cpImmediate').value.trim(),
    threeDayPlan: document.getElementById('cpThreeDay').value.trim(),
    recoveryPlan: document.getElementById('cpRecovery').value.trim()
  };
  if (!data.scenario) { alert('请填写危机场景'); return; }
  try {
    var r = await fetch('/api/crisis-plan', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openCrisisPlan(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function rehearseCrisis(id){
  var note = prompt('演练结果如何？预案是否可执行？');
  if (note === null) return;
  try { await fetch('/api/crisis-plan/'+id+'/rehearse', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({note:note}) }); openCrisisPlan(); }
  catch(e) { alert('网络错误'); }
}

async function delCrisisPlan(id){
  if (!confirm('删除这个预案？')) return;
  try { await fetch('/api/crisis-plan/'+id, { method:'DELETE' }); openCrisisPlan(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 3. 临终测试 ----
async function openDeathTest(){
  openModal2('⚰️ 临终测试', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/death-test'); var list = await r.json();
    var html = '<div style="background:var(--c-accent);border-radius:10px;padding:14px;margin-bottom:14px;border:1px solid var(--c-border)">';
    html += '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">💭 假如今天就是终点</div>';
    html += '<textarea id="dtRegrets" placeholder="最大的遗憾是什么？" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:50px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<textarea id="dtUndone" placeholder="想做却没做的事" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:40px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<textarea id="dtProud" placeholder="让你骄傲的事" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:40px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<textarea id="dtChange" placeholder="如果重来，你会改变什么" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:40px;resize:vertical;margin-bottom:6px"></textarea>';
    html += '<input id="dtFocus" placeholder="由此刻起，最重要的一件事" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:8px">';
    html += '<button onclick="saveDeathTest()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary),#818CF8);color:#fff;font-weight:600;cursor:pointer">记录</button>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有临终测试记录。<br>这不是诅咒，是反向校准——\n站在终点看现在，很多事就不纠结了。</div>';
    } else {
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin:6px 0">历史 '+list.length+' 次</div>';
      list.forEach(function(d){
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-bottom:6px;border-left:3px solid var(--c-primary)">';
        html += '<div style="font-size:11px;color:var(--c-fg-3)">'+d.date+'</div>';
        if (d.regrets) html += '<div style="font-size:12px;color:#4B5563;margin-top:4px"><b style="color:#EF4444">遗憾：</b>'+escapeHtml(d.regrets)+'</div>';
        if (d.undone) html += '<div style="font-size:12px;color:#4B5563;margin-top:2px"><b style="color:#F59E0B">未做：</b>'+escapeHtml(d.undone)+'</div>';
        if (d.proudOf) html += '<div style="font-size:12px;color:#4B5563;margin-top:2px"><b style="color:#22C55E">骄傲：</b>'+escapeHtml(d.proudOf)+'</div>';
        if (d.focus) html += '<div style="font-size:12px;color:var(--c-primary);margin-top:4px;padding:4px 8px;background:var(--c-accent);border-radius:6px">→ '+escapeHtml(d.focus)+'</div>';
        html += '<div style="margin-top:6px"><button onclick="delDeathTest(\''+d.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button></div>';
        html += '</div>';
      });
    }
    openModal2('⚰️ 临终测试（'+list.length+'）', html);
  } catch(e) { openModal2('⚰️ 临终测试', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveDeathTest(){
  var data = {
    regrets: document.getElementById('dtRegrets').value.trim(),
    undone: document.getElementById('dtUndone').value.trim(),
    proudOf: document.getElementById('dtProud').value.trim(),
    wouldChange: document.getElementById('dtChange').value.trim(),
    focus: document.getElementById('dtFocus').value.trim()
  };
  try {
    var r = await fetch('/api/death-test', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openDeathTest(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delDeathTest(id){
  if (!confirm('删除这条记录？')) return;
  try { await fetch('/api/death-test/'+id, { method:'DELETE' }); openDeathTest(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 4. 年度叙事 ----
async function openNarrative(){
  openModal2('📖 年度叙事', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/narrative'); var list = await r.json();
    var curYear = new Date().getFullYear();
    var html = '<div style="background:linear-gradient(135deg,rgba(245,158,11,0.1),rgba(139,92,246,0.06));border-radius:12px;padding:14px;margin-bottom:14px;border:1px solid rgba(245,158,11,0.2);text-align:center">';
    html += '<div style="font-size:13px;color:var(--c-fg);margin-bottom:8px">生成 '+curYear+' 年的故事</div>';
    html += '<button onclick="generateNarrative('+curYear+')" style="padding:10px 24px;border:none;border-radius:10px;background:linear-gradient(135deg,#F59E0B,var(--c-primary-2));color:#fff;font-weight:600;cursor:pointer">📖 生成年度叙事</button>';
    html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:6px">基于你的所有记录，系统会写出"你这一年活成了什么"</div>';
    html += '</div>';
    if (list.length === 0) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有年度叙事。<br>记录不是终点——这些数据要变成故事，变成判断力。</div>';
    } else {
      list.forEach(function(n){
        html += '<div style="background:var(--c-surface);border-radius:12px;padding:14px;margin-bottom:8px;border-left:3px solid #F59E0B">';
        html += '<div style="font-size:14px;color:#F59E0B;font-weight:600;margin-bottom:8px">📖 '+n.year+' 年叙事</div>';
        if (n.story) html += '<div style="font-size:12px;color:var(--c-fg);line-height:1.8;white-space:pre-wrap">'+escapeHtml(n.story)+'</div>';
        if (n.conclusion) html += '<div style="font-size:12px;color:var(--c-primary-2);margin-top:10px;padding:8px 10px;background:rgba(139,92,246,0.06);border-radius:6px;white-space:pre-wrap">'+escapeHtml(n.conclusion)+'</div>';
        html += '<div style="margin-top:8px"><button onclick="delNarrative(\''+n.id+'\')" style="font-size:11px;padding:4px 10px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:transparent;color:#EF4444;cursor:pointer">删除</button></div>';
        html += '</div>';
      });
    }
    openModal2('📖 年度叙事', html);
  } catch(e) { openModal2('📖 年度叙事', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function generateNarrative(year){
  try {
    var r = await fetch('/api/narrative/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({year:year}) });
    var d = await r.json();
    if (d.success) { openNarrative(); loadCognitiveCounts(); if (d.item && d.item.story) showCognitiveFeedback({success:true, reflection:d.item.story + '\n\n' + d.item.conclusion}); }
    else alert(d.message || '生成失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

async function delNarrative(id){
  if (!confirm('删除这份叙事？')) return;
  try { await fetch('/api/narrative/'+id, { method:'DELETE' }); openNarrative(); loadCognitiveCounts(); }
  catch(e) { alert('网络错误'); }
}

// ---- 5. 船长宣言 ----
async function openManifesto(){
  openModal2('📜 船长宣言', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/manifesto'); var data = (await r.json())[0];
    var html = '<div style="background:linear-gradient(135deg,rgba(245,158,11,0.1),rgba(239,68,68,0.06));border-radius:12px;padding:14px;margin-bottom:14px;border:1px solid rgba(245,158,11,0.2)">';
    html += '<div style="font-size:12px;color:#F59E0B;margin-bottom:8px">📜 你给自己的契约</div>';
    html += '<input id="mfTitle" placeholder="标题（如：我的船长宣言）" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;margin-bottom:6px" value="'+escapeHtml(data ? data.title || '' : '')+'">';
    html += '<textarea id="mfBody" placeholder="写下你对自己的承诺——必须包含你愿意付出的代价。\n如：我承诺做一个诚实的人，即使诚实会让我失去机会。\n我承诺照顾身体，即使这意味着放弃一些享乐。\n..." style="width:100%;padding:10px;border-radius:8px;border:1px solid #F5F7FA;background:var(--c-surface);color:var(--c-fg);font-size:13px;font-family:inherit;min-height:120px;resize:vertical;margin-bottom:8px">'+escapeHtml(data ? data.body || '' : '')+'</textarea>';
    html += '<button onclick="saveManifesto()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#F59E0B,#EF4444);color:#fff;font-weight:600;cursor:pointer">'+(data ? '更新宣言' : '签订宣言')+'</button>';
    html += '</div>';
    if (!data) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px;line-height:1.6">还没有宣言。<br>宣言不是口号，是契约——\n写下你愿意为什么付出代价，那才是真宣言。</div>';
    } else {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:10px;font-size:11px">签订于 '+new Date(data.signedAt).toLocaleString('zh-CN')+'</div>';
    }
    openModal2('📜 船长宣言', html);
  } catch(e) { openModal2('📜 船长宣言', '<div style="color:#EF4444;padding:20px">加载失败：'+e.message+'</div>'); }
}

async function saveManifesto(){
  var data = {
    title: document.getElementById('mfTitle').value.trim(),
    body: document.getElementById('mfBody').value.trim()
  };
  if (!data.body) { alert('请写下你的宣言'); return; }
  try {
    var r = await fetch('/api/manifesto', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    var d = await r.json();
    if (d.success) { openManifesto(); loadCognitiveCounts(); if (d.reflection) showCognitiveFeedback({success:true, reflection:d.reflection}); }
    else alert(d.message || '保存失败');
  } catch(e) { alert('网络错误：'+e.message); }
}

// ---- 首页计数 + 今日反馈 ----
async function loadCognitiveCounts(){
  try {
    var r = await fetch('/api/cognitive-counts');
    var d = await r.json();
    var pe = document.getElementById('principleCount'); if (pe) pe.textContent = (d.principles||0) + ' \u6761';
    var de = document.getElementById('decisionCount'); if (de) de.textContent = (d.decisions||0) + ' \u6761';
    var r1e = document.getElementById('rootCauseCount'); if (r1e) r1e.textContent = (d.rootCause||0) + ' \u6761';
    var r2e = document.getElementById('interpersonalCount'); if (r2e) r2e.textContent = (d.interpersonal||0) + ' \u6761';
    var r3e = document.getElementById('mindfulnessCount'); if (r3e) r3e.textContent = (d.mindfulness||0) + ' \u6b21';
    var r4e = document.getElementById('energyNet'); if (r4e) r4e.textContent = '\u51c0 ' + (d.energyNet != null ? d.energyNet : 0);
    var r5e = document.getElementById('reviewCount'); if (r5e) r5e.textContent = (d.reviews||0) + ' \u6761';
    var b1e = document.getElementById('beliefCount'); if (b1e) b1e.textContent = (d.beliefs||0) + ' \u6761';
    var b2e = document.getElementById('characterCount'); if (b2e) b2e.textContent = (d.character||0) + ' \u4efd';
    var b3e = document.getElementById('portraitCount'); if (b3e) b3e.textContent = (d.selfPortrait||0) + ' \u4efd';
    var b4e = document.getElementById('entropyScore'); if (b4e) b4e.textContent = '\u71b5 ' + (d.entropyScore != null ? d.entropyScore : 0);
    var b5e = document.getElementById('antifragileAvg'); if (b5e) b5e.textContent = d.antifragileAvg != null ? '\u5747' + Number(d.antifragileAvg).toFixed(1) : '-';
    var c1e = document.getElementById('northStarStatus'); if (c1e) c1e.textContent = d.northStar || '\u672a\u8bbe';
    var c2e = document.getElementById('crisisCount'); if (c2e) c2e.textContent = (d.crisis||0) + ' \u4e2a';
    var c3e = document.getElementById('deathTestCount'); if (c3e) c3e.textContent = (d.deathTest||0) + ' \u6b21';
    var c4e = document.getElementById('narrativeCount'); if (c4e) c4e.textContent = (d.narrative||0) + ' \u4efd';
    var c5e = document.getElementById('manifestoStatus'); if (c5e) c5e.textContent = d.manifesto || '\u672a\u7acb';
    var d1e = document.getElementById('metacogScore'); if (d1e) d1e.textContent = d.metacog && d.metacog.score != null ? d.metacog.score + '/10' : '-';
    var d2e = document.getElementById('biasScore'); if (d2e) d2e.textContent = d.bias && d.bias.score != null ? d.bias.score + '\u504f\u5dee' : '-';
    var d3e = document.getElementById('trajStatus'); if (d3e) d3e.textContent = d.trajectory && d.trajectory.trend ? d.trajectory.trend : '-';
    var d4e = document.getElementById('alignScore'); if (d4e) d4e.textContent = d.values && d.values.alignment != null ? d.values.alignment + '/10' : '-';
    var d5e = document.getElementById('antiScore'); if (d5e) d5e.textContent = d.antiHuman && d.antiHuman.score != null ? d.antiHuman.score + '/10' : '-';
    var e1e = document.getElementById('healthTrendCnt'); if (e1e) e1e.textContent = d.healthTrendCnt != null ? d.healthTrendCnt + '\u70b9' : '-';
    var e2e = document.getElementById('planCnt'); if (e2e) e2e.textContent = (d.plan||0) + ' \u4e2a';
    var e3e = document.getElementById('milestoneCnt'); if (e3e) e3e.textContent = (d.lifeMilestone||0) + ' \u4e2a';
    return;
  } catch(e) {}
  // --- 聚合接口失败：并发降级（块内 Promise.all，不再串行 ---
  try {
    var res = await Promise.all([fetch('/api/principles'), fetch('/api/decisions')]);
    var [p0,p1] = await Promise.all([res[0].json(), res[1].json()]);
    var pe = document.getElementById('principleCount'); if (pe) pe.textContent = p0.length + ' \u6761';
    var de = document.getElementById('decisionCount'); if (de) de.textContent = p1.length + ' \u6761';
  } catch(e) {}
  try {
    var res = await Promise.all([
      fetch('/api/root-cause'),fetch('/api/interpersonal'),fetch('/api/mindfulness'),fetch('/api/energy/audit'),fetch('/api/reviews')
    ]);
    var [rc,ip,mf,eg,rv] = await Promise.all(res.map(r=>r.json()));
    var r1e = document.getElementById('rootCauseCount'); if (r1e) r1e.textContent = rc.length + ' \u6761';
    var r2e = document.getElementById('interpersonalCount'); if (r2e) r2e.textContent = ip.length + ' \u6761';
    var r3e = document.getElementById('mindfulnessCount'); if (r3e) r3e.textContent = mf.length + ' \u6b21';
    var r4e = document.getElementById('energyNet'); if (r4e) r4e.textContent = '\u51c0 ' + (eg.net || 0);
    var r5e = document.getElementById('reviewCount'); if (r5e) r5e.textContent = rv.length + ' \u6761';
  } catch(e) {}
  try {
    var res = await Promise.all([
      fetch('/api/beliefs'),fetch('/api/character'),fetch('/api/self-portrait'),fetch('/api/entropy'),fetch('/api/antifragile')
    ]);
    var [bl,ch,sp,en,af] = await Promise.all(res.map(r=>r.json()));
    var b1e = document.getElementById('beliefCount'); if (b1e) b1e.textContent = bl.length + ' \u6761';
    var b2e = document.getElementById('characterCount'); if (b2e) b2e.textContent = ch.length + ' \u4efd';
    var b3e = document.getElementById('portraitCount'); if (b3e) b3e.textContent = sp.length + ' \u4efd';
    var b4e = document.getElementById('entropyScore'); if (b4e) b4e.textContent = '\u71b5 ' + (en.entropyScore || 0);
    var b5e = document.getElementById('antifragileAvg'); if (b5e) b5e.textContent = af && af.average ? '\u5747' + af.average.toFixed(1) : '-';
  } catch(e) {}
  try {
    var res = await Promise.all([
      fetch('/api/north-star'),fetch('/api/crisis-plan'),fetch('/api/death-test'),fetch('/api/narrative'),fetch('/api/manifesto')
    ]);
    var [ns,cp,dt,nr,mf2] = await Promise.all(res.map(r=>r.json()));
    var c1e = document.getElementById('northStarStatus'); if (c1e) c1e.textContent = ns.length && ns[0].ultimate ? '\u5df2\u8bbe' : '\u672a\u8bbe';
    var c2e = document.getElementById('crisisCount'); if (c2e) c2e.textContent = cp.length + ' \u4e2a';
    var c3e = document.getElementById('deathTestCount'); if (c3e) c3e.textContent = dt.length + ' \u6b21';
    var c4e = document.getElementById('narrativeCount'); if (c4e) c4e.textContent = nr.length + ' \u4efd';
    var c5e = document.getElementById('manifestoStatus'); if (c5e) c5e.textContent = mf2.length && mf2[0].body ? '\u5df2\u7acb' : '\u672a\u7acb';
  } catch(e) {}
  try {
    var res = await Promise.all([
      fetch('/api/eng/metacognition'),fetch('/api/eng/cognitive-bias'),fetch('/api/eng/trajectory?days=30'),fetch('/api/eng/values-clarification'),fetch('/api/eng/anti-human-nature')
    ]);
    var [mc,cb,tj,vc,ah] = await Promise.all(res.map(r=>r.json()));
    var d1e = document.getElementById('metacogScore'); if (d1e) d1e.textContent = mc.score ? mc.score + '/10' : '-';
    var d2e = document.getElementById('biasScore'); if (d2e) d2e.textContent = cb.score ? cb.score + '\u504f\u5dee' : '-';
    var d3e = document.getElementById('trajStatus'); if (d3e) d3e.textContent = tj.trend || '-';
    var d4e = document.getElementById('alignScore'); if (d4e) d4e.textContent = vc.alignment ? vc.alignment + '/10' : '-';
    var d5e = document.getElementById('antiScore'); if (d5e) d5e.textContent = ah.score ? ah.score + '/10' : '-';
  } catch(e) {}
  try {
    var res = await Promise.all([
      fetch('/api/health-trends?days=90'),fetch('/api/plan'),fetch('/api/life-milestone')
    ]);
    var [ht,pl,lm] = await Promise.all(res.map(r=>r.json()));
    var e1e = document.getElementById('healthTrendCnt');
    if (e1e) e1e.textContent = (ht.weight||[]).length + (ht.bloodPressure||[]).length > 0 ? ((ht.weight||[]).length + (ht.bloodPressure||[]).length) + '\u70b9' : '-';
    var e2e = document.getElementById('planCnt'); if (e2e) e2e.textContent = pl.length + ' \u4e2a';
    var e3e = document.getElementById('milestoneCnt'); if (e3e) e3e.textContent = lm.length + ' \u4e2a';
  } catch(e) {}
}

function showTodayReflection(text){
  var card = document.getElementById('todayReflectionCard');
  var txt = document.getElementById('todayReflectionText');
  if (text && card && txt) { txt.innerHTML = escapeHtml(text).replace(/\n/g, '<br>'); card.style.display = 'block'; }
}

// ---- 保存记录后的认知反馈弹窗 ----
function showCognitiveFeedback(res){
  if (!res || !res.success) return;
  var parts = [];
  // 预算超支提醒（仅财务场景）
  if(res.budget){
    var b = res.budget;
    var budgetAmount = parseFloat(b.budget) || 0;
    var spent = parseFloat(b.spent) || 0;
    var remaining = budgetAmount - spent;
    var over = b.over || remaining < 0;
    if(budgetAmount > 0){
      if(over){
        parts.push('<div style="background:rgba(239,68,68,0.08);border-radius:10px;padding:12px;margin-bottom:10px;border-left:3px solid #EF4444;"><div style="font-size:11px;color:#EF4444;margin-bottom:6px;font-weight:700;">⚠️ 预算超支提醒</div><div style="font-size:13px;color:var(--c-fg);line-height:1.6;">已用 <strong style="color:#EF4444;">¥'+spent.toFixed(2)+'</strong> / 预算 ¥'+budgetAmount.toFixed(2)+'<br><span style="color:#EF4444;font-weight:700;">超支 ¥'+Math.abs(remaining).toFixed(2)+'！</span></div></div>');
      } else {
        parts.push('<div style="background:rgba(34,197,94,0.08);border-radius:10px;padding:12px;margin-bottom:10px;border-left:3px solid #22C55E;"><div style="font-size:11px;color:#22C55E;margin-bottom:6px;font-weight:700;">💰 本月预算</div><div style="font-size:13px;color:var(--c-fg);line-height:1.6;">已用 ¥'+spent.toFixed(2)+' / 预算 ¥'+budgetAmount.toFixed(2)+'<br>剩余 <strong style="color:#22C55E;">¥'+remaining.toFixed(2)+'</strong></div></div>');
      }
    }
  }
  // 生理→情绪预测预填卡片
  if (res.emotionSuggestion) {
    window.__emotionSuggestion = res.emotionSuggestion;
    var s = res.emotionSuggestion;
    var deltaTxt = s.delta > 0 ? ('+' + s.delta) : String(s.delta);
    parts.push('<div id="emotionPredCard" style="background:linear-gradient(135deg,rgba(99,102,241,0.10),rgba(168,85,247,0.10));border-radius:10px;padding:12px;margin-bottom:10px;border-left:3px solid #8B5CF6;"><div style="font-size:11px;color:#8B5CF6;margin-bottom:6px;font-weight:700;">🔮 情绪预测预填</div><div style="font-size:14px;color:var(--c-fg);line-height:1.7;">今日还没记情绪。基于你的生理数据，预测情绪：<strong style="font-size:16px;">'+escapeHtml(s.mood)+'</strong>（评分 <strong>'+s.rating+'/10</strong>，基线 '+s.base+' '+escapeHtml(deltaTxt)+'）<br><span style="font-size:12px;color:var(--c-fg-3);">'+escapeHtml(s.reason)+'</span></div><div style="display:flex;gap:8px;margin-top:10px;"><button onclick="acceptEmotionPrediction()" style="flex:1;padding:9px;border:none;border-radius:8px;background:linear-gradient(135deg,#8B5CF6,#A855F7);color:#fff;font-weight:600;font-size:13px;cursor:pointer;">✓ 接受，去记录</button><button onclick="dismissEmotionPrediction()" style="flex:1;padding:9px;border:1px solid var(--c-shadow);border-radius:8px;background:transparent;color:var(--c-fg-2);font-size:13px;cursor:pointer;">忽略</button></div></div>');
  }
  if (res.reflection) parts.push('<div style="background:var(--c-accent);border-radius:10px;padding:12px;margin-bottom:10px;border-left:3px solid var(--c-primary)"><div style="font-size:11px;color:var(--c-primary);margin-bottom:6px">🧠 认知引擎反思</div><div style="font-size:13px;color:var(--c-fg);line-height:1.7;white-space:pre-wrap">'+escapeHtml(res.reflection)+'</div></div>');
  // 睡眠异常健康提醒卡
  if (res.healthTip) {
    var ht = res.healthTip;
    var htColor = ht.level === 'crit' ? '#EF4444' : ht.level === 'warn' ? '#F59E0B' : '#3B82F6';
    var htBg = ht.level === 'crit' ? 'rgba(239,68,68,0.08)' : ht.level === 'warn' ? 'rgba(245,158,11,0.08)' : 'rgba(59,130,246,0.08)';
    var htIcon = ht.level === 'crit' ? '🚨' : ht.level === 'warn' ? '⚠️' : '💡';
    var htHtml = '<div style="background:'+htBg+';border-radius:10px;padding:12px;margin-bottom:10px;border-left:3px solid '+htColor+';">';
    htHtml += '<div style="font-size:12px;color:'+htColor+';margin-bottom:8px;font-weight:700;">'+htIcon+' 健康提醒 · '+escapeHtml(ht.title)+'</div>';
    htHtml += '<ul style="margin:0;padding-left:18px;font-size:12px;color:var(--c-fg);line-height:1.8;">';
    ht.tips.forEach(function(t){ htHtml += '<li>'+escapeHtml(t)+'</li>'; });
    htHtml += '</ul></div>';
    parts.push(htHtml);
  }
  if (res.dailySummary) parts.push('<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:8px">📊 '+escapeHtml(res.dailySummary)+'</div>');
  if (res.correlations && res.correlations.length > 0) {
    var ch = '<div style="margin-bottom:10px"><div style="font-size:11px;color:var(--c-primary);margin-bottom:6px">🔗 关联发现</div>';
    res.correlations.forEach(function(c){
      var color = c.s === 'crit' ? '#EF4444' : c.s === 'high' ? '#F59E0B' : 'var(--c-primary)';
      ch += '<div style="background:var(--c-accent);border-radius:8px;padding:8px 10px;margin-bottom:6px;border-left:3px solid '+color+';font-size:12px;color:#4B5563;line-height:1.6;white-space:pre-wrap">'+escapeHtml(c.m)+'</div>';
    });
    ch += '</div>';
    parts.push(ch);
  }
  if (res.risks && res.risks.length > 0) {
    var rh = '<div style="margin-bottom:10px"><div style="font-size:11px;color:#EF4444;margin-bottom:6px">⚠️ 风险预警</div>';
    res.risks.forEach(function(r){
      var bg = r.l === 'high' ? 'rgba(239,68,68,0.1)' : r.l === 'med' ? 'rgba(245,158,11,0.1)' : '#FFFFFF';
      rh += '<div style="background:'+bg+';border-radius:8px;padding:8px 10px;margin-bottom:6px;border-left:3px solid '+(r.l==='high'?'#EF4444':r.l==='med'?'#F59E0B':'#94A3B8')+';font-size:12px;color:#4B5563;line-height:1.6;white-space:pre-wrap">'+escapeHtml(r.t)+'</div>';
    });
    rh += '</div>';
    parts.push(rh);
  }
  if (parts.length === 0) {
    parts.push('<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px">已保存 ✓<br><br>多记录几次，认知引擎会开始发现你的模式。</div>');
  }
  if (res.reflection) {
    parts.push('<div style="margin-top:10px"><button onclick="quickAddPrincipleFromReflection()" style="width:100%;padding:8px;border:1px solid var(--c-shadow);border-radius:8px;background:transparent;color:var(--c-primary);font-size:12px;cursor:pointer">📐 把反思提炼为原则</button></div>');
    window.__lastReflection = res.reflection;
  }
  openModal2('✨ 保存后的认知反馈', parts.join(''), '<button class="sv" onclick="closeModal2()">知道了</button>');
}

function quickAddPrincipleFromReflection(){
  var text = window.__lastReflection || '';
  var shortened = text.split('\n')[0]; // 取第一行作为原则候选
  var p = prompt('提炼为原则：', shortened);
  if (!p) return;
  fetch('/api/principles', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:p, source:'反思提炼'}) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d.success) { closeModal2(); loadCognitiveCounts(); alert('✅ 已加入原则库'); }
      else alert(d.message || '失败');
    })
    .catch(function(){ alert('网络错误'); });
}

// 接受情绪预测：写入 prefill 并打开情绪表单
function acceptEmotionPrediction(){
  var s = window.__emotionSuggestion;
  if (!s) { closeModal2(); return; }
  try {
    var prefill = {
      rating: String(s.rating),
      trigger: '生理预测',
      physical: s.delta < 0 ? '身体有疲惫信号' : '',
      content: s.mood + '（预测）',
      date: TODAY
    };
    localStorage.setItem('prefill_emotion', JSON.stringify(prefill));
  } catch(e) {}
  closeModal2();
  openScene('emotion');
  openAdd();
}

// 忽略情绪预测：隐藏卡片
function dismissEmotionPrediction(){
  var card = document.getElementById('emotionPredCard');
  if (card) card.style.display = 'none';
}

// 简单HTML转义
function escapeHtml(s){
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// v5.6 健康指标趋势
// ============================================================
async function openHealthTrends(){
  openModal2('💉 健康指标趋势', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/health-trends?days=90');
    var d = await r.json();
    var w = d.weight || [];
    var bp = d.bloodPressure || [];
    var s = d.stats || {};
    var html = '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:10px">读取身体模块中体重/血压记录 · 最近90天</div>';
    // 统计卡片
    if (s.weight || s.bp) {
      html += '<div style="display:flex;gap:8px;margin-bottom:14px">';
      if (s.weight) {
        var trendColor = s.weight.trend === '上升' ? '#EF4444' : s.weight.trend === '下降' ? '#10B981' : 'var(--c-primary)';
        html += '<div style="flex:1;background:var(--c-surface);border-radius:10px;padding:10px">';
        html += '<div style="font-size:11px;color:var(--c-fg-3)">⚖️ 体重</div>';
        html += '<div style="font-size:18px;font-weight:700;color:var(--c-fg);margin-top:2px">' + s.weight.last + ' <span style="font-size:11px;color:var(--c-fg-3);font-weight:400">kg</span></div>';
        html += '<div style="font-size:11px;color:' + trendColor + ';margin-top:2px">' + s.weight.trend + (s.weight.change >= 0 ? ' +' : ' ') + s.weight.change + 'kg</div>';
        html += '<div style="font-size:10px;color:var(--c-fg-3);margin-top:4px">区间 ' + s.weight.min + '-' + s.weight.max + ' · 均' + s.weight.avg + '</div>';
        html += '</div>';
      }
      if (s.bp) {
        var bpColor = s.bp.level === '偏高' ? '#EF4444' : s.bp.level === '偏低' ? '#F59E0B' : '#10B981';
        html += '<div style="flex:1;background:var(--c-surface);border-radius:10px;padding:10px">';
        html += '<div style="font-size:11px;color:var(--c-fg-3)">🩸 血压</div>';
        html += '<div style="font-size:18px;font-weight:700;color:var(--c-fg);margin-top:2px">' + s.bp.lastSys + '/' + s.bp.lastDia + '</div>';
        html += '<div style="font-size:11px;color:' + bpColor + ';margin-top:2px">' + s.bp.level + '</div>';
        html += '<div style="font-size:10px;color:var(--c-fg-3);margin-top:4px">均值 ' + s.bp.sysAvg + '/' + s.bp.diaAvg + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }
    // 体重折线图（SVG）
    if (w.length > 0) {
      html += renderLineChart('体重趋势(kg)', w.map(function(p){return {x:p.date, y:p.weight};}), 'var(--c-primary)');
    }
    // 血压折线图
    if (bp.length > 0) {
      html += renderDualLineChart('血压趋势(mmHg)', bp.map(function(p){return {x:p.date, y1:p.sys, y2:p.dia};}), '#EF4444', '#3B82F6');
    }
    if (!w.length && !bp.length) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px;line-height:1.8">📊 暂无数据<br><br>请在「我的身体」中记录体重或血压<br>系统将自动生成趋势图</div>';
    }
    html += '<div style="margin-top:10px;font-size:11px;color:var(--c-fg-3);text-align:center;line-height:1.6">💡 数据来源：身体模块表单中的体重/血压字段<br>记录越多，趋势越准</div>';
    openModal2('💉 健康指标趋势', html);
  } catch(e) {
    openModal2('💉 健康指标趋势', '<div style="color:#EF4444;padding:20px;text-align:center">加载失败</div>');
  }
}
// SVG折线图渲染（单线）
function renderLineChart(title, points, color){
  if (!points || points.length < 2) {
    return '<div style="background:var(--c-surface);border-radius:10px;padding:14px;margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--c-fg);margin-bottom:6px">' + title + '</div><div style="font-size:11px;color:var(--c-fg-3);text-align:center;padding:10px">数据点不足（至少2个）</div></div>';
  }
  var W = 280, H = 110, padL = 28, padR = 8, padT = 10, padB = 18;
  var xs = points.map(function(p){return p.x;});
  var ys = points.map(function(p){return p.y;});
  var xMin = xs[0], xMax = xs[xs.length-1];
  var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  var xRange = (new Date(xMax).getTime() - new Date(xMin).getTime()) || 1;
  var yRange = (yMax - yMin) || 1;
  var pts = points.map(function(p){
    var x = padL + ((new Date(p.x).getTime() - new Date(xMin).getTime()) / xRange) * (W - padL - padR);
    var y = padT + (1 - (p.y - yMin) / yRange) * (H - padT - padB);
    return {x: x, y: y, val: p.y, date: p.x};
  });
  var path = pts.map(function(p,i){return (i===0?'M':'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1);}).join(' ');
  var areaPath = path + ' L' + pts[pts.length-1].x.toFixed(1) + ',' + (H-padB) + ' L' + pts[0].x.toFixed(1) + ',' + (H-padB) + ' Z';
  var html = '<div style="background:var(--c-surface);border-radius:10px;padding:14px;margin-bottom:12px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:12px;font-weight:600;color:var(--c-fg)">' + title + '</span><span style="font-size:10px;color:var(--c-fg-3)">' + points.length + '个点</span></div>';
  html += '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto">';
  // Y轴标尺线
  for (var i=0; i<=2; i++) {
    var ly = padT + (H-padT-padB) * i / 2;
    var lv = (yMax - (yMax-yMin)*i/2).toFixed(1);
    html += '<line x1="' + padL + '" y1="' + ly + '" x2="' + (W-padR) + '" y2="' + ly + '" stroke="#F3F4F6" stroke-width="1"/>';
    html += '<text x="' + (padL-4) + '" y="' + (ly+3) + '" text-anchor="end" font-size="9" fill="#9CA3AF">' + lv + '</text>';
  }
  // 区域填充
  html += '<defs><linearGradient id="g' + Math.random().toString(36).slice(2,7) + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity="0.2"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>';
  html += '<path d="' + areaPath + '" fill="url(#' + ' )"/>';
  // 折线
  html += '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  // 点
  pts.forEach(function(p){
    html += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2.5" fill="' + color + '"/>';
  });
  // X轴日期
  if (pts.length >= 2) {
    html += '<text x="' + pts[0].x + '" y="' + (H-4) + '" text-anchor="middle" font-size="9" fill="#9CA3AF">' + pts[0].date.substring(5) + '</text>';
    html += '<text x="' + pts[pts.length-1].x + '" y="' + (H-4) + '" text-anchor="middle" font-size="9" fill="#9CA3AF">' + pts[pts.length-1].date.substring(5) + '</text>';
  }
  html += '</svg></div>';
  return html;
}
// SVG双线图（血压：高压/低压）
function renderDualLineChart(title, points, c1, c2){
  if (!points || points.length < 2) {
    return '<div style="background:var(--c-surface);border-radius:10px;padding:14px;margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--c-fg);margin-bottom:6px">' + title + '</div><div style="font-size:11px;color:var(--c-fg-3);text-align:center;padding:10px">数据点不足</div></div>';
  }
  var W = 280, H = 110, padL = 28, padR = 8, padT = 10, padB = 18;
  var xs = points.map(function(p){return p.x;});
  var allY = points.map(function(p){return p.y1;}).concat(points.map(function(p){return p.y2;}));
  var xMin = xs[0], xMax = xs[xs.length-1];
  var yMin = Math.min.apply(null, allY), yMax = Math.max.apply(null, allY);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  var xRange = (new Date(xMax).getTime() - new Date(xMin).getTime()) || 1;
  var yRange = (yMax - yMin) || 1;
  var mkPts = function(key){ return points.map(function(p){
    var x = padL + ((new Date(p.x).getTime() - new Date(xMin).getTime()) / xRange) * (W - padL - padR);
    var y = padT + (1 - (p[key] - yMin) / yRange) * (H - padT - padB);
    return {x: x, y: y, val: p[key], date: p.x};
  }); };
  var p1 = mkPts('y1'), p2 = mkPts('y2');
  var mkPath = function(pts){ return pts.map(function(p,i){return (i===0?'M':'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1);}).join(' '); };
  var html = '<div style="background:var(--c-surface);border-radius:10px;padding:14px;margin-bottom:12px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:12px;font-weight:600;color:var(--c-fg)">' + title + '</span><span style="font-size:10px;color:var(--c-fg-3)"><span style="color:'+c1+'">●</span>高压 <span style="color:'+c2+';margin-left:6px">●</span>低压</span></div>';
  html += '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto">';
  for (var i=0; i<=2; i++) {
    var ly = padT + (H-padT-padB) * i / 2;
    var lv = Math.round(yMax - (yMax-yMin)*i/2);
    html += '<line x1="' + padL + '" y1="' + ly + '" x2="' + (W-padR) + '" y2="' + ly + '" stroke="#F3F4F6" stroke-width="1"/>';
    html += '<text x="' + (padL-4) + '" y="' + (ly+3) + '" text-anchor="end" font-size="9" fill="#9CA3AF">' + lv + '</text>';
  }
  html += '<path d="' + mkPath(p1) + '" fill="none" stroke="' + c1 + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  html += '<path d="' + mkPath(p2) + '" fill="none" stroke="' + c2 + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  p1.forEach(function(p){ html += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2" fill="' + c1 + '"/>'; });
  p2.forEach(function(p){ html += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2" fill="' + c2 + '"/>'; });
  if (p1.length >= 2) {
    html += '<text x="' + p1[0].x + '" y="' + (H-4) + '" text-anchor="middle" font-size="9" fill="#9CA3AF">' + p1[0].date.substring(5) + '</text>';
    html += '<text x="' + p1[p1.length-1].x + '" y="' + (H-4) + '" text-anchor="middle" font-size="9" fill="#9CA3AF">' + p1[p1.length-1].date.substring(5) + '</text>';
  }
  html += '</svg></div>';
  return html;
}

// ============================================================
// v5.6 周月计划
// ============================================================
var currentPlanType = 'week';
async function openPlan(){
  currentPlanType = 'week';
  await renderPlanList();
}
async function renderPlanList(){
  openModal2('📋 ' + (currentPlanType==='week'?'周':'月') + '计划', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/plan?type=' + currentPlanType);
    var list = await r.json();
    var cmpR = await fetch('/api/plan/compare?type=' + currentPlanType);
    var cmp = await cmpR.json();
    var html = '';
    // 类型切换
    html += '<div style="display:flex;gap:6px;margin-bottom:10px">';
    html += '<button onclick="currentPlanType=\'week\';renderPlanList()" style="flex:1;padding:8px;border:'+(currentPlanType==='week'?'2px solid var(--c-primary)':'1px solid #E5E7EB')+';background:'+(currentPlanType==='week'?'#EEF2FF':'#fff')+';color:'+(currentPlanType==='week'?'var(--c-primary)':'#6B7280')+';border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">📅 周计划</button>';
    html += '<button onclick="currentPlanType=\'month\';renderPlanList()" style="flex:1;padding:8px;border:'+(currentPlanType==='month'?'2px solid var(--c-primary)':'1px solid #E5E7EB')+';background:'+(currentPlanType==='month'?'#EEF2FF':'#fff')+';color:'+(currentPlanType==='month'?'var(--c-primary)':'#6B7280')+';border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">🗓️ 月计划</button>';
    html += '</div>';
    // 对比信息
    if (cmp && cmp.message) {
      html += '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#4B5563;line-height:1.6">' + cmp.message + '</div>';
    }
    // 创建按钮
    html += '<button onclick="openCreatePlan()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary),var(--c-primary-2));color:#fff;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:12px">+ 创建新' + (currentPlanType==='week'?'周':'月') + '计划</button>';
    // 计划列表
    if (!list.length) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px;line-height:1.8">📭 暂无' + (currentPlanType==='week'?'周':'月') + '计划<br>创建一个，开始追踪执行</div>';
    } else {
      list.forEach(function(p){
        var pct = p.progress || 0;
        var barColor = pct === 100 ? '#10B981' : pct >= 50 ? 'var(--c-primary)' : '#F59E0B';
        html += '<div style="background:var(--c-surface);border-radius:12px;padding:12px;margin-bottom:8px">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
        html += '<span style="font-size:13px;font-weight:600;color:var(--c-fg)">' + escapeHtml(p.title || p.period) + '</span>';
        html += '<span style="font-size:11px;color:' + barColor + ';font-weight:700">' + p.done + '/' + p.total + ' · ' + pct + '%</span>';
        html += '</div>';
        html += '<div style="height:4px;background:#F3F4F6;border-radius:2px;margin-bottom:8px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+barColor+';border-radius:2px;transition:width .3s"></div></div>';
        // 事项列表
        if (p.items && p.items.length) {
          p.items.forEach(function(it){
            var checked = it.done ? '☑' : '☐';
            var color = it.done ? '#10B981' : '#9CA3AF';
            var decor = it.done ? 'line-through;color:var(--c-fg-3)' : 'color:var(--c-fg-2)';
            html += '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px">';
            html += '<span onclick="togglePlanItem(\''+p.id+'\',\''+it.id+'\')" style="cursor:pointer;color:'+color+';font-size:14px">'+checked+'</span>';
            html += '<span style="flex:1;'+decor+'">'+escapeHtml(it.text)+'</span>';
            html += '<span onclick="delPlanItem(\''+p.id+'\',\''+it.id+'\')" style="color:#EF4444;cursor:pointer;font-size:11px">✕</span>';
            html += '</div>';
          });
        }
        // 添加事项
        html += '<div style="display:flex;gap:6px;margin-top:8px">';
        html += '<input id="planItemInput_'+p.id+'" placeholder="添加事项..." style="flex:1;padding:6px 8px;border:1px solid #E5E7EB;border-radius:6px;font-size:11px">';
        html += '<button onclick="addPlanItem(\''+p.id+'\')" style="padding:6px 10px;border:none;border-radius:6px;background:var(--c-primary);color:#fff;font-size:11px;cursor:pointer">+</button>';
        html += '</div>';
        html += '<div style="margin-top:6px;text-align:right"><span onclick="delPlan(\''+p.id+'\')" style="font-size:11px;color:#EF4444;cursor:pointer">🗑 删除计划</span></div>';
        html += '</div>';
      });
    }
    openModal2('📋 ' + (currentPlanType==='week'?'周':'月') + '计划', html);
  } catch(e) {
    openModal2('📋 计划', '<div style="color:#EF4444;padding:20px;text-align:center">加载失败</div>');
  }
}
function openCreatePlan(){
  var html = '<div style="font-size:12px;color:var(--c-fg-2);margin-bottom:8px">类型：' + (currentPlanType==='week'?'周计划':'月计划') + '</div>';
  html += '<label style="font-size:12px;color:var(--c-fg-2)">标题（可选）</label>';
  html += '<input id="newPlanTitle" placeholder="' + (currentPlanType==='week'?'如：第31周重点攻坚':'如：8月战略目标') + '" style="width:100%;padding:8px 10px;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:10px;font-size:13px">';
  html += '<label style="font-size:12px;color:var(--c-fg-2)">事项（每行一条）</label>';
  html += '<textarea id="newPlanItems" rows="5" placeholder="读书30分钟&#10;锻炼&#10;写日记" style="width:100%;padding:8px 10px;border:1px solid #E5E7EB;border-radius:8px;font-size:13px"></textarea>';
  html += '<div style="display:flex;gap:8px;margin-top:12px">';
  html += '<button onclick="createPlan()" style="flex:1;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,var(--c-primary),var(--c-primary-2));color:#fff;font-size:13px;font-weight:600;cursor:pointer">创建</button>';
  html += '<button onclick="renderPlanList()" style="flex:1;padding:10px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;color:var(--c-fg-2);font-size:13px;cursor:pointer">取消</button>';
  html += '</div>';
  openModal2('➕ 创建' + (currentPlanType==='week'?'周':'月') + '计划', html);
}
async function createPlan(){
  var title = document.getElementById('newPlanTitle').value.trim();
  var itemsRaw = document.getElementById('newPlanItems').value;
  var items = itemsRaw.split('\n').map(function(s){return s.trim();}).filter(Boolean);
  if (!items.length) { alert('请至少添加一条事项'); return; }
  try {
    await fetch('/api/plan', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ type: currentPlanType, title: title, items: items })
    });
    renderPlanList();
    loadCognitiveCounts();
  } catch(e) { alert('创建失败'); }
}
async function togglePlanItem(planId, itemId){
  try {
    await fetch('/api/plan/'+planId+'/item/'+itemId+'/toggle', { method: 'POST' });
    renderPlanList();
  } catch(e) { alert('操作失败'); }
}
async function addPlanItem(planId){
  var inp = document.getElementById('planItemInput_'+planId);
  var text = inp.value.trim();
  if (!text) return;
  try {
    await fetch('/api/plan/'+planId+'/item', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text: text })
    });
    renderPlanList();
  } catch(e) { alert('添加失败'); }
}
async function delPlanItem(planId, itemId){
  if (!confirm('删除该事项？')) return;
  try {
    await fetch('/api/plan/'+planId+'/item/'+itemId, { method: 'DELETE' });
    renderPlanList();
  } catch(e) { alert('删除失败'); }
}
async function delPlan(planId){
  if (!confirm('删除整个计划？')) return;
  try {
    await fetch('/api/plan/'+planId, { method: 'DELETE' });
    renderPlanList();
    loadCognitiveCounts();
  } catch(e) { alert('删除失败'); }
}

// ============================================================
// v5.7 因果推断引擎
// ============================================================
async function openCausal(){
  openModal2('🔗 因果推断引擎', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">分析滞后效应中...</div>');
  try {
    var r = await fetch('/api/eng/causal?maxLag=7');
    var d = await r.json();
    if (!d.success) {
      openModal2('🔗 因果推断引擎', '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px;line-height:1.8">📊 数据不足<br><br>' + (d.message || '需要更多记录') + '<br><br>请持续记录情绪、睡眠、锻炼数据<br>系统将通过滞后相关性分析"什么导致什么"</div>');
      return;
    }
    var html = '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:10px">基于' + d.sampleSize + '条情绪记录 · 测试0-7天滞后相关性</div>';
    html += '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">🎯 因果 ≠ 相关。本引擎通过"滞后时间窗"分析：今天的情绪，是否由N天前的睡眠/锻炼导致。<br>滞后相关性越强，因果方向越可信。</div>';
    if (d.factors && d.factors.length) {
      d.factors.forEach(function(f){
        var strengthColor = f.strength === '强' ? '#EF4444' : f.strength === '中' ? '#F59E0B' : '#9CA3AF';
        html += '<div style="background:var(--c-surface);border-radius:12px;padding:12px;margin-bottom:10px">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
        html += '<span style="font-size:13px;font-weight:600;color:var(--c-fg)">' + f.factorName + '</span>';
        html += '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:'+strengthColor+'20;color:'+strengthColor+';font-weight:600">' + f.strength + '</span>';
        html += '</div>';
        html += '<div style="font-size:12px;color:#4B5563;margin-bottom:8px;line-height:1.6">' + f.insight + '</div>';
        // 滞后曲线
        if (f.lagTests && f.lagTests.length > 1) {
          var maxAbsR = 0;
          f.lagTests.forEach(function(t){ if (Math.abs(t.r) > maxAbsR) maxAbsR = Math.abs(t.r); });
          if (maxAbsR > 0) {
            html += '<div style="margin-top:6px">';
            html += '<div style="font-size:10px;color:var(--c-fg-3);margin-bottom:4px">滞后相关性曲线（横轴=滞后天数，纵轴=相关系数r）</div>';
            html += '<svg viewBox="0 0 280 80" style="width:100%;height:auto">';
            // 0线
            var xStep = 260 / (f.lagTests.length - 1 || 1);
            html += '<line x1="10" y1="40" x2="280" y2="40" stroke="#E5E7EB" stroke-width="1" stroke-dasharray="2,2"/>';
            // 点和线
            var pathPoints = f.lagTests.map(function(t,i){
              var x = 10 + i * xStep;
              var y = 40 - (t.r / Math.max(maxAbsR, 0.1)) * 30;
              return {x:x, y:y, r:t.r, lag:t.lag};
            });
            var pathStr = pathPoints.map(function(p,i){ return (i===0?'M':'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
            html += '<path d="' + pathStr + '" fill="none" stroke="var(--c-primary)" stroke-width="2"/>';
            pathPoints.forEach(function(p){
              var isBest = (p.lag === f.bestLag);
              html += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + (isBest?4:2.5) + '" fill="' + (isBest?'#EF4444':'var(--c-primary)') + '"/>';
            });
            // X标签
            pathPoints.forEach(function(p,i){
              if (i % 2 === 0) html += '<text x="' + p.x.toFixed(1) + '" y="74" text-anchor="middle" font-size="9" fill="#9CA3AF">' + p.lag + 'd</text>';
            });
            html += '</svg></div>';
          }
        }
        html += '<div style="margin-top:6px;font-size:11px;color:var(--c-fg-3)">最佳滞后：' + f.bestLag + '天 · r=' + f.bestR + ' · 方向：' + f.direction + '</div>';
        html += '</div>';
      });
    }
    html += '<div style="margin-top:10px;font-size:11px;color:var(--c-fg-3);text-align:center;line-height:1.6">💡 滞后0天=当天影响，1天=昨天的事今天显现<br>记录越多，滞后效应越清晰</div>';
    openModal2('🔗 因果推断引擎', html);
  } catch(e) {
    openModal2('🔗 因果推断引擎', '<div style="color:#EF4444;padding:20px;text-align:center">加载失败</div>');
  }
}

// ============================================================
// v5.7 个人基线
// ============================================================
async function openBaseline(){
  openModal2('📐 个人基线算法', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">计算基线中...</div>');
  try {
    var r = await fetch('/api/eng/baseline?days=30');
    var d = await r.json();
    if (!d.success) {
      openModal2('📐 个人基线算法', '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px">' + (d.message || '数据不足') + '</div>');
      return;
    }
    var html = '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:8px">基于近' + d.days + '天数据建立个人常态基线</div>';
    html += '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">' + d.insight + '</div>';
    // 各维度基线
    var dims = d.baselines || {};
    var dimKeys = Object.keys(dims);
    if (!dimKeys.length) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px;line-height:1.8">📊 暂无足够数据<br><br>请持续记录情绪、睡眠、锻炼<br>系统将建立你的"常态区间"</div>';
    } else {
      dimKeys.forEach(function(key){
        var b = dims[key];
        html += '<div style="background:var(--c-surface);border-radius:12px;padding:12px;margin-bottom:10px">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
        html += '<span style="font-size:13px;font-weight:600;color:var(--c-fg)">' + b.label + '</span>';
        html += '<span style="font-size:11px;color:var(--c-primary);font-weight:700">均' + b.mean + b.unit + '</span>';
        html += '</div>';
        html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-fg-2);margin-bottom:6px">';
        html += '<span>P25: ' + b.p25 + b.unit + '</span>';
        html += '<span>中位: ' + b.median + b.unit + '</span>';
        html += '<span>P75: ' + b.p75 + b.unit + '</span>';
        html += '</div>';
        // 基线区间条
        var range = b.max - b.min || 1;
        var p25Pct = ((b.p25 - b.min) / range) * 100;
        var p75Pct = ((b.p75 - b.min) / range) * 100;
        var meanPct = ((b.mean - b.min) / range) * 100;
        html += '<div style="position:relative;height:18px;background:linear-gradient(90deg,#DBEAFE 0%,#DBEAFE ' + p25Pct + '%, var(--c-primary) ' + p25Pct + '%, var(--c-primary) ' + p75Pct + '%, #DBEAFE ' + p75Pct + '%);border-radius:9px;overflow:hidden">';
        html += '<div style="position:absolute;top:0;left:' + meanPct + '%;width:2px;height:18px;background:#1A1A2E"></div>';
        html += '</div>';
        html += '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--c-fg-3);margin-top:2px">';
        html += '<span>最低' + b.min + '</span>';
        html += '<span>变异系数' + b.cv + '%</span>';
        html += '<span>最高' + b.max + '</span>';
        html += '</div>';
        html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:4px">样本数：' + b.count + ' · 标准差：' + b.std + '</div>';
        html += '</div>';
      });
      // 今日偏离
      if (d.deviations && d.deviations.length) {
        html += '<div style="background:var(--c-surface);border-radius:12px;padding:12px;margin-bottom:10px">';
        html += '<div style="font-size:12px;font-weight:600;color:var(--c-fg);margin-bottom:8px">📍 今日偏离基线</div>';
        d.deviations.forEach(function(dev){
          var devColor = dev.status === 'below' ? '#EF4444' : dev.status === 'above' ? '#F59E0B' : '#10B981';
          var statusText = dev.status === 'below' ? '↓ 低于基线' : dev.status === 'above' ? '↑ 高于基线' : '✓ 在正常区间';
          html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed #F3F4F6">';
          html += '<span style="font-size:12px;color:var(--c-fg-2)">' + dev.label + '</span>';
          html += '<span style="font-size:12px;color:' + devColor + ';font-weight:600">' + dev.value + ' (' + (dev.dev>=0?'+':'') + dev.dev + ') ' + statusText + '</span>';
          html += '</div>';
        });
        html += '</div>';
      }
    }
    html += '<div style="margin-top:10px;font-size:11px;color:var(--c-fg-3);text-align:center;line-height:1.6">💡 基线=你的常态。偏离基线的事件才值得关注——<br>知道"为什么偏"比"维持平稳"更重要</div>';
    openModal2('📐 个人基线算法', html);
  } catch(e) {
    openModal2('📐 个人基线算法', '<div style="color:#EF4444;padding:20px;text-align:center">加载失败</div>');
  }
}

// ============================================================
// v5.7 人生节点标记
// ============================================================
async function openLifeMilestone(){
  openModal2('⚓ 人生节点', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">加载中...</div>');
  try {
    var r = await fetch('/api/life-milestone');
    var list = await r.json();
    var html = '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">⚓ 人生节点=你回头看时，定义"你是谁"的那些时刻。<br>不是大事记，是转折点——它改变了你之后的方向。</div>';
    html += '<button onclick="openCreateMilestone()" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,var(--c-primary),var(--c-primary-2));color:#fff;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:12px">+ 标记一个人生节点</button>';
    if (!list.length) {
      html += '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px;line-height:1.8">📭 暂无人生节点<br>标记一个：毕业、换工作、独立、觉醒...<br>都是你成为今天的自己的关键点</div>';
    } else {
      // 按日期倒序
      list.sort(function(a,b){ return a.date < b.date ? 1 : -1; });
      // 时间轴
      html += '<div style="position:relative;padding-left:14px">';
      html += '<div style="position:absolute;left:4px;top:0;bottom:0;width:2px;background:linear-gradient(180deg,var(--c-primary),var(--c-primary-2),#E5E7EB)"></div>';
      list.forEach(function(m){
        var typeColor = m.type === '转折' ? 'var(--c-primary)' : m.type === '成就' ? '#10B981' : m.type === '挫折' ? '#EF4444' : m.type === '觉醒' ? '#F59E0B' : '#6B7280';
        html += '<div style="position:relative;margin-bottom:14px">';
        html += '<div style="position:absolute;left:-14px;top:4px;width:10px;height:10px;border-radius:50%;background:'+typeColor+';border:2px solid #fff;box-shadow:0 0 0 2px '+typeColor+'"></div>';
        html += '<div style="background:var(--c-surface);border-radius:10px;padding:10px 12px;margin-left:8px">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">';
        html += '<span style="font-size:13px;font-weight:600;color:var(--c-fg)">' + escapeHtml(m.title) + '</span>';
        html += '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:'+typeColor+'20;color:'+typeColor+'">' + (m.type || '节点') + '</span>';
        html += '</div>';
        html += '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:4px">📅 ' + m.date + '</div>';
        if (m.description) html += '<div style="font-size:12px;color:var(--c-fg-2);line-height:1.6;margin-bottom:4px">' + escapeHtml(m.description) + '</div>';
        if (m.impact) html += '<div style="font-size:11px;color:var(--c-primary);margin-bottom:4px">💥 影响：' + escapeHtml(m.impact) + '</div>';
        if (m.lesson) html += '<div style="font-size:11px;color:#F59E0B">💡 教训：' + escapeHtml(m.lesson) + '</div>';
        html += '<div style="margin-top:6px;text-align:right"><span onclick="delMilestone(\''+m.id+'\')" style="font-size:11px;color:#EF4444;cursor:pointer">🗑 删除</span></div>';
        html += '</div></div>';
      });
      html += '</div>';
    }
    openModal2('⚓ 人生节点', html);
  } catch(e) {
    openModal2('⚓ 人生节点', '<div style="color:#EF4444;padding:20px;text-align:center">加载失败</div>');
  }
}
function openCreateMilestone(){
  var html = '<label style="font-size:12px;color:var(--c-fg-2)">标题 *</label>';
  html += '<input id="msTitle" placeholder="如：独立出海/毕业/觉醒时刻" style="width:100%;padding:8px 10px;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:10px;font-size:13px">';
  html += '<label style="font-size:12px;color:var(--c-fg-2)">日期 *</label>';
  html += '<input id="msDate" type="date" style="width:100%;padding:8px 10px;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:10px;font-size:13px">';
  html += '<label style="font-size:12px;color:var(--c-fg-2)">类型</label>';
  html += '<select id="msType" style="width:100%;padding:8px 10px;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:10px;font-size:13px">';
  ['转折','成就','挫折','觉醒','相遇','离别','选择'].forEach(function(t){
    html += '<option value="'+t+'">'+t+'</option>';
  });
  html += '</select>';
  html += '<label style="font-size:12px;color:var(--c-fg-2)">描述</label>';
  html += '<textarea id="msDesc" rows="2" placeholder="发生了什么..." style="width:100%;padding:8px 10px;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:10px;font-size:13px"></textarea>';
  html += '<label style="font-size:12px;color:var(--c-fg-2)">影响</label>';
  html += '<textarea id="msImpact" rows="2" placeholder="它如何改变了我之后的方向..." style="width:100%;padding:8px 10px;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:10px;font-size:13px"></textarea>';
  html += '<label style="font-size:12px;color:var(--c-fg-2)">教训/收获</label>';
  html += '<textarea id="msLesson" rows="2" placeholder="我从中学到了什么..." style="width:100%;padding:8px 10px;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:10px;font-size:13px"></textarea>';
  html += '<div style="display:flex;gap:8px;margin-top:12px">';
  html += '<button onclick="createMilestone()" style="flex:1;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,var(--c-primary),var(--c-primary-2));color:#fff;font-size:13px;font-weight:600;cursor:pointer">保存</button>';
  html += '<button onclick="openLifeMilestone()" style="flex:1;padding:10px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;color:var(--c-fg-2);font-size:13px;cursor:pointer">取消</button>';
  html += '</div>';
  openModal2('➕ 标记人生节点', html);
}
async function createMilestone(){
  var title = document.getElementById('msTitle').value.trim();
  var date = document.getElementById('msDate').value;
  var type = document.getElementById('msType').value;
  var desc = document.getElementById('msDesc').value.trim();
  var impact = document.getElementById('msImpact').value.trim();
  var lesson = document.getElementById('msLesson').value.trim();
  if (!title || !date) { alert('标题和日期必填'); return; }
  try {
    await fetch('/api/life-milestone', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ title:title, date:date, type:type, description:desc, impact:impact, lesson:lesson })
    });
    openLifeMilestone();
    loadCognitiveCounts();
  } catch(e) { alert('保存失败'); }
}
async function delMilestone(id){
  if (!confirm('删除此节点？')) return;
  try {
    await fetch('/api/life-milestone/'+id, { method: 'DELETE' });
    openLifeMilestone();
    loadCognitiveCounts();
  } catch(e) { alert('删除失败'); }
}

// ============================================================
// v5.7 季节性情绪分析
// ============================================================
async function openSeasonal(){
  openModal2('🌦️ 季节性情绪分析', '<div style="text-align:center;color:var(--c-fg-3);padding:20px">分析季节规律中...</div>');
  try {
    var r = await fetch('/api/eng/seasonal');
    var d = await r.json();
    if (!d.success) {
      openModal2('🌦️ 季节性情绪分析', '<div style="text-align:center;color:var(--c-fg-3);padding:30px;font-size:13px;line-height:1.8">📊 数据不足<br><br>' + (d.message || '需要更多情绪记录') + '<br><br>请持续记录情绪评分<br>系统将识别你的"季节性模式"</div>');
      return;
    }
    var html = '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:8px">基于' + d.sampleSize + '条情绪记录 · 按月/季节聚合</div>';
    html += '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">' + d.insight + '</div>';
    // 季节对比
    if (d.seasonal && d.seasonal.length) {
      html += '<div style="background:var(--c-surface);border-radius:12px;padding:12px;margin-bottom:10px">';
      html += '<div style="font-size:12px;font-weight:600;color:var(--c-fg);margin-bottom:8px">🌿 季节平均情绪</div>';
      var maxAvg = Math.max.apply(null, d.seasonal.map(function(s){return s.avg;}));
      var minAvg = Math.min.apply(null, d.seasonal.map(function(s){return s.avg;}));
      var seasonIcons = {'春季':'🌸','夏季':'☀️','秋季':'🍂','冬季':'❄️'};
      d.seasonal.forEach(function(s){
        var isBest = d.bestSeason && s.season === d.bestSeason.season;
        var isWorst = d.worstSeason && s.season === d.worstSeason.season;
        var isCurrent = s.season === d.currentSeason;
        var color = isBest ? '#10B981' : isWorst ? '#EF4444' : 'var(--c-primary)';
        var pct = (s.avg / 10) * 100;
        html += '<div style="margin-bottom:6px">';
        html += '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">';
        html += '<span style="color:var(--c-fg-2)">' + (seasonIcons[s.season]||'📅') + ' ' + s.season + (isCurrent?' <span style="color:#F59E0B;font-size:10px">[当前]</span>':'') + '</span>';
        html += '<span style="color:' + color + ';font-weight:700">' + s.avg + '/10 <span style="color:var(--c-fg-3);font-weight:400">(' + s.count + '条)</span></span>';
        html += '</div>';
        html += '<div style="height:6px;background:#F3F4F6;border-radius:3px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:3px"></div></div>';
        html += '</div>';
      });
      if (d.bestSeason && d.worstSeason && d.bestSeason.season !== d.worstSeason.season) {
        html += '<div style="margin-top:8px;font-size:11px;color:var(--c-fg-3);text-align:center">差距 ' + (d.bestSeason.avg - d.worstSeason.avg).toFixed(1) + '分</div>';
      }
      html += '</div>';
    }
    // 月度柱状图
    if (d.monthly && d.monthly.length) {
      html += '<div style="background:var(--c-surface);border-radius:12px;padding:12px;margin-bottom:10px">';
      html += '<div style="font-size:12px;font-weight:600;color:var(--c-fg);margin-bottom:8px">📅 月度情绪分布</div>';
      var maxM = Math.max.apply(null, d.monthly.map(function(m){return m.avg;}));
      // 12个月柱状图
      html += '<svg viewBox="0 0 280 90" style="width:100%;height:auto">';
      var barW = 280 / 12;
      d.monthly.forEach(function(m){
        var idx = m.month - 1;
        var x = idx * barW + 2;
        var h = (m.avg / 10) * 60;
        var y = 70 - h;
        var color = m.avg >= 7 ? '#10B981' : m.avg >= 5 ? 'var(--c-primary)' : '#F59E0B';
        html += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + (barW-4).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + color + '" rx="2"/>';
        html += '<text x="' + (x + (barW-4)/2).toFixed(1) + '" y="80" text-anchor="middle" font-size="8" fill="#9CA3AF">' + m.month + '月</text>';
        html += '<text x="' + (x + (barW-4)/2).toFixed(1) + '" y="' + (y-2).toFixed(1) + '" text-anchor="middle" font-size="8" fill="#4B5563">' + m.avg + '</text>';
      });
      html += '</svg></div>';
    }
    html += '<div style="margin-top:10px;font-size:11px;color:var(--c-fg-3);text-align:center;line-height:1.6">💡 季节性揭示你的"内在节律"<br>知道哪个季节低落，可以提前干预而非被动承受</div>';
    openModal2('🌦️ 季节性情绪分析', html);
  } catch(e) {
    openModal2('🌦️ 季节性情绪分析', '<div style="color:#EF4444;padding:20px;text-align:center">加载失败</div>');
  }
}

// 日志Tab：按生活域分组 + 今日统计 + 搜索
var RECORD_GROUPS = {
  life:    {ids:['health','diet','sleep','emotion','exercise','pet'], title:'生活基础', icon:'🌱', sub:'健康·饮食·睡眠·情绪·锻炼·宠物'},
  growth:  {ids:['growth','think','diary','photo'], title:'成长认知', icon:'📚', sub:'成长·思考·日记·摄影'},
  action:  {ids:['work','home','travel','time','relation','todo'], title:'行动场景', icon:'💼', sub:'工作·居住·出行·时间·关系·待办'},
  asset:   {ids:['finance','inventory','space'], title:'资产管理', icon:'📦', sub:'财务·库存·空间'}
};
// 模块元信息（统一来源，避免 SCENES/CORE_MODULES 分裂）
var MODULE_META = {
  body:{name:'身体',icon:'💪'}, diet:{name:'饮食',icon:'🥗'}, sleep:{name:'睡眠',icon:'😴'}, emotion:{name:'情绪',icon:'😊'},
  learn:{name:'学习',icon:'📚'}, think:{name:'思考',icon:'🧠'}, diary:{name:'日记',icon:'📖'}, photo:{name:'摄影',icon:'📷'},
  work:{name:'工作',icon:'💼'}, home:{name:'居住',icon:'🏠'}, travel:{name:'出行',icon:'🛵'}, time:{name:'时间',icon:'⏰'}, relation:{name:'关系',icon:'👥'},
  finance:{name:'财务',icon:'💰'}, inventory:{name:'库存',icon:'📦'}, space:{name:'空间',icon:'🏚️'},
  exercise:{name:'锻炼',icon:'🏃'}, growth:{name:'成长',icon:'🌱'}, spirit:{name:'精神',icon:'🧘'},
  pet:{name:'宠物',icon:'🐾'},
  medical:{name:'医疗',icon:'🏥'}, todo:{name:'待办',icon:'📋'},
  health:{name:'健康',icon:'❤️'}
};

function renderRecord(){
  // 今日统计
  renderRecToday();
  // 分组渲染
  Object.keys(RECORD_GROUPS).forEach(function(cat){
    var g = RECORD_GROUPS[cat];
    var container = document.getElementById('rec' + cat.charAt(0).toUpperCase() + cat.slice(1));
    if(!container) return;
    container.innerHTML = g.ids.map(function(mid){
      return renderSceneCard(mid);
    }).join('');
  });
}
function renderSceneCard(mid){
  var meta = MODULE_META[mid] || {name:mid, icon:'📄'};
  var cnt = (dataCache[mid]||[]).length;
  var todayCnt = countTodayRecords(mid);
  var todayBadge = todayCnt > 0 ? '<div class="s-today">'+todayCnt+'</div>' : '';
  return '<div class="scene-card" data-name="'+meta.name+'" onclick="openScene(\''+mid+'\')"><div class="s-ic">'+meta.icon+'</div><div class="s-nm">'+meta.name+'</div><div class="s-cnt">'+cnt+'条</div>'+todayBadge+'</div>';
}
function countTodayRecords(mid){
  var data = dataCache[mid] || [];
  var today = new Date().toISOString().split('T')[0];
  return data.filter(function(r){ return (r.date||r.created||'').indexOf(today) === 0; }).length;
}
function renderRecToday(){
  var c = document.getElementById('recToday');
  if(!c) return;
  var today = new Date().toISOString().split('T')[0];
  var parts = [];
  var totalToday = 0;
  Object.keys(MODULE_META).forEach(function(mid){
    var n = countTodayRecords(mid);
    if(n > 0){
      totalToday += n;
      parts.push('<span class="rt-item">'+MODULE_META[mid].icon+' '+MODULE_META[mid].name+' <span class="rt-num">'+n+'</span></span>');
    }
  });
  if(totalToday === 0){
    c.innerHTML = '<span class="rt-empty">今日还没记录，点下面任一模块开始</span>';
  } else {
    c.innerHTML = '<span class="rt-item">📝 今日</span>' + parts.join('<span style="color:#D1D5DB">·</span>') + '<span class="rt-item">共 <span class="rt-num">'+totalToday+'</span> 条</span>';
  }
}
function filterScenes(q){
  q = (q||'').trim().toLowerCase();
  if(!q){
    // 无搜索词时恢复全部显示
    document.querySelectorAll('.rec-group').forEach(function(g){ g.classList.remove('hidden'); });
    document.querySelectorAll('.scene-card').forEach(function(c){ c.style.display=''; });
    document.getElementById('searchResults') && (document.getElementById('searchResults').style.display='none');
    return;
  }
  // 全文搜索：遍历所有模块的记录内容
  var hits = [];
  var allMods = Object.keys(MODULE_META).concat(['spirit','medical','body','learn']);
  allMods.forEach(function(mid){
    var recs = dataCache[mid] || [];
    recs.forEach(function(r){
      var text = JSON.stringify(r).toLowerCase();
      if(text.indexOf(q) !== -1){
        hits.push({ mid:mid, name:(MODULE_META[mid]||{name:mid}).name, rec:r });
      }
    });
  });
  // 同时过滤场景卡
  document.querySelectorAll('.rec-group').forEach(function(g){
    var anyVisible = false;
    g.querySelectorAll('.scene-card').forEach(function(card){
      var name = (card.getAttribute('data-name')||'').toLowerCase();
      var match = name.indexOf(q) !== -1;
      card.style.display = match ? '' : 'none';
      if(match) anyVisible = true;
    });
    g.classList.toggle('hidden', !anyVisible);
  });
  // 展示搜索结果面板
  var sr = document.getElementById('searchResults');
  if(!sr) return;
  sr.style.display = hits.length > 0 ? 'block' : 'block';
  if(hits.length === 0){
    sr.innerHTML = '<div style="padding:12px;text-align:center;color:#888;font-size:13px;">未找到包含"' + escapeHtml(q) + '"的记录</div>';
  } else {
    sr.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#888;">找到 ' + hits.length + ' 条匹配记录</div>' +
      hits.slice(0,50).map(function(h){
        var title = h.rec.content || h.rec.symptom || h.rec.task || h.rec.person || h.rec.name || h.rec.title || h.rec.note || '(无标题)';
        var date = h.rec.date || (h.rec.created||'').split('T')[0] || '';
        return '<div class="search-hit" data-mid="'+escapeHtml(h.mid)+'" onclick="openScene(\''+escapeHtml(h.mid)+'\')" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;cursor:pointer;">'+
          '<span style="font-size:12px;color:#999;">'+escapeHtml(date)+'</span> '+
          '<span style="font-weight:600;font-size:14px;">'+escapeHtml(String(title).substring(0,60))+'</span> '+
          '<span style="font-size:12px;color:#aaa;">'+escapeHtml(h.name)+'</span></div>';
      }).join('');
  }
}

function renderInsight(){
  var c=document.getElementById('insightSummary');
  if(!c) return;
  var summary='';
  if(insightsCache && insightsCache.growth){
    var g=insightsCache.growth;
    summary='<div style="background:var(--c-accent);border-radius:14px;padding:14px 16px;margin-bottom:16px;border:1px solid var(--c-border);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-size:14px;font-weight:700;color:var(--c-primary)">'+escapeHtml(g.phase)+'</span><span style="font-size:11px;color:var(--c-fg-3)">'+g.progress+'%</span></div><div style="font-size:12px;color:#4B5563;">'+escapeHtml(g.phaseDesc)+' · 下一里程碑：'+escapeHtml(g.nextMilestone)+'</div><div style="margin-top:8px;height:4px;background:#E5E7EB;border-radius:4px;overflow:hidden"><div style="height:100%;width:'+g.progress+'%;background:linear-gradient(90deg,var(--c-primary),var(--c-primary-2));border-radius:4px"></div></div></div>';
    if(insightsCache.correlations && insightsCache.correlations.length>0){
      summary+='<div style="background:var(--c-surface);border-radius:14px;padding:12px 16px;margin-bottom:16px;"><div style="font-size:12px;font-weight:600;color:var(--c-fg-2);margin-bottom:6px">🔗 发现关联</div>';
      insightsCache.correlations.slice(0,2).forEach(function(corr){ summary+='<div class="corr-item"><div class="title">'+escapeHtml(corr.title)+'</div><div class="detail">'+escapeHtml(corr.detail)+'</div></div>'; });
      summary+='</div>';
    }
    if(insightsCache.suggestions && insightsCache.suggestions.length>0){
      // 先把建议暂存到全局，用 data-idx 做事件委托，避免 onclick 字符串引号拼接漏洞
      window.__SUG_CACHE__ = insightsCache.suggestions;
      summary+='<div style="background:rgba(251,191,36,0.04);border-radius:14px;padding:12px 16px;margin-bottom:16px;border-left:3px solid #FBBF24;"><div style="font-size:12px;font-weight:600;color:var(--c-fg-2);margin-bottom:6px">💡 今日建议 <span style="font-size:10px;color:var(--c-fg-3)">点「+任务」加入待办</span></div>';
      insightsCache.suggestions.slice(0,3).forEach(function(s, i){
        summary+='<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px dashed #F3F4F6;">';
        summary+='<div style="font-size:12px;color:var(--c-fg-2);flex:1;">• '+(s.text||'').replace(/[<>&]/g,'')+'</div>';
        summary+='<button data-sug-idx="'+i+'" class="btn-sug-todo" style="font-size:10px;color:#2563EB;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.2);border-radius:6px;padding:2px 8px;cursor:pointer;margin-left:8px;white-space:nowrap;">+任务</button>';
        summary+='</div>';
      });
      summary+='</div>';
      // 延迟绑定事件委托（因为要等 innerHTML 写入 DOM 后才找得到按钮）
      setTimeout(function(){
        document.querySelectorAll('.btn-sug-todo').forEach(function(btn){
          btn.removeEventListener('click', btn.__handler || function(){});
          btn.__handler = function(){
            var idx = parseInt(btn.getAttribute('data-sug-idx'), 10);
            var s = (window.__SUG_CACHE__ || [])[idx];
            if(s) suggestionToTodo(encodeURIComponent(s.text), s.module || null);
          };
          btn.addEventListener('click', btn.__handler);
        });
      }, 50);
    }
  }
  if(!summary) summary='<div class="empty"><span class="ic">🔮</span>继续记录，系统会生成洞察</div>';
  // 只更新 summary 容器，不再拼接到整个 innerHTML（修复累积渲染 bug）
  c.innerHTML=summary;
  loadCognitiveCounts();
  // 加载认知仪表盘（异步，不阻塞）
  loadEngDashboard();
}

// ============ v6.4.2 认知仪表盘 ============
var engDashboardCache = null;
var engDashboardLoading = false;
async function loadEngDashboard(force){
  if(engDashboardLoading) return;
  if(engDashboardCache && !force) { renderEngDashboard(); return; }
  engDashboardLoading = true;
  var el = document.getElementById('engDashboard');
  if(!el) return;
  el.innerHTML = '<div style="padding:12px;text-align:center;color:var(--c-fg-3);font-size:12px;">🔄 加载认知仪表盘...</div>';
  try {
    var resp = await fetch('/api/eng/dashboard');
    var res = await resp.json();
    if(res && res.sections){
      engDashboardCache = res;
      renderEngDashboard();
    } else {
      el.innerHTML = '';
    }
  } catch(e){
    el.innerHTML = '<div style="padding:8px 12px;font-size:11px;color:var(--c-fg-3);">认知仪表盘暂不可用</div>';
  } finally {
    engDashboardLoading = false;
  }
}

function renderEngDashboard(){
  var el = document.getElementById('engDashboard');
  if(!el || !engDashboardCache) return;
  var s = engDashboardCache.sections;
  var html = '';

  // 风险预警
  if(s.risks && s.risks.length){
    html += '<div style="background:rgba(239,68,68,0.06);border-radius:14px;padding:12px 16px;margin-bottom:12px;border-left:3px solid #EF4444;">';
    html += '<div style="font-size:12px;font-weight:700;color:#EF4444;margin-bottom:6px;">⚠️ 风险预警 ('+s.risks.length+')</div>';
    s.risks.slice(0,3).forEach(function(r){
      var title = r.title || r.t || r.type || '风险';
      var detail = r.detail || r.desc || r.message || '';
      html += '<div style="font-size:12px;color:var(--c-fg-2);padding:3px 0;">• <b>'+String(title).substring(0,40)+'</b>'+(detail?'<span style="color:var(--c-fg-2)"> '+String(detail).substring(0,60)+'</span>':'')+'</div>';
    });
    if(s.risks.length > 3) html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:4px;">还有 '+(s.risks.length-3)+' 项...</div>';
    html += '</div>';
  }

  // 自我画像
  if(s.selfPortrait){
    var sp = s.selfPortrait;
    var portraitText = sp.summary || sp.portrait || sp.description || sp.narrative || '';
    if(portraitText){
      html += '<div style="background:var(--c-accent);border-radius:14px;padding:12px 16px;margin-bottom:12px;border:1px solid var(--c-border);">';
      html += '<div style="font-size:12px;font-weight:700;color:var(--c-primary);margin-bottom:6px;">🪞 自我画像</div>';
      html += '<div style="font-size:12px;color:var(--c-fg-2);line-height:1.6;">'+String(portraitText).substring(0,200)+'</div>';
      html += '</div>';
    }
  }

  // 品格雷达图（阶段4）
  if(s.characterRadar && s.characterRadar.current){
    var cr = s.characterRadar;
    var crAvg = cr.average !== undefined ? cr.average.toFixed(1) : '-';
    html += '<div style="background:var(--c-surface);border-radius:14px;padding:12px 16px;margin-bottom:12px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-size:12px;font-weight:600;color:var(--c-fg-2);">⬢ 品格雷达</span><span style="font-size:14px;font-weight:700;color:var(--c-primary);">'+crAvg+'/10</span></div>';
    html += '<div id="radarCharacter"></div>';
    if(cr.interpretation){
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:6px;line-height:1.5;white-space:pre-line">'+String(cr.interpretation).substring(0,120)+'</div>';
    }
    html += '</div>';
  }

  // 反熵增
  if(s.entropy){
    var ent = s.entropy;
    var entScore = ent.score !== undefined ? ent.score : (ent.entropy !== undefined ? ent.entropy : '-');
    var entSignals = ent.signals || ent.dimensions || [];
    html += '<div style="background:var(--c-surface);border-radius:14px;padding:12px 16px;margin-bottom:12px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-size:12px;font-weight:600;color:var(--c-fg-2);">📉 反熵增</span><span style="font-size:14px;font-weight:700;color:'+(typeof entScore==='number' && entScore>50?'#EF4444':'#10B981')+';">'+entScore+'</span></div>';
    if(entSignals && entSignals.length){
      entSignals.slice(0,2).forEach(function(sig){
        var sigText = sig.signal || sig.name || sig.dimension || '';
        if(sigText) html += '<div style="font-size:11px;color:var(--c-fg-2);padding:2px 0;">• '+String(sigText).substring(0,50)+'</div>';
      });
    }
    html += '</div>';
  }

  // 反脆弱
  if(s.antifragile){
    var af = s.antifragile;
    var afAvg = af.average || af.avg || af.score || '-';
    var afWeakest = af.weakest || af.shortboard || null;
    var afDims = af.dimensions || af.scores || [];
    html += '<div style="background:var(--c-surface);border-radius:14px;padding:12px 16px;margin-bottom:12px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-size:12px;font-weight:600;color:var(--c-fg-2);">🛡️ 反脆弱</span><span style="font-size:14px;font-weight:700;color:var(--c-primary);">'+afAvg+'</span></div>';
    if(afDims && afDims.length){
      html += '<div id="afBars"></div>';
    }
    if(afWeakest){
      var weakName = afWeakest.name || afWeakest.dimension || '短板';
      var weakScore = afWeakest.score !== undefined ? afWeakest.score : '';
      html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:6px;">短板：'+String(weakName)+(weakScore!==''?' ('+weakScore+'/10)':'')+'</div>';
    }
    html += '</div>';
  }

  // 轨迹
  if(s.trajectory){
    var tr = s.trajectory;
    var trTrend = tr.trend || tr.direction || '-';
    var trChange = tr.change !== undefined ? tr.change : (tr.delta !== undefined ? tr.delta : '');
    html += '<div style="background:var(--c-surface);border-radius:14px;padding:12px 16px;margin-bottom:12px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-size:12px;font-weight:600;color:var(--c-fg-2);">📈 30天轨迹</span><span style="font-size:12px;color:'+(trTrend==='up'?'var(--c-success)':(trTrend==='down'?'var(--c-danger)':'var(--c-fg-3)'))+';font-weight:600;">'+(trTrend==='up'?'↑上升':(trTrend==='down'?'↓下降':'→平稳'))+(trChange!==''?' '+trChange:'')+'</span></div>';
    html += '<div id="trajLine"></div>';
    html += '</div>';
  }

  // 元认知 + 认知偏差 横排
  var hasMeta = s.metacognition && s.metacognition.score !== undefined;
  var hasBias = s.cognitiveBias && (s.cognitiveBias.biases || s.cognitiveBias.items || s.cognitiveBias.score !== undefined);
  if(hasMeta || hasBias){
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">';
    if(hasMeta){
      var ms = s.metacognition.score;
      html += '<div style="background:var(--c-surface);border-radius:12px;padding:10px 12px;"><div style="font-size:11px;color:var(--c-fg-2);">🔄 元认知</div><div style="font-size:16px;font-weight:700;color:var(--c-primary);margin-top:2px;">'+ms+'</div></div>';
    }
    if(hasBias){
      var biases = s.cognitiveBias.biases || s.cognitiveBias.items || [];
      var biasScore = s.cognitiveBias.score !== undefined ? s.cognitiveBias.score : biases.length;
      html += '<div style="background:var(--c-surface);border-radius:12px;padding:10px 12px;"><div style="font-size:11px;color:var(--c-fg-2);">🎭 偏差检测</div><div style="font-size:16px;font-weight:700;color:#F59E0B;margin-top:2px;">'+biasScore+'</div></div>';
    }
    html += '</div>';
  }

  // 自动复盘（本周）
  if(s.autoReview && s.autoReview.summary){
    html += '<div style="background:rgba(16,185,129,0.06);border-radius:14px;padding:12px 16px;margin-bottom:12px;border-left:3px solid #10B981;">';
    html += '<div style="font-size:12px;font-weight:700;color:#10B981;margin-bottom:4px;">📅 本周复盘</div>';
    html += '<div style="font-size:12px;color:var(--c-fg-2);line-height:1.5;">'+String(s.autoReview.summary).substring(0,150)+'</div>';
    html += '</div>';
  }

  // 反人性 + 价值观 横排
  var hasAnti = s.antiHumanNature && (s.antiHumanNature.score !== undefined || s.antiHumanNature.summary);
  var hasValues = s.valuesClarification && (s.valuesClarification.score !== undefined || s.valuesClarification.values);
  if(hasAnti || hasValues){
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">';
    if(hasAnti){
      var antiScore = s.antiHumanNature.score !== undefined ? s.antiHumanNature.score : '-';
      html += '<div style="background:var(--c-surface);border-radius:12px;padding:10px 12px;"><div style="font-size:11px;color:var(--c-fg-2);">🚫 反人性</div><div style="font-size:16px;font-weight:700;color:var(--c-primary-2);margin-top:2px;">'+antiScore+'</div></div>';
    }
    if(hasValues){
      var valScore = s.valuesClarification.score !== undefined ? s.valuesClarification.score : (s.valuesClarification.values ? s.valuesClarification.values.length : '-');
      html += '<div style="background:var(--c-surface);border-radius:12px;padding:10px 12px;"><div style="font-size:11px;color:var(--c-fg-2);">🎯 价值观</div><div style="font-size:16px;font-weight:700;color:#EC4899;margin-top:2px;">'+valScore+'</div></div>';
    }
    html += '</div>';
  }

  // v6.5.9 周对周/月对月数据对比图
  html += renderTrendComparison();

  // 即使没有数据，也至少显示一张说明性卡片，让用户知道功能在正常工作
  if(!html){
    html = '<div style="background:linear-gradient(135deg,#EEF2FF 0%,#E0E7FF 100%);border-radius:14px;padding:14px 16px;margin-bottom:8px;">';
    html += '<div style="font-size:12px;font-weight:700;color:var(--c-primary);margin-bottom:4px;">📊 认知仪表盘已就绪</div>';
    html += '<div style="font-size:11px;color:var(--c-fg-2);line-height:1.5;">暂无足够数据生成深度分析。连续记录几天后，这里会出现：风险预警、自我画像、反熵增、反脆弱、30天轨迹、元认知、认知偏差等洞察。</div>';
    html += '</div>';
  }
  // 标题栏（总是显示）
  var header = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:0 4px;"><div style="font-size:11px;font-weight:700;color:var(--c-fg-3);letter-spacing:0.5px;">🧠 认知仪表盘'+(engDashboardCache && engDashboardCache.sampleSize !== undefined ? ' · '+engDashboardCache.sampleSize+'条样本' : '')+'</div><button onclick="loadEngDashboard(true)" style="font-size:10px;color:var(--c-primary);background:transparent;border:1px solid rgba(44,62,92,0.2);border-radius:6px;padding:2px 8px;cursor:pointer;">↻ 刷新</button></div>';
  el.innerHTML = header + html;

  // 阶段4：图表可视化（SVG，异步渲染避免阻塞）
  setTimeout(function(){
    // 品格雷达图
    if(s.characterRadar && s.characterRadar.current){
      renderRadarChart('radarCharacter', s.characterRadar);
    }
    // 30天轨迹迷你折线
    if(s.trajectory && s.trajectory.samples){
      renderMiniLine('trajLine', s.trajectory.samples);
    }
    // 反脆弱条形图
    if(s.antifragile && s.antifragile.dimensions){
      renderBarChart('afBars', s.antifragile.dimensions);
    }
  }, 50);
}

// ============ v6.5.9 周对周/月对月数据对比 ============
function renderTrendComparison() {
  // 统计本周 vs 上周、本月 vs 上月的记录数
  var now = new Date();
  var thisWeekStart = new Date(now); thisWeekStart.setDate(now.getDate() - now.getDay()); thisWeekStart.setHours(0,0,0,0);
  var lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  var thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  var modules = ['finance','sleep','exercise','emotion','diet','diary','learn','todo','health','pet'];
  var thisWeek = 0, lastWeek = 0, thisMonth = 0, lastMonth = 0;

  for (var i = 0; i < modules.length; i++) {
    var data = dataCache[modules[i]] || [];
    for (var j = 0; j < data.length; j++) {
      var ts = new Date(data[j].created || data[j].date || '').getTime();
      if (isNaN(ts)) continue;
      if (ts >= thisWeekStart.getTime()) thisWeek++;
      else if (ts >= lastWeekStart.getTime()) lastWeek++;
      if (ts >= thisMonthStart.getTime()) thisMonth++;
      else if (ts >= lastMonthStart.getTime() && ts <= lastMonthEnd.getTime()) lastMonth++;
    }
  }

  // 至少有一些数据才显示
  if (thisWeek + lastWeek + thisMonth + lastMonth === 0) return '';

  var weekDelta = thisWeek - lastWeek;
  var monthDelta = thisMonth - lastMonth;
  var weekPct = lastWeek > 0 ? Math.round((weekDelta / lastWeek) * 100) : (thisWeek > 0 ? 100 : 0);
  var monthPct = lastMonth > 0 ? Math.round((monthDelta / lastMonth) * 100) : (thisMonth > 0 ? 100 : 0);

  function trendArrow(delta) { return delta > 0 ? '↑' : delta < 0 ? '↓' : '→'; }
  function trendColor(delta) { return delta > 0 ? 'var(--c-success,#10B981)' : delta < 0 ? 'var(--c-danger,#EF4444)' : 'var(--c-fg-3)'; }

  // 简单柱状对比图（CSS div-based）
  var maxWeek = Math.max(thisWeek, lastWeek, 1);
  var maxMonth = Math.max(thisMonth, lastMonth, 1);
  var weekBarH = 60, monthBarH = 60;

  var html = '<div style="background:var(--c-surface);border-radius:14px;padding:12px 16px;margin-bottom:12px;">';
  html += '<div style="font-size:12px;font-weight:600;color:var(--c-fg-2);margin-bottom:10px;">📊 数据对比</div>';

  // 周对比
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:12px;">';
  html += '<div style="flex:1;">';
  html += '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:4px;">本周 vs 上周</div>';
  html += '<div style="display:flex;align-items:flex-end;gap:6px;height:' + weekBarH + 'px;">';
  html += '<div style="flex:1;text-align:center;"><div style="background:var(--c-accent,#E8A838);border-radius:4px 4px 0 0;height:' + Math.max(4, (thisWeek/maxWeek)*weekBarH) + 'px;transition:height 0.3s;"></div><div style="font-size:11px;color:var(--c-fg);margin-top:2px;font-weight:600;">' + thisWeek + '</div><div style="font-size:9px;color:var(--c-fg-3);">本周</div></div>';
  html += '<div style="flex:1;text-align:center;"><div style="background:var(--c-border,#E5E7EB);border-radius:4px 4px 0 0;height:' + Math.max(4, (lastWeek/maxWeek)*weekBarH) + 'px;transition:height 0.3s;"></div><div style="font-size:11px;color:var(--c-fg-2);margin-top:2px;">' + lastWeek + '</div><div style="font-size:9px;color:var(--c-fg-3);">上周</div></div>';
  html += '</div>';
  html += '</div>';
  html += '<div style="text-align:right;"><span style="font-size:18px;font-weight:700;color:' + trendColor(weekDelta) + ';">' + trendArrow(weekDelta) + '</span><span style="font-size:12px;color:' + trendColor(weekDelta) + ';font-weight:600;">' + (weekDelta > 0 ? '+' : '') + weekDelta + '</span><div style="font-size:10px;color:var(--c-fg-3);">' + (weekPct > 0 ? '+' : '') + weekPct + '%</div></div>';
  html += '</div>';

  // 月对比
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-end;">';
  html += '<div style="flex:1;">';
  html += '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:4px;">本月 vs 上月</div>';
  html += '<div style="display:flex;align-items:flex-end;gap:6px;height:' + monthBarH + 'px;">';
  html += '<div style="flex:1;text-align:center;"><div style="background:var(--c-primary,#2C3E5C);border-radius:4px 4px 0 0;height:' + Math.max(4, (thisMonth/maxMonth)*monthBarH) + 'px;transition:height 0.3s;"></div><div style="font-size:11px;color:var(--c-fg);margin-top:2px;font-weight:600;">' + thisMonth + '</div><div style="font-size:9px;color:var(--c-fg-3);">本月</div></div>';
  html += '<div style="flex:1;text-align:center;"><div style="background:var(--c-border,#E5E7EB);border-radius:4px 4px 0 0;height:' + Math.max(4, (lastMonth/maxMonth)*monthBarH) + 'px;transition:height 0.3s;"></div><div style="font-size:11px;color:var(--c-fg-2);margin-top:2px;">' + lastMonth + '</div><div style="font-size:9px;color:var(--c-fg-3);">上月</div></div>';
  html += '</div>';
  html += '</div>';
  html += '<div style="text-align:right;"><span style="font-size:18px;font-weight:700;color:' + trendColor(monthDelta) + ';">' + trendArrow(monthDelta) + '</span><span style="font-size:12px;color:' + trendColor(monthDelta) + ';font-weight:600;">' + (monthDelta > 0 ? '+' : '') + monthDelta + '</span><div style="font-size:10px;color:var(--c-fg-3);">' + (monthPct > 0 ? '+' : '') + monthPct + '%</div></div>';
  html += '</div>';

  html += '</div>';
  return html;
}

// ============ 阶段4：SVG 图表可视化 ============
function renderRadarChart(containerId, data){
  var el = document.getElementById(containerId);
  if(!el || !data.current) return;
  var dims = data.evolution || [];
  if(!dims.length) return;
  var labels = dims.map(function(d){ return d.label || d.dim; });
  var values = dims.map(function(d){ return d.current || 0; });
  var prevValues = dims.map(function(d){ return d.previous; });
  var hasPrev = prevValues.some(function(v){ return v !== null && v !== undefined; });

  var size = 220, cx = size/2, cy = size/2, R = 80;
  var n = values.length;
  var angle = function(i){ return -Math.PI/2 + i * 2 * Math.PI / n; };
  var point = function(v, i){ return [cx + R * v/10 * Math.cos(angle(i)), cy + R * v/10 * Math.sin(angle(i))]; };

  // 网格（4层）
  var grid = '';
  for(var layer = 1; layer <= 4; layer++){
    var r = R * layer / 4;
    var pts = '';
    for(var i = 0; i < n; i++) pts += (cx + r * Math.cos(angle(i))) + ',' + (cy + r * Math.sin(angle(i))) + ' ';
    grid += '<polygon points="'+pts.trim()+'" fill="none" stroke="var(--c-border)" stroke-width="0.5"/>';
  }
  // 轴线
  var axes = '';
  for(var i = 0; i < n; i++){
    var ex = cx + R * Math.cos(angle(i));
    var ey = cy + R * Math.sin(angle(i));
    axes += '<line x1="'+cx+'" y1="'+cy+'" x2="'+ex+'" y2="'+ey+'" stroke="var(--c-border)" stroke-width="0.5"/>';
  }
  // 标签
  var labelText = '';
  for(var i = 0; i < n; i++){
    var lx = cx + (R + 16) * Math.cos(angle(i));
    var ly = cy + (R + 16) * Math.sin(angle(i));
    labelText += '<text x="'+lx+'" y="'+ly+'" text-anchor="middle" dominant-baseline="middle" fill="var(--c-fg-2)" style="font-size:10px;font-family:sans-serif">'+labels[i]+'</text>';
  }
  // 前次数据（虚线）
  var prevPoly = '';
  if(hasPrev){
    var ppts = '';
    for(var i = 0; i < n; i++){
      var v = prevValues[i] || 0;
      var p = point(v, i);
      ppts += p[0] + ',' + p[1] + ' ';
    }
    prevPoly = '<polygon points="'+ppts.trim()+'" fill="none" stroke="var(--c-fg-muted)" stroke-width="1" stroke-dasharray="3,3" opacity="0.6"/>';
  }
  // 当前数据（填充）
  var cpts = '';
  for(var i = 0; i < n; i++){
    var p = point(values[i], i);
    cpts += p[0] + ',' + p[1] + ' ';
  }
  var curPoly = '<polygon points="'+cpts.trim()+'" fill="var(--c-primary)" fill-opacity="0.2" stroke="var(--c-primary)" stroke-width="1.5"/>';
  // 数据点
  var dots = '';
  for(var i = 0; i < n; i++){
    var p = point(values[i], i);
    dots += '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="2.5" fill="var(--c-primary)"/>';
  }

  el.innerHTML = '<svg viewBox="0 0 '+size+' '+size+'" style="display:block;margin:0 auto">'+grid+axes+prevPoly+curPoly+dots+labelText+'</svg>';
}

function renderMiniLine(containerId, samples){
  var el = document.getElementById(containerId);
  if(!el || !samples || !samples.length) return;
  var w = 260, h = 50, pad = 6;
  var vals = samples.map(function(s){ return s.value || s.score || s.count || 0; });
  var max = Math.max.apply(null, vals);
  var min = Math.min.apply(null, vals);
  var range = max - min || 1;
  var stepX = (w - pad*2) / (vals.length - 1 || 1);
  var pts = '';
  for(var i = 0; i < vals.length; i++){
    var x = pad + i * stepX;
    var y = h - pad - (vals[i] - min) / range * (h - pad*2);
    pts += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
  }
  // 填充区域
  var area = pts + 'L'+(w-pad)+','+(h-pad)+' L'+pad+','+(h-pad)+' Z';
  el.innerHTML = '<svg viewBox="0 0 '+w+' '+h+'" style="display:block;width:100%;height:50px"><path d="'+area+'" fill="var(--c-primary)" fill-opacity="0.1"/><path d="'+pts+'" fill="none" stroke="var(--c-primary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function renderBarChart(containerId, dimensions){
  var el = document.getElementById(containerId);
  if(!el || !dimensions || !dimensions.length) return;
  var html = '';
  dimensions.forEach(function(d){
    var name = d.name || d.label || d.dim || '';
    var score = d.score !== undefined ? d.score : (d.value || 0);
    var pct = Math.min(100, Math.max(0, score * 10));
    var color = score >= 7 ? 'var(--c-success)' : (score >= 4 ? 'var(--c-primary)' : 'var(--c-danger)');
    html += '<div style="margin-bottom:8px">';
    html += '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px"><span style="color:var(--c-fg-2)">'+name+'</span><span style="color:var(--c-fg);font-weight:600">'+score+'/10</span></div>';
    html += '<div style="height:5px;background:var(--c-surface-2);border-radius:3px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:3px;transition:width 0.6s var(--ease-out)"></div></div>';
    html += '</div>';
  });
  el.innerHTML = html;
}

// ============ v6.4.2 行动闭环 ============
// 建议转任务
async function suggestionToTodo(encodedText, module){
  var text = decodeURIComponent(encodedText);
  if(!confirm('将此建议转为待办任务？\n\n"' + text.substring(0, 50) + '"')) return;
  try {
    var resp = await fetch('/api/suggestion/to-todo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, module: module || null, priority: '中-重要' })
    });
    var res = await resp.json();
    if(res && res.success){
      alert('✅ 已加入待办：' + text.substring(0, 30) + '...');
      // 刷新 todo 数据缓存
      fetch('/api/todo').then(function(r){return r.json();}).then(function(d){ dataCache.todo = d || []; }).catch(function(){});
    } else {
      alert(res && res.duplicate ? 'ℹ️ ' + (res.message || '已转过') : '❌ ' + (res && res.message || '失败'));
    }
  } catch(e){
    alert('网络错误：' + e.message);
  }
}

// todo 状态切换（在 todo 详情页提供快速切换按钮）
async function setTodoStatus(id, status){
  try {
    var resp = await fetch('/api/todo/' + id + '/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status })
    });
    var res = await resp.json();
    if(res && res.success){
      // 本地更新缓存
      var list = dataCache.todo || [];
      var idx = list.findIndex(function(t){ return String(t.id) === String(id); });
      if(idx >= 0){
        list[idx].status = status;
        if(status === '已完成') list[idx].completedAt = new Date().toISOString();
        else delete list[idx].completedAt;
        list[idx].updatedAt = new Date().toISOString();
      }
      // 重新渲染当前场景
      if(typeof renderSceneList === 'function') renderSceneList('todo');
    } else {
      alert(res && res.message || '状态更新失败');
    }
  } catch(e){
    alert('网络错误：' + e.message);
  }
}

function renderMe(){
  var c = document.getElementById('meHeader');
  if(!c) return;
  var total = 0;
  SCENES.forEach(function(s){ total += (dataCache[s.id]||[]).length; });
  CORE_MODULES.forEach(function(m){ total += (dataCache[m.id]||[]).length; });
  var header='<div style="background:var(--c-accent);border-radius:14px;padding:12px 16px;margin-bottom:16px;border:1px solid var(--c-border);"><div style="display:flex;justify-content:space-between;align-items:center;"><span style="font-size:13px;font-weight:600;color:var(--c-fg);">📊 船长日志</span><span style="font-size:12px;color:var(--c-primary);font-weight:700;">共 '+total+' 条记录</span></div></div>';
  // 只更新 header 容器，不再拼接到整个 innerHTML（修复累积渲染 bug）
  c.innerHTML=header;
  loadCognitiveCounts();
}

async function changePwd(){
  var cp = prompt('请输入当前密码：');
  if(!cp) return;
  var np = prompt('请输入新密码（至少4位）：');
  if(!np) return;
  if(np.length < 4){ alert('新密码至少4位'); return; }
  var np2 = prompt('请再次输入新密码确认：');
  if(np !== np2){ alert('两次输入不一致，已取消'); return; }
  try {
    var r = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: cp, newPassword: np })
    });
    var j = await r.json();
    if (j.success) {
      TOKEN = j.token;
      localStorage.setItem(TOKEN_KEY, j.token);
      alert('✅ 密码已修改');
    } else {
      alert('❌ ' + (j.message || '修改失败'));
    }
  } catch(e) { alert('网络错误：' + e.message); }
}
function exportData(){
  var all={};
  SCENES.forEach(function(s){ all[s.id]=dataCache[s.id]||[]; });
  CORE_MODULES.forEach(function(m){ all[m.id]=dataCache[m.id]||[]; });
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(all,null,2)],{type:'application/json'}));
  a.download='qiezi_backup_'+TODAY+'.json';
  a.click();
}
// v6.5.8 导出 CSV：把所有模块数据合并为一个 CSV 文件，可用 Excel 打开
function exportCSV(){
  var allModules = SCENES.concat(CORE_MODULES);
  var rows = [];
  // 表头
  rows.push('模块,日期,内容摘要,详情');
  allModules.forEach(function(mod) {
    var data = dataCache[mod.id] || [];
    data.forEach(function(item) {
      var date = item.date || item.createdAt || '';
      var summary = (item.content || item.text || item.note || item.description || item.name || '').replace(/"/g, '""');
      var detail = JSON.stringify(item).replace(/"/g, '""');
      rows.push('"' + mod.name + '","' + date + '","' + summary + '","' + detail + '"');
    });
  });
  // 添加 BOM 以便 Excel 正确识别 UTF-8
  var csvContent = '\uFEFF' + rows.join('\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8' }));
  a.download = 'qiezi_export_' + TODAY + '.csv';
  a.click();
  alert('✅ CSV 已导出（' + (rows.length - 1) + ' 条记录），可用 Excel 打开');
}

// ============ v6.5.9 提醒系统 ============
var _reminderCheckTimer = null;

function openReminderCenter() {
  document.getElementById('reminderMask').classList.add('act');
  document.getElementById('reminderDrawer').classList.add('act');
  renderReminderList();
}
function closeReminderCenter() {
  document.getElementById('reminderMask').classList.remove('act');
  document.getElementById('reminderDrawer').classList.remove('act');
}

function addReminder() {
  var title = document.getElementById('reminderTitle').value.trim();
  var date = document.getElementById('reminderDate').value;
  var time = document.getElementById('reminderTime').value;
  var repeat = document.getElementById('reminderRepeat').value;
  if (!title) { alert('请输入提醒内容'); return; }
  if (!date || !time) { alert('请选择日期和时间'); return; }
  var datetime = date + 'T' + time + ':00';
  var reminders = dataCache['reminder'] || [];
  reminders.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: title,
    datetime: datetime,
    repeat: repeat,
    enabled: true,
    lastTriggered: null,
    createdAt: new Date().toISOString()
  });
  dataCache['reminder'] = reminders;
  apiFetch('reminder', { method: 'POST', body: JSON.stringify(reminders) });
  // 清空表单
  document.getElementById('reminderTitle').value = '';
  document.getElementById('reminderDate').value = '';
  document.getElementById('reminderTime').value = '';
  document.getElementById('reminderRepeat').value = 'none';
  renderReminderList();
  startReminderCheck();
}

function deleteReminder(id) {
  if (!confirm('删除这条提醒？')) return;
  var reminders = (dataCache['reminder'] || []).filter(function(r) { return r.id !== id; });
  dataCache['reminder'] = reminders;
  apiFetch('reminder', { method: 'POST', body: JSON.stringify(reminders) });
  renderReminderList();
}

function toggleReminder(id) {
  var reminders = dataCache['reminder'] || [];
  for (var i = 0; i < reminders.length; i++) {
    if (reminders[i].id === id) {
      reminders[i].enabled = !reminders[i].enabled;
      break;
    }
  }
  dataCache['reminder'] = reminders;
  apiFetch('reminder', { method: 'POST', body: JSON.stringify(reminders) });
  renderReminderList();
}

function renderReminderList() {
  var reminders = dataCache['reminder'] || [];
  var container = document.getElementById('reminderList');
  if (reminders.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--c-fg-2);font-size:13px;padding:20px">暂无提醒</div>';
    return;
  }
  // 按时间排序
  reminders.sort(function(a, b) {
    return new Date(a.datetime).getTime() - new Date(b.datetime).getTime();
  });
  var now = Date.now();
  container.innerHTML = reminders.map(function(r) {
    var dt = new Date(r.datetime);
    var isPast = dt.getTime() < now;
    var isDue = isPast && r.repeat === 'none' && !r.lastTriggered;
    var repeatLabel = r.repeat === 'none' ? '一次性' : r.repeat === 'daily' ? '🔁 每天' : r.repeat === 'weekly' ? '🔁 每周' : '🔁 每月';
    var dateStr = (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
    var bg = isDue ? 'background:rgba(232,88,88,0.1);border:1px solid var(--c-danger,#E85858)' : 'background:var(--c-surface)';
    var opacity = r.enabled === false ? 'opacity:0.45' : '';
    return '<div style="' + bg + ';' + opacity + ';border-radius:12px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:14px;font-weight:600;color:var(--c-fg);margin-bottom:2px">' + escapeHtml(r.title || '未命名') + '</div>' +
        '<div style="font-size:12px;color:var(--c-fg-2)">' + dateStr + ' · ' + repeatLabel + (isDue ? ' · 🔴 已到期' : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0">' +
        '<button onclick="toggleReminder(\'' + escapeHtml(r.id) + '\')" style="background:none;border:none;font-size:16px;cursor:pointer;padding:4px">' + (r.enabled === false ? '🔇' : '🔊') + '</button>' +
        '<button onclick="deleteReminder(\'' + escapeHtml(r.id) + '\')" style="background:none;border:none;font-size:16px;cursor:pointer;padding:4px">🗑️</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// 定时检查到期提醒（每 60 秒）
function startReminderCheck() {
  if (_reminderCheckTimer) return; // 已启动则不重复
  _reminderCheckTimer = setInterval(checkDueReminders, 60000);
  // 首次立即检查
  setTimeout(checkDueReminders, 3000);
}

async function checkDueReminders() {
  var reminders = dataCache['reminder'] || [];
  if (reminders.length === 0) {
    updateReminderBadge(0);
    return;
  }
  try {
    var resp = await fetch('/api/reminders/due');
    var data = await resp.json();
    if (data.success) {
      updateReminderBadge(data.count);
      // 触发浏览器通知
      if (data.count > 0 && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          for (var i = 0; i < data.due.length; i++) {
            var r = data.due[i];
            new Notification('🔔 茄子管家提醒', { body: r.title || '你有到期提醒', icon: '/icon-192.png' });
            // 标记已触发
            markReminderTriggered(r.id);
          }
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission();
        }
      }
    }
  } catch(e) { /* 静默失败 */ }
}

function updateReminderBadge(count) {
  var badge = document.getElementById('remindBadge');
  if (!badge) return;
  if (count > 0) {
    badge.style.display = 'inline-block';
    badge.textContent = count > 9 ? '9+' : String(count);
  } else {
    badge.style.display = 'none';
  }
}

function markReminderTriggered(id) {
  var reminders = dataCache['reminder'] || [];
  for (var i = 0; i < reminders.length; i++) {
    if (reminders[i].id === id) {
      reminders[i].lastTriggered = new Date().toISOString();
      break;
    }
  }
  dataCache['reminder'] = reminders;
  apiFetch('reminder', { method: 'POST', body: JSON.stringify(reminders) });
}
async function restoreLatest(){
  if(!confirm('⚠️ 确定恢复最近备份？\n当前数据会先做一个快照备份，然后恢复到最近一次备份状态。\n恢复后页面自动刷新。')) return;
  try{
    var r=await fetch('/api/backup/restore-latest',{method:'POST'});
    var j=await r.json();
    if(j.success){ alert('✅ 恢复成功：'+(j.file||'')+'\n页面即将刷新...'); setTimeout(function(){location.reload();},1500); }
    else alert('❌ 恢复失败：'+(j.message||''));
  }catch(e){ alert('请求失败：'+e.message); }
}
async function openBackupMgr(){
  var html='<p style="color:var(--c-fg-2);font-size:12px;margin-bottom:10px;">写入数据后5分钟自动备份（防抖），每日至少1份。<br>保留策略：24h内全留 → 1-7天/7-30天每天1份 → 30天外删除。<br><b style="color:#059669;">🔒 v6.9.7+ 备份已加密（AES-256-GCM + SHA256校验）</b></p><div id="bkList" style="max-height:50vh;overflow:auto;"></div>';
  openModal2('📂 备份管理',html);
  try{
    var r=await fetch('/api/backup/list');
    var j=await r.json();
    if(!j.success||!j.backups||!j.backups.length){
      document.getElementById('bkList').innerHTML='<div style="color:var(--c-fg-2);padding:20px;text-align:center;">暂无备份</div>'; return;
    }
    var s='<table style="width:100%;font-size:12px;border-collapse:collapse;">';
    s+='<tr style="background:#F3F4F6;"><th style="padding:6px;text-align:left;">时间</th><th style="padding:6px;text-align:right;">大小</th><th style="padding:6px;">加密</th><th style="padding:6px;">操作</th></tr>';
    j.backups.forEach(function(b){
      var d=new Date(b.mtime);
      var ts=d.getFullYear()+'-'+pad0(d.getMonth()+1)+'-'+pad0(d.getDate())+' '+pad0(d.getHours())+':'+pad0(d.getMinutes())+':'+pad0(d.getSeconds());
      var kb=Math.round(b.size/1024);
      var encBadge = b.encrypted === true ? '<span style="color:#059669;font-weight:600;">🔒 加密</span>' : b.encrypted === false ? '<span style="color:#F59E0B;">⚠️ 明文</span>' : '<span style="color:var(--c-fg-3);">—</span>';
      s+='<tr style="border-bottom:1px solid #F3F4F6;">';
      s+='<td style="padding:8px;">'+ts+'<div style="font-size:10px;color:var(--c-fg-3);">'+(b.source||'')+'</div></td>';
      s+='<td style="padding:8px;text-align:right;">'+kb+'KB</td>';
      s+='<td style="padding:8px;text-align:center;">'+encBadge+'</td>';
      s+='<td style="padding:8px;text-align:center;">';
      s+='<button onclick="restoreBackup(\''+b.file+'\')" style="margin-right:6px;background:#DBEAFE;color:#1E40AF;border:0;padding:4px 8px;border-radius:4px;font-size:11px;cursor:pointer;">恢复</button>';
      s+='<a href="/api/backup/download/'+b.file+'" style="background:#E0F2FE;color:#075985;padding:4px 8px;border-radius:4px;font-size:11px;text-decoration:none;">下载</a>';
      s+='</td></tr>';
    });
    s+='</table>';
    s+='<div style="margin-top:14px;padding:10px;background:#FFFBE7;border-left:3px solid #F59E0B;font-size:11px;color:#92400E;">💡 恢复前系统会自动给当前状态再拍一份快照，可放心操作。明文备份为旧版本生成，可正常恢复但建议尽快生成新的加密备份。</div>';
    document.getElementById('bkList').innerHTML=s;
  }catch(e){ document.getElementById('bkList').innerHTML='<div style="color:#EF4444;">加载失败：'+e.message+'</div>'; }
}
async function restoreBackup(fname){
  if(!confirm('⚠️ 确定恢复该备份？\n当前数据会先做快照备份。')) return;
  try{
    var r=await fetch('/api/backup/restore/'+encodeURIComponent(fname),{method:'POST'});
    var j=await r.json();
    if(j.success){ alert('✅ 恢复成功，页面即将刷新...'); setTimeout(function(){location.reload();},1500); }
    else alert('❌ 恢复失败：'+(j.message||''));
  }catch(e){ alert('请求失败：'+e.message); }
}
function pad0(n){ return n<10?'0'+n:''+n; }
function clearAll(){
  if(!confirm('确定清空全部数据？不可恢复！\n建议先去「📂 备份管理」下载一份备份。')) return;
  if(!confirm('再次确认：所有记录将被永久删除，确定继续？')) return;
  fetch('/api/clear-all', { method:'POST', headers:{'Content-Type':'application/json'} })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if(res.success){
        Object.keys(dataCache).forEach(function(k){ dataCache[k] = []; });
        alert('已清空全部数据'); location.reload();
      } else {
        alert('清空失败：' + (res.message || '未知错误'));
      }
    })
    .catch(function(e){ alert('网络错误：' + e.message); });
}
// v6.6.0 隐私模式：模糊敏感内容，切换时即时生效
function togglePrivacy(){
  privacyOn=!privacyOn;
  document.body.classList.toggle('privacy-mode', privacyOn);
  // 顶部按钮反馈
  var btn = event && event.currentTarget;
  if (btn) btn.style.opacity = privacyOn ? '0.6' : '1';
  // 轻提示（非阻塞）
  showToast(privacyOn ? '👁️ 隐私模式已开启' : '👁️ 隐私模式已关闭');
}

// ============ v6.4.2 运维面板 ============
async function openMaintenance(){
  var d = document.getElementById('detail');
  if(!d){ alert('运维面板初始化失败：detail 元素不存在'); return; }
  document.getElementById('detailTitle').textContent = '🛠️ 运维面板';
  document.getElementById('detailActions').innerHTML = '';
  document.getElementById('detailContent').innerHTML = '<div style="padding:20px;text-align:center;color:var(--c-primary);">🔄 加载中...</div>';
  d.classList.remove('show');
  d.classList.add('act');
  try {
    await loadMaintenanceStatus();
  } catch(e){
    document.getElementById('detailContent').innerHTML = '<div style="padding:20px;text-align:center;color:#EF4444;">加载失败：'+e.message+'</div>';
  }
}

async function loadMaintenanceStatus(){
  var c = document.getElementById('detailContent');
  if(!c) return;
  var html = '<div style="padding:16px;">';

  // 数据库状态卡片（直接用 fetch，绕开 apiFetch 的参数限制）
  try {
    var resp = await fetch('/api/maintenance/status', { headers: authHeaders() });
    var res = await resp.json();
    if(res && res.success){
      var fmt = function(b){ return (b/1024).toFixed(1) + ' KB'; };
      html += '<div style="background:var(--c-surface);border-radius:14px;padding:14px 16px;margin-bottom:12px;">';
      html += '<div style="font-size:13px;font-weight:700;color:var(--c-fg);margin-bottom:10px;">💾 数据库状态</div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;">';
      html += '<div>📦 主库：'+fmt(res.dbSize)+'</div>';
      html += '<div>📝 WAL：'+fmt(res.walSize)+'</div>';
      html += '<div>🗂️ SHM：'+fmt(res.shmSize)+'</div>';
      html += '<div>💾 备份：'+fmt(res.backupSize)+'</div>';
      html += '<div style="grid-column:1/3;">📊 总占用：'+fmt(res.totalSize)+'</div>';
      html += '</div>';
      // VACUUM 建议：碎片率 > 30%
      if(res.dbSize > 0 && res.walSize > res.dbSize * 0.3){
        html += '<div style="margin-top:8px;font-size:11px;color:#F59E0B;">⚠️ WAL 较大，建议执行 VACUUM 压缩</div>';
      }
      html += '</div>';
    }
  } catch(e){
    html += '<div style="color:#EF4444;font-size:12px;padding:8px;">状态获取失败：'+e.message+'</div>';
  }

  // 操作按钮
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px;">';
  html += '<button onclick="runMaintenance()" style="background:#10B981;color:#fff;border:none;border-radius:10px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;">🧹 一键运维</button>';
  html += '<button onclick="runVacuum()" style="background:var(--c-primary);color:#fff;border:none;border-radius:10px;padding:12px;font-size:13px;font-weight:600;cursor:pointer;">🗜️ VACUUM压缩</button>';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:6px;line-height:1.5;">一键运维：WAL合并+PM2日志清理<br>VACUUM：重建数据库文件，回收碎片（较慢）</div>';

  // 备份校验
  html += '<div style="background:var(--c-surface);border-radius:14px;padding:14px 16px;margin-top:16px;">';
  html += '<div style="font-size:13px;font-weight:700;color:var(--c-fg);margin-bottom:10px;">✅ 备份完整性校验</div>';
  html += '<div id="verifyList" style="font-size:12px;color:var(--c-fg-2);">点击下方按钮校验最近备份</div>';
  html += '<button onclick="verifyLatestBackup()" style="margin-top:8px;background:rgba(37,99,235,0.1);color:#2563EB;border:1px solid rgba(37,99,235,0.2);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;">🔍 校验最近备份</button>';
  html += '</div>';

  html += '</div>';
  c.innerHTML = html;
}

async function runMaintenance(){
  if(!confirm('执行一键运维？\n（WAL合并 + PM2日志清理，约需几秒）')) return;
  try {
    var resp = await fetch('/api/maintenance', { method: 'POST' });
    var res = await resp.json();
    if(res && res.success){
      alert('✅ ' + (res.message || '运维完成'));
      await loadMaintenanceStatus();
    } else {
      alert('❌ ' + (res && res.message || '运维失败'));
    }
  } catch(e){
    alert('网络错误：' + e.message);
  }
}

async function runVacuum(){
  if(!confirm('执行 VACUUM？\n数据库较大时可能需要 10-30 秒，期间服务会短暂无响应。')) return;
  try {
    var resp = await fetch('/api/maintenance/vacuum', { method: 'POST' });
    var res = await resp.json();
    if(res && res.success){
      alert('✅ ' + (res.message || 'VACUUM 完成'));
      await loadMaintenanceStatus();
    } else {
      alert('❌ ' + (res && res.message || 'VACUUM 失败'));
    }
  } catch(e){
    alert('网络错误：' + e.message);
  }
}

async function verifyLatestBackup(){
  var resp = await fetch('/api/backup/list');
  var list = await resp.json();
  if(!list || !list.length){
    document.getElementById('verifyList').innerHTML = '<span style="color:#EF4444;">无备份文件</span>';
    return;
  }
  var latest = list[0];
  var el = document.getElementById('verifyList');
  el.innerHTML = '<span style="color:var(--c-fg-2);">🔍 校验中：'+escapeHtml(latest.name)+'...</span>';
  try {
    var r2 = await fetch('/api/backup/verify/' + encodeURIComponent(latest.name), { method: 'POST' });
    var res = await r2.json();
    if(res && res.success){
      var detail = res.fileCount ? '包含 '+res.fileCount+' 个文件' : '校验通过';
      el.innerHTML = '<span style="color:#10B981;">✅ '+escapeHtml(latest.name)+'<br>'+detail+'</span>';
    } else {
      el.innerHTML = '<span style="color:#EF4444;">❌ '+escapeHtml(latest.name)+'<br>'+escapeHtml(res && res.message || '校验失败')+'</span>';
    }
  } catch(e){
    el.innerHTML = '<span style="color:#EF4444;">校验出错：'+escapeHtml(e.message)+'</span>';
  }
}

(function init(){
  document.getElementById('pwdI').focus();
})();

// ============================================================
// 主题切换（深夜书房：暗色默认 + 日间琥珀 + 护眼黄昏，按时段自动）
// ============================================================
function applyAutoTheme() {
  var saved = localStorage.getItem('qz-theme');
  if (saved && saved !== 'dark') { setTheme(saved); return; }
  // 未手动指定：6-17 日间，17-20 护眼，其余暗色（深夜书房默认）
  var h = new Date().getHours();
  if (h >= 6 && h < 17) setTheme('light');
  else if (h >= 17 && h < 20) setTheme('sepia');
  else setTheme('dark');  // 默认暗色（移除 data-theme，回退到 :root）
}
function setTheme(name) {
  if (name === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  localStorage.setItem('qz-theme', name);
  document.querySelectorAll('.theme-btn').forEach(function(b){
    b.classList.toggle('act', b.dataset.theme === name);
  });
}
function toggleTheme() {
  var cur = localStorage.getItem('qz-theme') || 'dark';
  var next = cur === 'dark' ? 'light' : (cur === 'light' ? 'sepia' : 'dark');
  setTheme(next);
}
applyAutoTheme();

// ============================================================
// 闪念笔记 JS
// ============================================================
async function submitQuickNote() {
  var input = document.getElementById('quickNoteInput');
  var text = input.value.trim();
  if (!text) { alert('请写下你的想法'); return; }
  try {
    var res = await fetch('/api/quick-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text })
    });
    var data = await res.json();
    if (data.success) {
      document.getElementById('quickNoteFeedback').textContent = data.message;
      input.value = '';
      setTimeout(function() { document.getElementById('quickNoteFeedback').textContent = ''; }, 5000);
    } else {
      alert('保存失败：' + data.message);
    }
  } catch(e) { alert('网络错误'); }
}

function showQuickNotes() {
  fetch('/api/quick-notes')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var notes = data.slice(0, 15);
      var msg = '📋 闪念笔记（最近15条）：\n\n';
      notes.forEach(function(n) {
        var status = n.classified ? '✅ 已归类' : '💡 建议归入「' + (n.suggestedName || n.suggestedModule) + '」';
        msg += '📝 ' + n.content + '\n' + status + '\n\n';
      });
      alert(msg);
    })
    .catch(function(e) { alert('加载失败'); });
}

// ============================================================
// 缴费管理 JS
// ============================================================
async function loadBills() {
  try {
    var res = await fetch('/api/bills');
    var bills = await res.json();
    var container = document.getElementById('billsList');
    var unpaid = bills.filter(function(b) { return !b.paid; });
    if (unpaid.length === 0) {
      container.innerHTML = '<span style="color:#22C55E;">✅ 暂无待缴费账单</span>';
      return;
    }
    container.innerHTML = unpaid.slice(0, 5).map(function(b) {
      var statusText = b.status === 'overdue' ? '🔴 已过期' : (b.status === 'upcoming' ? '🟡 即将到期' : '⚪');
      var daysText = b.daysRemaining < 0 ? '已过期' + Math.abs(b.daysRemaining) + '天' : '剩余' + b.daysRemaining + '天';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #FFFFFF;"><span style="color:' + (b.status === 'overdue' ? '#EF4444' : b.status === 'upcoming' ? '#FBBF24' : '#CBD5E1') + '">' + escapeHtml(b.name) + ' ¥' + escapeHtml(String(b.amount)) + '</span><span style="font-size:11px;color:var(--c-fg-3);">' + daysText + '</span></div>';
    }).join('');
  } catch(e) { document.getElementById('billsList').textContent = '加载失败'; }
}

function openAddBill() {
  var name = prompt('📝 账单名称（如：电费）：');
  if (!name) return;
  var amount = prompt('💰 金额（元）：');
  if (!amount || isNaN(amount)) return;
  var dueDate = prompt('📅 到期日期（格式：YYYY-MM-DD）：');
  if (!dueDate) return;
  fetch('/api/bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, amount: parseFloat(amount), dueDate: dueDate, period: '每月', category: '生活' })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) { alert('✅ 账单已添加'); loadBills(); }
    else alert('添加失败：' + data.message);
  })
  .catch(function(e) { alert('网络错误'); });
}

// ============================================================
// 阅读打卡 JS
// ============================================================
async function loadReading() {
  try {
    var stats = await fetch('/api/reading/stats').then(function(r) { return r.json(); });
    var readings = await fetch('/api/readings').then(function(r) { return r.json(); });
    document.getElementById('readingStats').innerHTML =
      '<span>📅 本月 ' + stats.monthDays + ' 天</span><span>📚 ' + stats.totalBooks + ' 本书</span><span>📖 ' + stats.totalReadings + ' 次</span>';
    var today = new Date().toISOString().split('T')[0];
    var todayReading = readings.find(function(r) { return r.date === today; });
    document.getElementById('readingToday').textContent = todayReading
      ? '📖 今日已读《' + todayReading.bookName + '》' + (todayReading.progress || 0) + '%'
      : '⏰ 今天还没阅读，去读一会儿吧';
  } catch(e) { console.warn('阅读加载失败', e); }
}

function openAddReading() {
  var bookName = prompt('📚 书名：');
  if (!bookName) return;
  var author = prompt('✍️ 作者（可选）：') || '';
  var progress = prompt('📊 进度（%）：') || 0;
  fetch('/api/reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookName: bookName, author: author, progress: parseInt(progress) || 0, date: new Date().toISOString().split('T')[0] })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) { alert('✅ 阅读打卡成功'); loadReading(); }
    else alert('添加失败：' + data.message);
  })
  .catch(function(e) { alert('网络错误'); });
}

// ============================================================
// 家务引擎 JS
// ============================================================
async function loadHousework() {
  try {
    var res = await fetch('/api/housework');
    var data = await res.json();
    var modeNames = { normal: '正常', busy: '🔴 忙', rest: '🟢 闲' };
    document.getElementById('houseworkModeBadge').textContent = modeNames[data.mode] || '正常';
    var urgent = data.urgent || [];
    var html = '';
    if (urgent.length > 0) {
      html += '<div style="color:#EF4444;font-size:11px;margin-bottom:4px;">⚠️ 逾期任务</div>';
      urgent.slice(0, 3).forEach(function(t) {
        html += '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #FFFFFF;"><span style="color:#EF4444;">' + escapeHtml(t.task) + '</span><button onclick="completeHousework(\'' + escapeHtml(t.id) + '\')" style="background:transparent;border-radius:4px;padding:0 8px;color:var(--c-fg-2);font-size:10px;cursor:pointer;">完成</button></div>';
      });
    } else if (data.mode !== 'busy') {
      html += '<div style="color:#22C55E;font-size:12px;">✅ 今日所有任务已完成</div>';
    } else {
      html += '<div style="color:var(--c-fg-2);font-size:12px;">📌 忙模式：只显示紧急任务</div>';
    }
    document.getElementById('houseworkList').innerHTML = html || '<span style="color:var(--c-fg-3);font-size:12px;">暂无待做任务</span>';
  } catch(e) { document.getElementById('houseworkList').textContent = '加载失败'; }
}

function completeHousework(id) {
  if (!confirm('确认已完成？')) return;
  fetch('/api/housework/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: id })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) { if (data.success) { alert(data.message); loadHousework(); } })
  .catch(function(e) { alert('网络错误'); });
}

function switchHouseworkMode() {
  var modes = ['normal', 'busy', 'rest'];
  var labels = ['正常', '忙（只做紧急）', '闲（全部做）'];
  var choice = prompt('选择模式：\n1. 正常\n2. 忙（只做紧急任务）\n3. 闲（全部任务）', '1');
  if (!choice) return;
  var idx = parseInt(choice) - 1;
  if (idx < 0 || idx > 2) return;
  fetch('/api/housework/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: modes[idx] })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) { if (data.success) { alert(data.message); loadHousework(); } })
  .catch(function(e) { alert('网络错误'); });
}

// ============================================================
// 社交人脉 JS
// ============================================================
async function loadSocial() {
  try {
    var res = await fetch('/api/contacts');
    var contacts = await res.json();
    var container = document.getElementById('socialList');
    if (contacts.length === 0) {
      container.innerHTML = '<span style="color:var(--c-fg-3);font-size:12px;">还没有联系人，点 + 添加</span>';
      return;
    }
    var top = contacts.slice(0, 3);
    container.innerHTML = top.map(function(c) {
      var badge = '';
      if (c.daysUntilBirthday !== null && c.daysUntilBirthday <= 7) badge = '🎂 ';
      if (c.daysSinceContact !== null && c.daysSinceContact > 30) badge = '📅 ';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #FFFFFF;"><span style="color:#4B5563;">' + badge + escapeHtml(c.name) + '</span><span style="font-size:11px;color:var(--c-fg-3);">' + escapeHtml(c.relation) + '</span></div>';
    }).join('');
  } catch(e) { document.getElementById('socialList').textContent = '加载失败'; }
}

function openAddContact() {
  var name = prompt('👤 姓名：');
  if (!name) return;
  var relation = prompt('📌 关系（家人/朋友/同事）：') || '朋友';
  var birthday = prompt('🎂 生日（格式：YYYY-MM-DD，可选）：') || '';
  fetch('/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, relation: relation, birthday: birthday, phone: '', note: '' })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) { if (data.success) { alert('✅ 联系人已添加'); loadSocial(); } })
  .catch(function(e) { alert('网络错误'); });
}

// ============================================================
// 成就系统 JS
// ============================================================
async function loadAchievements() {
  try {
    var res = await fetch('/api/achievements');
    var data = await res.json();
    var container = document.getElementById('achievementList');
    if (data.unlockedCount === 0) {
      container.innerHTML = '<span style="color:var(--c-fg-3);font-size:12px;">继续努力，解锁第一个成就 🏆</span>';
      return;
    }
    container.innerHTML = data.unlocked.slice(0, 4).map(function(a) {
      return '<span style="background:var(--c-border);border-radius:12px;padding:2px 10px;font-size:11px;color:var(--c-primary);">' + escapeHtml(a.name) + '</span>';
    }).join('');
  } catch(e) { document.getElementById('achievementList').textContent = '加载失败'; }
  try { await fetch('/api/achievements/check', { method: 'POST' }); } catch(e) {}
}

function viewAchievements() {
  fetch('/api/achievements')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var msg = '🏆 成就墙\n\n已解锁 ' + data.unlockedCount + '/' + data.total + '\n\n';
      data.all.forEach(function(a) {
        msg += (a.unlocked ? '✅ ' : '🔒 ') + a.name + ' — ' + a.condition + '\n';
      });
      alert(msg);
    })
    .catch(function(e) { alert('加载失败'); });
}

// ============================================================
// 工作模式 JS
// ============================================================
async function loadWork() {
  try {
    var modeRes = await fetch('/api/work-mode');
    var statsRes = await fetch('/api/work-stats');
    var skillsRes = await fetch('/api/skills');
    var mode = await modeRes.json();
    var stats = await statsRes.json();
    var skills = await skillsRes.json();
    var modeNames = { normal: '日常', interview: '🎯 面试', sales: '📈 销售', coach: '📚 辅导' };
    document.getElementById('workModeBadge').textContent = modeNames[mode.mode] || '日常';
    document.getElementById('workStats').innerHTML =
      '<span>📋 面试 ' + (stats.interviews.total || 0) + '</span>' +
      '<span>🎯 Offer ' + (stats.interviews.offers || 0) + '</span>' +
      '<span>⭐ 技能 ' + (skills.count || 0) + '</span>';
    var container = document.getElementById('workContent');
    var html = '';
    if (mode.mode === 'interview') {
      var interviews = await fetch('/api/interviews').then(function(r) { return r.json(); });
      var pending = interviews.filter(function(i) { return i.status === '待面试'; });
      var recent = interviews.slice(0, 3);
      if (pending.length > 0) {
        html += '<div style="color:#FBBF24;font-size:12px;">📌 ' + pending.length + ' 个待面试</div>';
      }
      if (recent.length > 0) {
        html += recent.map(function(i) {
          return '<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #FFFFFF;font-size:12px;">' +
            '<span style="color:#4B5563;">' + escapeHtml(i.company) + ' · ' + escapeHtml(i.position) + '</span>' +
            '<span style="color:var(--c-fg-3);">' + escapeHtml(i.status) + '</span>' +
          '</div>';
        }).join('');
      } else {
        html += '<div style="color:var(--c-fg-3);font-size:12px;">暂无面试记录，点击下方添加</div>';
      }
      html += '<button onclick="openAddInterview()" style="margin-top:4px;background:transparent;border:1px dashed #F3F4F6;border-radius:6px;padding:4px 8px;color:var(--c-fg-3);font-size:11px;cursor:pointer;width:100%;">+ 添加面试</button>';
    } else {
      // 日常模式显示技能
      var topSkills = skills.skills ? skills.skills.slice(0, 3) : [];
      if (topSkills.length > 0) {
        html += topSkills.map(function(s) {
          return '<span style="display:inline-block;background:var(--c-accent);border-radius:8px;padding:2px 10px;font-size:11px;color:var(--c-primary);margin:2px;">' + escapeHtml(s.name) + ' ' + s.score + '/10</span>';
        }).join('');
      } else {
        html += '<span style="color:var(--c-fg-3);font-size:12px;">还没有技能评分，点击下方添加</span>';
      }
      html += '<button onclick="openAddSkill()" style="margin-top:4px;background:transparent;border:1px dashed #F3F4F6;border-radius:6px;padding:4px 8px;color:var(--c-fg-3);font-size:11px;cursor:pointer;width:100%;">+ 添加技能</button>';
    }
    container.innerHTML = html;
  } catch(e) { document.getElementById('workContent').textContent = '加载失败'; }
}

function switchWorkMode() {
  var modes = ['normal', 'interview', 'sales', 'coach'];
  var labels = ['日常', '面试模式', '销售模式', '辅导模式'];
  var choice = prompt('选择工作模式：\n1. 日常\n2. 面试模式\n3. 销售模式\n4. 辅导模式', '1');
  if (!choice) return;
  var idx = parseInt(choice) - 1;
  if (idx < 0 || idx > 3) return;
  fetch('/api/work-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: modes[idx] })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) { if (data.success) { alert(data.message); loadWork(); } })
  .catch(function(e) { alert('网络错误'); });
}

function openAddInterview() {
  var company = prompt('🏢 公司名称：');
  if (!company) return;
  var position = prompt('📌 岗位：');
  if (!position) return;
  var salary = prompt('💰 薪资范围（可选）：') || '';
  var date = prompt('📅 面试日期（YYYY-MM-DD）：') || new Date().toISOString().split('T')[0];
  fetch('/api/interview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: company, position: position, date: date, salary: salary, status: '待面试' })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) { if (data.success) { alert('✅ 面试已添加'); loadWork(); } })
  .catch(function(e) { alert('网络错误'); });
}

function openAddSkill() {
  var name = prompt('⭐ 技能名称：');
  if (!name) return;
  var score = prompt('📊 评分（1-10）：');
  if (!score || isNaN(score) || score < 1 || score > 10) { alert('请输入1-10的数字'); return; }
  fetch('/api/skill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, score: parseInt(score) })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) { if (data.success) { alert('✅ 技能已添加'); loadWork(); } })
  .catch(function(e) { alert('网络错误'); });
}
