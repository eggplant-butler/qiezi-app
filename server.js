const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
require('dotenv').config();
const app = express();
const PORT = 3000;
const APP_VERSION = require('./package.json').version;
const VERSION_TAG = 'v' + APP_VERSION;  // 用于 deploy.sh 内容校验标记
// 版本标记：qiezi-v6.5.x（deploy.sh verify_download 会 grep 此标记）
// 信任一层反向代理（腾讯云/PM2 前置代理会转发 X-Forwarded-For）。
// 不设置则 express-rate-limit v8 会抛 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR，登录限流失效。
app.set('trust proxy', 1);

// ============ 结构化日志（pino）============
// 生产环境输出 JSON，便于 PM2/grep 分析；本地开发可用 LOG_PRETTY=1 美化
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'qiezi-app', version: APP_VERSION },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: process.env.LOG_PRETTY === '1' ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss' }
  } : undefined
});
app.locals.logger = logger;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ SQLite 初始化层 ============
const Database = require('better-sqlite3');
const DB_PATH = path.join(DATA_DIR, 'qiezi.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode=WAL;');
db.pragma('synchronous=NORMAL;');
const DB = db;

db.exec(`
  CREATE TABLE IF NOT EXISTS records(
    mid TEXT, id TEXT, data TEXT, created TEXT, updated TEXT,
    PRIMARY KEY(mid, id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS kv(
    key TEXT PRIMARY KEY, value TEXT
  );
  -- 复合索引：按模块+创建时间查询（最高频场景：首页列表、模块时间线）
  CREATE INDEX IF NOT EXISTS idx_records_mid_created ON records(mid, created DESC);
  -- ID 索引：按 ID 查询/删除单条记录
  CREATE INDEX IF NOT EXISTS idx_records_id ON records(id);
  -- 创建时间索引：按时间范围查询（如"最近7天"、"本月"）
  CREATE INDEX IF NOT EXISTS idx_records_created ON records(created DESC);
`);

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

(function migrateJSON() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const now = new Date().toISOString();
  for (const f of files) {
    const mid = f.slice(0, -5);
    const countRow = db.prepare('SELECT COUNT(*) as c FROM records WHERE mid=?').get(mid);
    if (countRow.c > 0) continue;
    const fpath = path.join(DATA_DIR, f);
    let rows;
    try {
      const raw = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      if (Array.isArray(raw)) rows = raw;
      else if (raw && Array.isArray(raw.records)) rows = raw.records;
      else continue;
    } catch (e) { continue; }
    if (!rows || !rows.length) continue;
    const insert = db.prepare('INSERT OR REPLACE INTO records(mid,id,data,created,updated) VALUES(?,?,?,?,?)');
    const tx = db.transaction(() => {
      for (const row of rows) {
        const rid = row.id || genId();
        const created = row.created || row.date || row.createdAt || now;
        insert.run(mid, rid, JSON.stringify(row), created, now);
      }
    });
    tx();
    try { fs.renameSync(fpath, fpath + '.bak'); } catch (e) {}
  }
})();

// ======= 跨模块合并迁移（一次执行，持久化到SQLite）=======
// P0-B: learn → growth 合并
// P0-C: body + medical → health 合并
(function mergeMigrate() {
  try {
    // 1) learn → growth：如果 learn 有记录但 growth 没有迁移标记，则迁移
    const learnCount = db.prepare('SELECT COUNT(*) as c FROM records WHERE mid=?').get('learn').c;
    const growthMigrated = db.prepare('SELECT COUNT(*) as c FROM kv WHERE key=?').get('migrate:learn_to_growth').c;
    if (learnCount > 0 && growthMigrated === 0) {
      const learnRows = db.prepare('SELECT id, data, created, updated FROM records WHERE mid=?').all('learn');
      const insert = db.prepare('INSERT INTO records (mid, id, data, created, updated) VALUES (?,?,?,?,?)');
      const tx = db.transaction(function(rows) {
        for (const r of rows) {
          try {
            const obj = JSON.parse(r.data);
            if (obj && typeof obj === 'object') {
              obj._module = 'growth';
              obj._migratedFrom = 'learn';
              obj.type = obj.type || '学习';
              if (obj.subject && !obj.skill) obj.skill = obj.subject;
              if (obj.understanding !== undefined && obj.progress === undefined) {
                obj.progress = '理解度 ' + obj.understanding + ' 档';
              }
              // 避免 id 冲突（如果原 id 冲突则自动生成新 id）
              const exists = db.prepare('SELECT COUNT(*) as c FROM records WHERE mid=? AND id=?').get('growth', r.id).c;
              const newId = exists > 0 ? (r.id + '_m' + Date.now().toString(36)) : r.id;
              insert.run('growth', newId, JSON.stringify(obj), r.created, r.updated);
            }
          } catch (e) { console.error('[migrate] learn解析失败:', e.message); }
        }
      });
      tx(learnRows);
      db.prepare('INSERT INTO kv (key, value) VALUES (?,?)').run('migrate:learn_to_growth', String(learnCount));
      console.log('[migrate] ✅ learn → growth 迁移完成，' + learnCount + ' 条');
    }

    // 2) body + medical → health：如果 body 或 medical 有记录但 health 没有迁移标记，则迁移
    const bodyCount = db.prepare('SELECT COUNT(*) as c FROM records WHERE mid=?').get('body').c;
    const medCount = db.prepare('SELECT COUNT(*) as c FROM records WHERE mid=?').get('medical').c;
    const healthMigrated = db.prepare('SELECT COUNT(*) as c FROM kv WHERE key=?').get('migrate:body_medical_to_health').c;
    if ((bodyCount + medCount) > 0 && healthMigrated === 0) {
      const rows = [];
      const bodyRows = db.prepare('SELECT id, mid, data, created, updated FROM records WHERE mid=?').all('body');
      for (const r of bodyRows) rows.push(Object.assign({srcMid: 'body'}, r));
      const medRows = db.prepare('SELECT id, mid, data, created, updated FROM records WHERE mid=?').all('medical');
      for (const r of medRows) rows.push(Object.assign({srcMid: 'medical'}, r));
      if (rows.length > 0) {
        const insert = db.prepare('INSERT INTO records (mid, id, data, created, updated) VALUES (?,?,?,?,?)');
        const tx = db.transaction(function(list) {
          for (const r of list) {
            try {
              const obj = JSON.parse(r.data);
              if (obj && typeof obj === 'object') {
                obj._module = 'health';
                obj._migratedFrom = r.srcMid;
                // body → sceneType=身体观察，medical → sceneType=就医行动
                if (!obj.sceneType) {
                  obj.sceneType = r.srcMid === 'body' ? '身体观察' : '就医行动';
                }
                const exists = db.prepare('SELECT COUNT(*) as c FROM records WHERE mid=? AND id=?').get('health', r.id).c;
                const newId = exists > 0 ? (r.id + '_m' + Date.now().toString(36)) : r.id;
                insert.run('health', newId, JSON.stringify(obj), r.created, r.updated);
              }
            } catch (e) { console.error('[migrate] health解析失败:', e.message); }
          }
        });
        tx(rows);
        db.prepare('INSERT INTO kv (key, value) VALUES (?,?)').run('migrate:body_medical_to_health', String(bodyCount + medCount));
        console.log('[migrate] ✅ body(' + bodyCount + ') + medical(' + medCount + ') → health 迁移完成');
      }
    }
  } catch (e) {
    console.error('[migrate] 合并迁移失败（继续启动）:', e.message);
  }
})();

function readData(m) {
  const rows = db.prepare('SELECT data FROM records WHERE mid=? ORDER BY created DESC').all(m);
  const result = [];
  for (const r of rows) {
    try {
      const obj = JSON.parse(r.data);
      if (obj && typeof obj === 'object') result.push(obj);
      else console.warn('[readData] 跳过非对象记录 mid=' + m);
    } catch (e) {
      // 单条坏 JSON 不应击穿整个模块读取
      console.error('[readData] JSON 解析失败 mid=' + m + ':', e.message);
    }
  }
  return result;
}
function writeData(m, list) {
  // 严格校验：必须是数组，防止误传对象/字符串导致崩溃或清空
  if (!Array.isArray(list)) {
    throw new Error('writeData: list 必须是数组，收到 ' + typeof list);
  }
  // 防御：单次写入上限 10000 条，防止误传超大 body 清空或污染数据
  if (list.length > 10000) {
    throw new Error('writeData: 单次写入上限 10000 条，收到 ' + list.length);
  }
  const now = new Date().toISOString();
  const ids = list.map(r => String((r && r.id) || genId()));
  const upsert = db.prepare('INSERT OR REPLACE INTO records(mid,id,data,created,updated) VALUES(?,?,?,?,?)');
  const tx = db.transaction(() => {
    if (ids.length === 0) {
      db.prepare('DELETE FROM records WHERE mid=?').run(m);
    } else {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM records WHERE mid=? AND id NOT IN (${placeholders})`).run(m, ...ids);
    }
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const rid = String(row.id || genId());
      if (!row.id) row.id = rid;
      const created = row.created || row.date || row.createdAt || now;
      upsert.run(m, rid, JSON.stringify(row), created, now);
    }
  });
  tx();
}
function getOneRecord(mid, id) {
  const row = db.prepare('SELECT data FROM records WHERE mid=? AND id=?').get(mid, String(id));
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (e) { return null; }
}
function upsertRecord(mid, item) {
  const now = new Date().toISOString();
  const rid = String(item.id || genId());
  if (!item.id) item.id = rid;
  const created = item.created || item.date || item.createdAt || now;
  db.prepare('INSERT OR REPLACE INTO records(mid,id,data,created,updated) VALUES(?,?,?,?,?)')
    .run(mid, rid, JSON.stringify(item), created, now);
  return item;
}
function deleteRecord(mid, id) {
  const info = db.prepare('DELETE FROM records WHERE mid=? AND id=?').run(mid, String(id));
  return info.changes > 0;
}

// ============ 认证层：JWT（crypto 原生实现，无额外依赖）============
// 优先级：.env 文件（P1） > 进程环境变量（P2） > data/auth.json（向后兼容，自动迁移）
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const ENV_FILE = path.join(__dirname, '.env');
let AUTH_SECRET, PASSWORD_HASH, PASSWORD_SALT;

function writeEnvFile(entries) {
  try {
    let content = '';
    if (fs.existsSync(ENV_FILE)) {
      content = fs.readFileSync(ENV_FILE, 'utf8');
    }
    const lines = content ? content.split('\n') : [];
    for (const [k, v] of Object.entries(entries)) {
      const idx = lines.findIndex(l => l.startsWith(k + '='));
      const safeVal = String(v).replace(/'/g, "'\\''");
      const newLine = `${k}='${safeVal}'`;
      if (idx >= 0) lines[idx] = newLine;
      else lines.push(newLine);
    }
    fs.writeFileSync(ENV_FILE, lines.filter(l => l !== undefined).join('\n').replace(/\n*$/, '\n'));
    try { fs.chmodSync(ENV_FILE, 0o600); } catch (e) {}
  } catch (e) {
    console.warn('[auth] 写入 .env 失败:', e.message);
  }
}
function loadFromEnv() {
  if (process.env.PASSWORD_HASH && process.env.PASSWORD_SALT && process.env.AUTH_SECRET) {
    PASSWORD_HASH = process.env.PASSWORD_HASH;
    PASSWORD_SALT = process.env.PASSWORD_SALT;
    AUTH_SECRET = process.env.AUTH_SECRET;
    return true;
  }
  return false;
}
function initAuth() {
  if (loadFromEnv()) {
    console.log('[auth] ✅ 从环境变量加载（.env / 进程 env）');
    return;
  }
  if (fs.existsSync(AUTH_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      PASSWORD_HASH = cfg.hash;
      PASSWORD_SALT = cfg.salt;
      AUTH_SECRET = cfg.secret;
      // 向后兼容：自动迁移到 .env（迁移完成后 auth.json 仍保留，兜底用）
      writeEnvFile({
        PASSWORD_HASH: PASSWORD_HASH,
        PASSWORD_SALT: PASSWORD_SALT,
        AUTH_SECRET: AUTH_SECRET
      });
      console.log('[auth] ✅ 从 auth.json 加载，已自动迁移到 .env');
      return;
    } catch (e) {
      console.error('[auth] auth.json 配置损坏，重新初始化:', e.message);
    }
  }
  createAuthConfig('eggplant');
  console.log('[auth] ✅ 首次初始化，默认密码: eggplant（请尽快在个人中心修改）');
}
function createAuthConfig(password) {
  PASSWORD_SALT = crypto.randomBytes(16).toString('hex');
  AUTH_SECRET = crypto.randomBytes(32).toString('hex');
  PASSWORD_HASH = crypto.scryptSync(password, PASSWORD_SALT, 64).toString('hex');
  // 双写：.env 为主，auth.json 向后兼容兜底
  writeEnvFile({
    PASSWORD_HASH: PASSWORD_HASH,
    PASSWORD_SALT: PASSWORD_SALT,
    AUTH_SECRET: AUTH_SECRET
  });
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify({
      hash: PASSWORD_HASH, salt: PASSWORD_SALT, secret: AUTH_SECRET,
      created: new Date().toISOString(), migrated: true
    }, null, 2));
  } catch (e) { /* auth.json 写入失败不致命，有 .env 就够 */ }
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, payload, {
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  }))).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
    if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}
function verifyPassword(pwd) {
  const hash = crypto.scryptSync(pwd, PASSWORD_SALT, 64).toString('hex');
  return hash.length === PASSWORD_HASH.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(PASSWORD_HASH));
}
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '未登录' });
  }
  const payload = verifyToken(auth.slice(7));
  if (!payload) {
    return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
  }
  req.user = payload;
  next();
}
initAuth();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/health')
});
app.use('/api/', apiLimiter);

app.use(cors({
  origin: (origin, cb) => {
    // 允许的来源：本机/内网 + 公网 IP + 常用本地开发端口
    const allowed = [
      /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/,
      /^https?:\/\/49\.235\.185\.200(:\d+)?$/,
      /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
      /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/,
      /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/
    ];
    if (!origin || allowed.some(r => r.test(origin))) return cb(null, true);
    // 不在白名单但非浏览器请求（origin 缺失或自定义UA）→ 放行，nginx/防火墙兜底
    cb(null, true);
  },
  credentials: true,
  maxAge: 86400
}));
app.use(express.json({ limit: '10mb' }));

// ============ API 请求日志中间件 ============
// 仅记录 /api/ 请求，输出结构化字段：method/path/status/durationMs/ip
// 注意：req.path 在 mount 中间件（如 app.use('/api/', requireAuth)）执行后会被改写，
// 因此必须在中间件入口先捕获原始路径，避免 finish 回调里取到剥离前缀后的路径。
const REDACT_KEYS = new Set(['password','currentPassword','newPassword','token','authorization','secret','salt','hash']);
function redactSensitive(obj, depth = 0) {
  if (depth > 3 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => redactSensitive(v, depth + 1));
  const out = {};
  for (const k in obj) {
    if (REDACT_KEYS.has(k.toLowerCase()) || REDACT_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSensitive(obj[k], depth + 1);
    }
  }
  return out;
}
app.use((req, res, next) => {
  const start = Date.now();
  const origPath = req.path;
  const origUrl = req.originalUrl || req.url;
  if (!origPath.startsWith('/api/')) return next();
  res.on('finish', () => {
    const dur = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'warn' : 'info');
    const extra = {};
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
      extra.body = redactSensitive(req.body);
    }
    logger[level]({
      method: req.method,
      path: origPath,
      url: origUrl,
      status: res.statusCode,
      durationMs: dur,
      ip: req.ip,
      ...extra
    }, 'req');
  });
  next();
});

// 前端静态文件：HTML/sw.js 走 no-cache（保证更新即时生效），其他资源长缓存
if (fs.existsSync(path.join(__dirname, 'frontend'))) {
  app.use(express.static('frontend', {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
        // HTML 和 Service Worker 必须每次都验证，否则版本更新检测不到
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    }
  }));
}

// ============ 公开路由（无需认证）============
// 深度健康检查：DB 连通性 + 磁盘空间 + 备份状态 + 进程状态
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    const dbSize = fs.statSync(DB_PATH).size;
    // WAL 文件大小（过大提示需要 checkpoint）
    let walSize = 0;
    try { walSize = fs.statSync(DB_PATH + '-wal').size; } catch (e) {}
    let diskFree = null;
    try {
      const stats = fs.statfsSync ? fs.statfsSync(DATA_DIR) : null;
      if (stats && typeof stats.bavail === 'number' && typeof stats.bsize === 'number') {
        diskFree = stats.bavail * BigInt(stats.bsize);
        diskFree = Number(diskFree);
      }
    } catch (e) {}
    const backups = listAllBackups ? listAllBackups() : [];
    const latestBackup = backups[0];
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const backupHealthy = latestBackup ? latestBackup.mtime > oneDayAgo : false;
    const mem = process.memoryUsage();
    const uptimeSec = process.uptime();
    res.json({
      status: 'ok',
      version: APP_VERSION,
      db: { connected: true, size: dbSize, walSize },
      disk: { freeBytes: diskFree },
      backup: { count: backups.length, healthy: backupHealthy, latest: latestBackup ? latestBackup.name : null },
      process: {
        pid: process.pid,
        uptimeSec: Math.round(uptimeSec),
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotalBytes,
        nodeVersion: process.version,
        // uptime < 90s 提示刚重启过（可能是崩溃后被 PM2 拉起）
        recentlyRestarted: uptimeSec < 90
      }
    });
  } catch (e) {
    res.status(503).json({ status: 'error', version: APP_VERSION, message: e.message });
  }
});

// 前端错误上报：接收浏览器运行时错误（window.onerror / unhandledrejection），写入日志便于排查
// 公开端点（无需认证）：报错时 token 可能已失效，不能被 requireAuth 拦截
app.post('/api/client-error', (req, res) => {
  try {
    const b = req.body || {};
    logger.error({
      type: b.type || 'error',
      msg: b.message,
      filename: b.filename, lineno: b.lineno, colno: b.colno,
      stack: b.stack, url: b.url, ua: b.userAgent
    }, 'client-error');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

// 登录：验证密码，签发 JWT
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ success: false, message: '请输入密码' });
  if (!verifyPassword(password)) {
    return res.status(401).json({ success: false, message: '密码错误' });
  }
  const token = signToken({ user: 'captain' });
  res.json({ success: true, token, expiresIn: 7 * 24 * 60 * 60 * 1000 });
});

// ============ 认证中间件：以下所有 /api/ 路由需携带有效 JWT ============
app.use('/api/', requireAuth);

// 验证当前 token 是否有效（前端启动时检查）
app.get('/api/me', (req, res) => {
  res.json({ success: true, user: req.user.user });
});

// 修改密码
app.post('/api/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword || '')) {
    return res.status(401).json({ success: false, message: '当前密码错误' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ success: false, message: '新密码至少4位' });
  }
  createAuthConfig(newPassword);
  const token = signToken({ user: 'captain' });
  res.json({ success: true, message: '密码已修改', token });
});

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
  const modules = ['finance','sleep','exercise','emotion','diet','diary','photo','think','work','body','relation','growth','spirit','home','travel','pet','health','todo','time','inventory','space','medical','learn'];
  modules.forEach(m => { all[m] = readData(m); });
  const result = generateInsights(all);
  // 合并 ENG 引擎的深度分析（统一一套洞察）
  try {
    const hist = ENG.buildHistory();
    const engCorr = ENG.correlate(hist);
    const engRisks = ENG.risks(hist);
    if (engCorr && engCorr.length) {
      engCorr.forEach(function(c) {
        if (!result.correlations.some(function(x) { return x.type === c.t; })) {
          result.correlations.push({ type: c.t, title: c.s === 'high' ? '⚠️ ' + (c.m || '').split('\n')[0] : (c.m || '').split('\n')[0], detail: c.m || '' });
        }
      });
    }
    if (engRisks && engRisks.length) {
      result.engRisks = engRisks;
    }
  } catch (e) { console.error('[insights] ENG merge:', e.message); }
  res.json(result);
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

  // ---- 5b. 宠物花费关联 ----
  const petRecords = (data.pet || []).filter(r => r.date && r.date >= ms);
  if (petRecords.length > 0) {
    const petCost = petRecords.reduce((s, r) => s + (parseFloat(r.cost) || 0), 0);
    result.correlations.push({
      type: 'pet_cost',
      title: '🐾 宠物花费',
      detail: `近30天${petRecords.length}次记录，花费${petCost.toFixed(0)}元`
    });
    if (petCost > 500) {
      result.suggestions.push({ id: 's_pet', text: '🐾 宠物花费较高，关注是否有非必要支出', module: 'pet', status: 'pending' });
    }
  }

  // ---- 5c. 健康与情绪关联 ----
  const healthRecs = (data.health || []).concat(data.body || []).concat(data.medical || []).filter(r => r.date && r.date >= ms);
  const emoRecs = (data.emotion || []).filter(r => r.date && r.date >= ms);
  if (healthRecs.length >= 2 && emoRecs.length >= 3) {
    const healthDates = new Set(healthRecs.map(r => r.date));
    const emoOnHealthDays = emoRecs.filter(r => healthDates.has(r.date));
    const emoOther = emoRecs.filter(r => !healthDates.has(r.date));
    if (emoOnHealthDays.length > 0 && emoOther.length > 0) {
      const avgOn = emoOnHealthDays.reduce((s, r) => s + (parseFloat(r.rating) || 0), 0) / emoOnHealthDays.length;
      const avgOff = emoOther.reduce((s, r) => s + (parseFloat(r.rating) || 0), 0) / emoOther.length;
      if (Math.abs(avgOn - avgOff) > 0.5) {
        result.correlations.push({
          type: 'health_mood',
          title: '🏥 健康与情绪',
          detail: `就医/症状日情绪${avgOn.toFixed(1)}分，健康日${avgOff.toFixed(1)}分`
        });
      }
    }
  }

  // ---- 5d. 待办完成率 ----
  const todos = (data.todo || []).filter(r => r.date && r.date >= ms);
  if (todos.length >= 3) {
    const done = todos.filter(r => r.status === '已完成').length;
    const rate = Math.round((done / todos.length) * 100);
    result.correlations.push({
      type: 'todo_rate',
      title: '📋 待办完成率',
      detail: `近30天${todos.length}项，完成${done}项，完成率${rate}%`
    });
    if (rate < 40) {
      result.suggestions.push({ id: 's_todo', text: '📋 待办完成率偏低，建议拆分大任务为小步骤', module: 'todo', status: 'pending' });
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
// 认知引擎 ENG（Phase 1：鬼谷子视角 + 不以物喜不以己悲）
// ============================================================
const ENG = {
  // 反思提问：基于模块 + 本次数据 + 历史，生成直击本质的问题
  reflect(mid, data, hist) {
    const recent = hist.filter(x => x.mid === mid).slice(0, 7);
    const fns = {
      sleep: () => {
        const d = parseFloat(data.hours || data.duration || 0);
        const avg = recent.length ? recent.reduce((s,x) => s + parseFloat(x.data?.hours || x.data?.duration || 0), 0) / recent.length : d;
        if (d < 6) return `睡眠${d}h，近7天均${avg.toFixed(1)}h。\n被什么拖着没睡——事、人、还是情绪？\n权衡：再撑3天，你将损失什么（认知/情绪/判断）？停下，你又怕失去什么？`;
        if (d >= 8) return `睡眠${d}h。\n这是"养精蓄锐"还是"逃避现实"？\n如实看自己——充足睡眠后你做了什么，决定了它是利器还是麻醉。`;
        return `睡眠${d}h，近7天均${avg.toFixed(1)}h。\n在变好还是变差？\n背后那件你明知该改却没改的事，是什么？`;
      },
      emotion: () => {
        const l = parseInt(data.rating || data.level || 3);
        const avg = recent.length ? recent.reduce((s,x) => s + parseInt(x.data?.rating || x.data?.level || 3), 0) / recent.length : l;
        if (l <= 2) return `情绪${l}/5，近5次均${avg.toFixed(1)}。\n是事件触发还是积压爆发？\n别人看到的是真相，还是你想让他们看到的？\n若3天后还这样，你打算主动做什么？`;
        if (l >= 4) return `情绪${l}/5。\n什么让你好？是外在成就（易失）还是内在安定（不易得）？\n前者要警觉，后者要复用。`;
        return `情绪${l}/5，均${avg.toFixed(1)}。\n是"不以物喜不以己悲"的中正，还是麻木？\n两者看起来一样，内里完全不同。`;
      },
      exercise: () => {
        const d = parseFloat(data.duration || 0);
        if (d >= 30) return `运动${d}min。\n你在追求什么？逃避什么？\n运动后那一刻，你脑子最清楚的那件事是什么？`;
        if (d > 0) return `运动${d}min。\n动了，但够吗？\n还是用"动一下"安抚了"该认真练"的焦虑？`;
        return `没运动。\n是身体不需要，还是你不想面对自己？\n连身体都照顾不好时，你的判断力能可信吗？`;
      },
      finance: () => {
        const amt = parseFloat(data.amount || 0);
        const typ = data.type;
        if (typ === 'income') return `收入${amt}元。\n这是你能力的回报，还是运气的赠予？\n前者可复制，后者不可恃。`;
        if (amt >= 500) return `支出${amt}元。\n是"需要"还是"想要"？\n买的那一刻开心，3天后还开心吗？\n如果记账后你心疼——心疼的不是钱，是失控。`;
        if (amt > 0) return `支出${amt}元。小事。\n但小事的累积就是大事。\n一个月下来，这种"无感消费"占了多少？`;
        return `记账了。\n这次记账是仪式感，还是真的看见了？`;
      },
      diet: () => {
        const c = data.content || '';
        if (c.includes('外卖') || c.includes('快餐')) return `外卖：${c}。\n是没时间还是没心力？\n前者是忙，后者是丧——两者解法完全不同。`;
        if (c.includes('蔬菜') || c.includes('沙拉')) return `清淡饮食。\n在养身还是养焦虑？\n身体舒服时，脑子才肯说实话。`;
        return `吃了：${c}。\n这是喂饱饥饿，还是喂饱情绪？\n区分这俩，是成年人对自己最重要的诚实。`;
      },
      diary: () => {
        const c = data.content || '';
        return `你写下："${c.slice(0,40)}${c.length>40?'...':''}"\n一年后这件事还重要吗？\n如果是，为什么现在你只用了日记的篇幅？\n如果不是，你为什么此刻为它消耗心力？`;
      },
      think: () => {
        const c = data.content || '';
        return `你在想："${c.slice(0,40)}${c.length>40?'...':''}"\n权衡三件事：\n1. 这事一年后还重要吗？\n2. 你能控制的部分占多少？\n3. 不决策的代价，比错决策的代价低还是高？`;
      },
      photo: () => {
        const q = parseFloat(data.quality || 0);
        if (q >= 4) return `质量${q}/5。\n在表达什么？\n技术跟上了，但你有"非拍不可"的理由吗？\n摄影到最后拼的不是光圈，是眼睛。`;
        if (q > 0) return `质量${q}/5。\n是审美问题还是练习问题？\n前者要看好照片，后者要按快门——你属于哪种？`;
        return `拍了。复盘了吗？\n一张能让你说清楚"为什么按"的照片，胜过100张"觉得好看"的。`;
      },
      learn: () => {
        const c = data.content || '';
        return `学了："${c.slice(0,30)}${c.length>30?'...':''}"\n7天后你能用它做什么？\n如果7天后用不上，它对你的"成长"是真价值，还是焦虑的安慰剂？`;
      },
      body: () => `记录身体：${data.content || ''}。\n这个信号在告诉你什么？\n忽视它3个月，代价是什么？重视它1周，回报是什么？`,
      relation: () => `记录关系：${data.content || data.name || ''}。\n这段关系在滋养你，还是在消耗你？\n如果一年后它还是这样，你愿意吗？`
    };
    const fn = fns[mid];
    if (fn) return fn();
    if (recent.length >= 3) return `你在"${mid}"已有${recent.length}条记录。\n看到什么模式？\n这个模式在帮你，还是在限制你？`;
    return `为什么开始关注这个？\n想改变什么？\n真正想改变的那件事，藏在你不想说的那部分里。`;
  },

  // 关联分析：跨模块找规律
  correlate(hist) {
    const out = [];
    const sl = hist.filter(x => x.mid === 'sleep').slice(0, 14);
    const mo = hist.filter(x => x.mid === 'emotion').slice(0, 14);

    // 1. 睡眠<6h → 次日情绪
    if (sl.length >= 2 && mo.length >= 2) {
      const badDates = new Set(sl.filter(x => parseFloat(x.data?.hours || x.data?.duration || 99) < 6).map(x => (x.ts || '').split('T')[0]));
      const nextMoods = mo.filter(x => {
        const d = (x.ts || '').split('T')[0];
        const prev = new Date(Date.parse(d) - 864e5).toISOString().split('T')[0];
        return badDates.has(prev);
      });
      if (nextMoods.length >= 2) {
        const avg = nextMoods.reduce((s,x) => s + parseInt(x.data?.rating || x.data?.level || 3), 0) / nextMoods.length;
        if (avg < 3.5) out.push({ t:'sleep_mood', s:'high', m:`睡眠<6h的次日，情绪均${avg.toFixed(1)}/5。睡眠不是问题，是地基——地基塌了，上层建筑都是临时的。` });
      }
    }

    // 2. 锻炼日 → 当日情绪
    const ex = hist.filter(x => x.mid === 'exercise').slice(0, 14);
    if (ex.length >= 2 && mo.length >= 4) {
      const exDates = new Set(ex.map(x => (x.ts || '').split('T')[0]));
      const exMoods = mo.filter(x => exDates.has((x.ts || '').split('T')[0]));
      const noExMoods = mo.filter(x => !exDates.has((x.ts || '').split('T')[0]));
      if (exMoods.length >= 2 && noExMoods.length >= 2) {
        const a1 = exMoods.reduce((s,x) => s + parseInt(x.data?.rating || 3), 0) / exMoods.length;
        const a2 = noExMoods.reduce((s,x) => s + parseInt(x.data?.rating || 3), 0) / noExMoods.length;
        if (a1 - a2 > 0.5) out.push({ t:'ex_mood', s:'med', m:`运动日情绪${a1.toFixed(1)}，非运动日${a2.toFixed(1)}。运动是你的解药——但它不能"治愈"，只能"维持"。` });
      }
    }

    // 3. 连续情绪低
    const r5 = mo.slice(0, 5);
    if (r5.length >= 3 && r5.every(x => parseInt(x.data?.rating || x.data?.level || 3) <= 2)) {
      out.push({ t:'mood_down', s:'crit', m:`连续${r5.length}次情绪≤2。这不是心情，是状态。\n等"自己想通"会等太久——主动做一件最小的事。` });
    }

    // 4. 近3笔高消费
    const fin = hist.filter(x => x.mid === 'finance').slice(0, 3);
    if (fin.length >= 3) {
      const spend = fin.filter(x => x.data?.type === 'expense' || x.data?.type === '支出').reduce((s,x) => s + parseFloat(x.data?.amount || 0), 0);
      if (spend >= 1000) out.push({ t:'high_spend', s:'med', m:`近3笔支出合计${spend.toFixed(0)}元。\n这是计划内，还是情绪驱动？\n后者不是钱的问题，是填补的欲望。` });
    }

    // ========== 新增8条关联（try-catch包裹，字段缺失不报错）==========
    try {
      // 5. 饮食吃撑 + 次日/同日 情绪低分
      const diet = hist.filter(x => x.mid === 'diet').slice(0, 14);
      const emo = hist.filter(x => x.mid === 'emotion').slice(0, 14);
      if (diet.length >= 1 && emo.length >= 1) {
        const overeatDates = new Set(diet.filter(x => {
          const sat = x.data?.satiety;
          return sat === '吃撑了' || sat === 10 || sat === '9分饱' || sat === 9;
        }).map(x => (x.ts || '').split('T')[0]));
        if (overeatDates.size >= 1) {
          const affected = emo.filter(e => {
            const d = (e.ts || '').split('T')[0];
            const r = parseInt(e.data?.rating || e.data?.level || 5);
            const prev = new Date(Date.parse(d) - 864e5).toISOString().split('T')[0];
            return (overeatDates.has(d) || overeatDates.has(prev)) && r <= 4;
          });
          if (affected.length >= 1) {
            const avg = affected.reduce((s,x) => s + parseInt(x.data?.rating || x.data?.level || 3), 0) / affected.length;
            out.push({ t:'overeat_mood', s:'med', m:`吃撑后情绪均${avg.toFixed(1)}/10。脾胃伤则情志乱——吃撑不是满足欲望，却是在消耗后天之本。问自己：那一勺入口的"最后一口"，是满足了谁？` });
          }
        }
      }
    } catch(e) {}

    try {
      // 6. 情绪性进食 + 情绪低分
      const dietAll = hist.filter(x => x.mid === 'diet').slice(0, 14);
      const emoAll = hist.filter(x => x.mid === 'emotion').slice(0, 14);
      if (dietAll.length >= 2 && emoAll.length >= 2) {
        const emoEat = dietAll.filter(x => x.data?.emotional && String(x.data.emotional) !== '否');
        if (emoEat.length >= 2) {
          const emoDates = new Set(emoEat.map(x => (x.ts || '').split('T')[0]));
          const pairedMoods = emoAll.filter(e => emoDates.has((e.ts || '').split('T')[0]));
          if (pairedMoods.length >= 1) {
            const avg = pairedMoods.reduce((s,x) => s + parseInt(x.data?.rating || x.data?.level || 5), 0) / pairedMoods.length;
            if (avg <= 5) out.push({ t:'emoeat_mood', s:'high', m:`情绪性进食${emoEat.length}次，当日情绪均${avg.toFixed(1)}/10。用食物填情绪，就像用木塞堵海水——塞子越多，浪越大。那口真正饿的，是没被看见的那个情绪。` });
          }
        }
      }
    } catch(e) {}

    try {
      // 7. 财务高必要性(3-4级冲动) > 3次/周 + 情绪分数低
      const finAll = hist.filter(x => x.mid === 'finance');
      const now2 = new Date();
      const weekAgo = new Date(now2); weekAgo.setDate(now2.getDate() - 7);
      const ws = weekAgo.toISOString().split('T')[0];
      const weekFin = finAll.filter(x => (x.ts || '').split('T')[0] >= ws);
      const emoAll2 = hist.filter(x => x.mid === 'emotion').slice(0, 14);
      if (weekFin.length >= 3 && emoAll2.length >= 3) {
        const impulsive = weekFin.filter(x => {
          const nec = x.data?.necessity;
          return nec === 3 || nec === 4 || nec === '3-想要' || nec === '4-冲动';
        });
        if (impulsive.length >= 3) {
          const avgM = emoAll2.slice(0, 7).reduce((s,x) => s + parseInt(x.data?.rating || x.data?.level || 5), 0) / Math.min(7, emoAll2.length);
          if (avgM <= 5) out.push({ t:'impulse_spend', s:'med', m:`本周冲动消费${impulsive.length}次，情绪基线${avgM.toFixed(1)}/10。心空则物满——当心里缺什么，就会用买什么来"填空"。但账单来了，空还在那里。` });
        }
      }
    } catch(e) {}

    try {
      // 8. 睡眠夜醒>=2 + 当日专注度低 / 心流无
      const slAll = hist.filter(x => x.mid === 'sleep').slice(0, 14);
      const workAll = hist.filter(x => x.mid === 'work').slice(0, 14);
      if (slAll.length >= 2 && workAll.length >= 2) {
        const wakeDates = new Set(slAll.filter(x => {
          const nw = x.data?.nightWakes;
          return (typeof nw === 'number' && nw >= 2) || nw === '2' || nw === '3' || nw === '4' || nw === '4+';
        }).map(x => (x.ts || '').split('T')[0]));
        if (wakeDates.size >= 1) {
          const affectedWork = workAll.filter(w => wakeDates.has((w.ts || '').split('T')[0]));
          if (affectedWork.length >= 1) {
            const lowFocus = affectedWork.filter(w => {
              const f = w.data?.focusLevel;
              return f === 1 || f === 2 || f === '1-摸鱼' || f === '2-分心';
            });
            if (lowFocus.length >= 1 || affectedWork.length >= 1) {
              out.push({ t:'wake_focus', s:'med', m:`夜醒≥2次后，工作专注度明显下滑。一夜数着醒来的不是身体，是心神不宁——碎片化睡眠是表象，思虑才是真凶。那些夜里让你放不下的那件事，是什么？` });
            }
          }
        }
      }
    } catch(e) {}

    try {
      // 9. 关系feel低分 <5 + 当日情绪
      const rel = hist.filter(x => x.mid === 'relation').slice(0, 14);
      const emo3 = hist.filter(x => x.mid === 'emotion').slice(0, 14);
      if (rel.length >= 2 && emo3.length >= 2) {
        const badRel = rel.filter(x => {
          const f = x.data?.feel;
          if (typeof f === 'number') return f < 5;
          if (!f) return false;
          var m = String(f).match(/^(\d+)/);
          return m ? parseInt(m[1]) < 5 : false;
        });
        if (badRel.length >= 1) {
          const relDates = badRel.map(x => (x.ts || '').split('T')[0]);
          const paired = emo3.filter(e => relDates.includes((e.ts || '').split('T')[0]));
          if (paired.length >= 1) {
            const avg = paired.reduce((s,x) => s + parseInt(x.data?.rating || x.data?.level || 5), 0) / paired.length;
            if (avg <= 5) out.push({ t:'relation_mood', s:'high', m:`关系感受<5分后情绪${avg.toFixed(1)}/10。人是情绪最大的环境——一段关系让你变差，不是你不好，是该换换气了。问：这段关系里，你是不是在勉强自己？` });
          }
        }
      }
    } catch(e) {}

    try {
      // 10. 锻炼后身体反馈很累/酸痛 + 第二天记录减少（过度训练）
      const exAll = hist.filter(x => x.mid === 'exercise').slice(0, 21);
      if (exAll.length >= 3) {
        const hardDays = exAll.filter(x => {
          const fb = x.data?.bodyFeedback;
          return fb === '很累' || fb === '酸痛';
        });
        if (hardDays.length >= 2) {
          let dropCount = 0;
          hardDays.forEach(hd => {
            const d = (hd.ts || '').split('T')[0];
            const next = new Date(Date.parse(d) + 864e5).toISOString().split('T')[0];
            const nextDayCount = exAll.filter(x => (x.ts || '').split('T')[0] === next).length;
            const avgBefore = exAll.filter(x => (x.ts || '').split('T')[0] < next && (x.ts || '').split('T')[0] > new Date(Date.parse(d) - 864e5 * 3).toISOString().split('T')[0]).length / 3;
            if (nextDayCount < Math.max(1, avgBefore * 0.5)) dropCount++;
          });
          if (dropCount >= 1 && hardDays.length >= 2) {
            out.push({ t:'overtrain', s:'med', m:`练到很累/酸痛${hardDays.length}次，次日记录量下降。过度训练不是自律，是自虐——身体会说谎，但身体不会。酸痛后的断，是身体在喊"罢工"。休息几天？` });
          }
        }
      }
    } catch(e) {}

    try {
      // 11. 学习时长+理解度组合：时长够但理解<=2（方法不对）
      const learnAll = hist.filter(x => x.mid === 'learn').slice(0, 14);
      if (learnAll.length >= 3) {
        const badMethod = learnAll.filter(x => {
          const dur = parseFloat(x.data?.duration || 0);
          const und = x.data?.understanding;
          const undNum = typeof und === 'number' ? und : (und && String(und).match(/^\d+/) ? parseInt(String(und).match(/^\d+/)[0]) : 3);
          return dur >= 45 && undNum <= 2;
        });
        if (badMethod.length >= 2) {
          const avgDur = badMethod.reduce((s,x) => s + parseFloat(x.data?.duration || 0), 0) / badMethod.length;
          out.push({ t:'learn_wrong', s:'med', m:`${badMethod.length}次学习≥${avgDur.toFixed(0)}分钟但理解≤2。努力≠勤奋在低质量勤奋，是最隐蔽的懒惰——你不是不用功，是用错了功。问：你是在"学"，还是在"让自己看起来在学"？` });
        }
      }
    } catch(e) {}

    try {
      // 12. 时间价值=浪费/后悔 出现>=2次/周 + 整体情绪基线低
      const timeAll = hist.filter(x => x.mid === 'time');
      const now3 = new Date();
      const weekAgo2 = new Date(now3); weekAgo2.setDate(now3.getDate() - 7);
      const ws2 = weekAgo2.toISOString().split('T')[0];
      const weekTime = timeAll.filter(x => (x.ts || '').split('T')[0] >= ws2);
      const emoAll4 = hist.filter(x => x.mid === 'emotion').slice(0, 14);
      if (weekTime.length >= 3 && emoAll4.length >= 3) {
        const wasted = weekTime.filter(x => {
          const v = x.data?.value;
          return v === '浪费' || v === '后悔';
        });
        if (wasted.length >= 2) {
          const baseline = emoAll4.slice(0, 7).reduce((s,x) => s + parseInt(x.data?.rating || x.data?.level || 5), 0) / Math.min(7, emoAll4.length);
          if (baseline <= 5) {
            out.push({ t:'waste_baseline', s:'high', m:`本周${wasted.length}次时间后悔/浪费，情绪基线${baseline.toFixed(1)}/10。时间是最诚实的账本——你把时间浪费在哪里，你就把人生浪费在哪里。问：如果这一周重来，哪2小时你一定不会那样过？` });
          }
        }
      }
    } catch(e) {}

    return out;
  },

  // 风险评估：长期模式识别
  risks(hist) {
    const out = [];
    const sl = hist.filter(x => x.mid === 'sleep').slice(0, 7);
    if (sl.length >= 3) {
      const avg = sl.reduce((s,x) => s + parseFloat(x.data?.hours || x.data?.duration || 0), 0) / sl.length;
      if (avg < 6 && avg > 0) out.push({ l:'high', c:'health', t:`近7天均睡眠${avg.toFixed(1)}h。\n长期<6h损害认知、情绪、判断——你以为在熬夜赢时间，其实在透支决策力。` });
    }
    const mo = hist.filter(x => x.mid === 'emotion').slice(0, 14);
    if (mo.length >= 5) {
      const avg = mo.reduce((s,x) => s + parseInt(x.data?.rating || x.data?.level || 3), 0) / mo.length;
      if (avg < 2.5) out.push({ l:'high', c:'mood', t:`近14天情绪均${avg.toFixed(1)}/5。\n持续低不是情绪问题，是生活结构问题——该调整的不是心情，是节奏。` });
    }
    const fin = hist.filter(x => x.mid === 'finance');
    if (fin.length >= 5) {
      const last30 = fin.slice(0, 30);
      const exp = last30.filter(x => x.data?.type === 'expense' || x.data?.type === '支出').reduce((s,x) => s + parseFloat(x.data?.amount || 0), 0);
      const inc = last30.filter(x => x.data?.type === 'income' || x.data?.type === '收入').reduce((s,x) => s + parseFloat(x.data?.amount || 0), 0);
      if (exp > inc && inc > 0) out.push({ l:'med', c:'finance', t:`近30天支出${exp.toFixed(0)}元 > 收入${inc.toFixed(0)}元。\n短期可忍，长期是慢性失血。` });
    }
    const ex = hist.filter(x => x.mid === 'exercise').slice(0, 14);
    if (ex.length === 0 && hist.length >= 10) out.push({ l:'low', c:'health', t:'14天内无运动记录。\n身体是承载一切的容器——容器漏了，里面的东西再珍贵也留不住。' });
    return out;
  },

  // 每日总结
  daily(hist) {
    const t = new Date().toISOString().split('T')[0];
    const tr = hist.filter(x => (x.ts || '').split('T')[0] === t);
    if (!tr.length) return null;
    const mods = new Set(tr.map(x => x.mid));
    let s = `今日${tr.length}条，覆盖${mods.size}个维度。`;
    const m = tr.find(x => x.mid === 'emotion');
    if (m) s += ` 情绪${m.data?.rating || m.data?.level || '?'}/5。`;
    const sl = tr.find(x => x.mid === 'sleep');
    if (sl) s += ` 睡眠${sl.data?.hours || sl.data?.duration || '?'}h。`;
    const ex = tr.find(x => x.mid === 'exercise');
    if (ex) s += ` 运动${ex.data?.duration || '?'}min。`;
    return s;
  },

  // 构造统一历史格式
  buildHistory() {
    // 合并后：learn 数据会镜像到 growth；body/medical 会镜像到 health
    // 保留旧 mid 兜底，但用 id 去重避免同一条记录被统计两次
    const mods = ['finance','sleep','exercise','emotion','diet','diary','learn','photo','think','inventory','space','work','home','travel','body','relation','time','growth','spirit','pet','medical','todo','health'];
    const hist = [];
    const seenIds = new Set(); // 按 record.id 去重
    mods.forEach(m => {
      const records = readData(m);
      if (!Array.isArray(records)) return;
      records.forEach(r => {
        if (!r) return;
        // 如果有 id 且已见过，跳过（迁移镜像的重复记录）
        if (r.id && seenIds.has(r.id)) return;
        if (r.id) seenIds.add(r.id);
        hist.push({
          mid: m,
          ts: r.created || r.date || r.createdAt || new Date().toISOString(),
          data: r
        });
      });
    });
    hist.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return hist;
  },

  // ===== Phase 2 深度反思方法 =====

  // 根因分析：判断5why是否挖到本质，还是停留在表层
  rootCause(item) {
    const whys = item.whys || [];
    if (whys.length === 0) return '继续追问——根因往往藏在你不想说的那一层。';
    const last = whys[whys.length - 1];
    const shallow = ['因为','所以','我不知道','别人','没办法'];
    const deep = ['我','我的','我害怕','我想要','我不敢','我习惯','我选择'];
    let depthHit = deep.some(k => last.includes(k));
    let shallowHit = shallow.some(k => last.includes(k));
    let lines = [];
    if (whys.length < 3) {
      lines.push(`才${whys.length}层。表层原因往往是"事"，深层原因是"我"。\n继续问——到第3层，你通常会开始不舒服。`);
    } else if (depthHit) {
      lines.push(`第${whys.length}层你回到了"我"——这是根因的特征。\n但你确定这是根，还是只是"听起来深刻"？\n验证方法：如果消除它，触发事件还会发生吗？`);
    } else if (shallowHit) {
      lines.push(`第${whys.length}层仍在解释"为什么发生"，没回到"我做了什么让它发生"。\n5why 的终点不是客观原因，是你能控制的那个点。`);
    } else {
      lines.push(`第${whys.length}层。\n问自己：这个原因，是"环境/他人/运气"给的，还是"我的选择"给的？\n前者是借口，后者是根。`);
    }
    // 重复模式检测：历史上相似trigger
    const all = readData('root_cause');
    if (all.length >= 2) {
      const triggerWords = item.trigger.split('').filter(c => c.trim() && !['，','。','的','了','是','我','一','有','这','那'].includes(c));
      const similar = all.filter(r => r.id !== item.id && triggerWords.slice(0,3).some(w => r.trigger.includes(w)));
      if (similar.length >= 1) {
        lines.push(`\n⚠️ 这不是第一次——你已记录过 ${similar.length} 次类似触发。\n根因如果相同，说明你"知道"但没"改"——知道不是改变，行动才是。`);
      }
    }
    if (!item.root || !item.root.trim()) {
      lines.push(`\n提示：试着用一句话写"根因"。\n好的根因 = 一个你能主动改变的行为/信念，而不是一个你无法控制的事实。`);
    }
    return lines.join('\n');
  },

  // 人际博弈：鬼谷子视角的利益/成本复盘
  interpersonal(item) {
    const lines = [];
    const net = item.net || 0;
    if (item.myCost > 0 && item.myGain === 0) {
      lines.push(`你付出 ${item.myCost}，收益 0。\n这是一次"赔本博弈"。\n问：你换到了什么看不见的东西——人情、安全感、避免冲突？\n如果是这些，那不是亏，是"投资关系"——但要确认对方是否知道你付出了。`);
    } else if (net > 0) {
      lines.push(`净收益 ${net}。\n赢了，但要警觉：\n1. 这次赢是可持续的，还是一次性的？\n2. 对方输了吗？如果输，他会记住——博弈是连续的，不是一次性的。`);
    } else if (net < 0) {
      lines.push(`净亏损 ${Math.abs(net)}。\n亏在明处的，往往是"低成本博弈"；亏在暗处的（情绪、时间、尊严），才是"高成本博弈"。\n问：你真正亏的是哪一种？`);
    } else {
      lines.push(`看似平衡。\n但人际博弈的真正成本不是钱，是"心力"。\n这次之后，你对这个人/这类事是更愿意了，还是更累了？`);
    }
    if (item.theirGoal && !item.myGoal) {
      lines.push(`\n你只写了对方的目标，没写自己的——这是"被动应战"。\n被动的人永远不会赢，因为你不知道自己要什么，赢也只是对方失误。`);
    } else if (item.myGoal && !item.theirGoal) {
      lines.push(`\n你只写了"我要什么"，没写"他要什么"——这是"自我中心博弈"。\n鬼谷子：不知彼而知己，一胜一负。要赢，先看对方图什么。`);
    } else if (item.myGoal && item.theirGoal) {
      lines.push(`\n你图"${item.myGoal}"，他图"${item.theirGoal}"。\n问：这两件事，是零和的，还是可以双赢？\n大多数人际冲突不是利益冲突，是"以为冲突"。`);
    }
    if (!item.lesson || !item.lesson.trim()) {
      lines.push(`\n提示：写一句"教训/收获"。\n不写的博弈，等于没发生过——你会重复同样的错误，只是换了个人。`);
    }
    return lines.join('\n');
  },

  // 定力训练：心境基线 + 训练有效性
  mindfulness(item, list) {
    const lines = [];
    if (item.delta > 0) {
      lines.push(`心境 ${item.beforeLevel}→${item.afterLevel}，提升 ${item.delta}。\n但问：提升来自"方法"，还是来自"事件过去"？\n前者可复用，后者只是时间。`);
    } else if (item.delta < 0) {
      lines.push(`心境 ${item.beforeLevel}→${item.afterLevel}，下降 ${Math.abs(item.delta)}。\n这次"训练"反而让你更糟——可能在逃避，而不是面对。\n真正的定力不是压制情绪，是看见它、不认同它。`);
    } else {
      lines.push(`心境 ${item.beforeLevel}→${item.afterLevel}，没变。\n没变有两种：一是真的稳，二是"假装稳"。\n区分：身体是否还紧绷？脑子是否还在反复想？`);
    }
    // 基线对比
    const recent = (list || []).slice(0, 7);
    if (recent.length >= 3) {
      const avgBefore = recent.reduce((s,x) => s + (x.beforeLevel||3), 0) / recent.length;
      const avgDelta = recent.reduce((s,x) => s + (x.delta||0), 0) / recent.length;
      if (avgBefore <= 2.5) lines.push(`\n近${recent.length}次触发前心境均${avgBefore.toFixed(1)}/5——你的基线偏低。\n基线低的人，遇到小事就崩——这不是"压力大"，是"地基薄"。先养基线，再谈定力。`);
      if (avgDelta <= 0.3) lines.push(`\n近${recent.length}次平均提升仅${avgDelta.toFixed(1)}——方法没用，或用错了。\n换方法：深呼吸无效时，试"身体扫描"；身体扫描无效时，试"离开现场10分钟"。`);
      else if (avgDelta >= 1.5) lines.push(`\n近${recent.length}次平均提升${avgDelta.toFixed(1)}——方法有效。\n但要记住：定力训练是"应急"不是"根治"。频繁触发说明源头没解决。`);
    }
    return lines.join('\n');
  },

  // 心境基线：综合情绪+定力训练数据
  mindfulnessBaseline() {
    const emo = readData('emotion').filter(e => e.rating).slice(-30);
    const mind = readData('mindfulness').slice(0, 30);
    let baseline = null, trend = null;
    if (emo.length >= 3) {
      baseline = emo.reduce((s,x) => s + parseFloat(x.rating), 0) / emo.length;
      const half = Math.floor(emo.length / 2);
      const early = emo.slice(0, half), late = emo.slice(-half);
      const eAvg = early.reduce((s,x) => s + parseFloat(x.rating), 0) / early.length;
      const lAvg = late.reduce((s,x) => s + parseFloat(x.rating), 0) / late.length;
      trend = lAvg - eAvg;
    }
    let avgDelta = null;
    if (mind.length >= 1) {
      avgDelta = mind.reduce((s,x) => s + (x.delta||0), 0) / mind.length;
    }
    let interpretation = '';
    if (baseline === null) interpretation = '数据不足。先记录情绪7天以上，系统会给你建立心境基线。';
    else if (baseline < 2.5) interpretation = `基线${baseline.toFixed(1)}/5，偏低。地基不稳，定力训练效果有限——先补睡眠、营养、运动，再谈心境。`;
    else if (baseline < 3.5) interpretation = `基线${baseline.toFixed(1)}/5，中性。你在"中正"和"麻木"之间——觉察一下，你是真的平静，还是习惯性压抑？`;
    else interpretation = `基线${baseline.toFixed(1)}/5，稳健。警惕：稳定的反面可能是"不痛不痒"——保持觉察，别让稳定变成停滞。`;
    if (trend !== null) {
      interpretation += trend > 0.3 ? `\n趋势：↑ 上升${trend.toFixed(1)}。什么在变好？复制它。` :
                        trend < -0.3 ? `\n趋势：↓ 下降${Math.abs(trend).toFixed(1)}。什么在变差？别等到崩了才动。` :
                        `\n趋势：→ 持平。持平有两种，分清是"稳"还是"卡"。`;
    }
    return { baseline, trend, avgDelta, sampleSize: emo.length, interpretation };
  },

  // 能量审计：单条反馈
  energy(item, list) {
    const lines = [];
    if (item.type === 'drain') {
      lines.push(`消耗 ${item.amount}/10：${item.source}。\n问：这是"必要消耗"还是"无效消耗"？\n必要消耗（如工作）要管理，无效消耗（如刷手机）要切割。`);
      // 重复消耗源
      const same = (list||[]).filter(x => x.type==='drain' && x.source === item.source);
      if (same.length >= 3) {
        const totalDrain = same.reduce((s,x) => s+x.amount, 0);
        lines.push(`\n⚠️ "${item.source}" 已累计消耗 ${totalDrain}/10 × ${same.length}次。\n这是你的能量黑洞——再不管，它会吸干你。`);
      }
    } else {
      lines.push(`充能 ${item.amount}/10：${item.source}。\n问：这是"真充能"还是"假充能"？\n真充能让你事后更有力（运动、独处、深度对话）；假充能让你当下爽、事后空（刷视频、吃糖、购物）。`);
      const same = (list||[]).filter(x => x.type==='gain' && x.source === item.source);
      if (same.length >= 3) {
        const totalGain = same.reduce((s,x) => s+x.amount, 0);
        lines.push(`\n✨ "${item.source}" 已累计充能 ${totalGain}/10 × ${same.length}次。\n这是你的能量源泉——保护它，定期回。`);
      }
    }
    return lines.join('\n');
  },

  // 能量审计汇总
  energyAudit() {
    const now = new Date();
    const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
    const ms = weekAgo.toISOString().split('T')[0];
    const all = readData('energy');
    const recent = all.filter(e => e.date >= ms);
    const drains = recent.filter(e => e.type === 'drain');
    const gains = recent.filter(e => e.type === 'gain');
    const totalDrain = drains.reduce((s,x) => s+x.amount, 0);
    const totalGain = gains.reduce((s,x) => s+x.amount, 0);
    const net = totalGain - totalDrain;
    // Top sources
    const bySrc = {};
    recent.forEach(e => {
      if (!bySrc[e.source]) bySrc[e.source] = { drain: 0, gain: 0, count: 0 };
      bySrc[e.source][e.type] += e.amount;
      bySrc[e.source].count++;
    });
    const topDrains = Object.entries(bySrc).filter(([_,v]) => v.drain > 0).sort((a,b) => b[1].drain - a[1].drain).slice(0, 3).map(([k,v]) => ({ source: k, amount: v.drain, count: v.count }));
    const topGains = Object.entries(bySrc).filter(([_,v]) => v.gain > 0).sort((a,b) => b[1].gain - a[1].gain).slice(0, 3).map(([k,v]) => ({ source: k, amount: v.gain, count: v.count }));
    let interpretation = '';
    if (recent.length === 0) interpretation = '本周无能量记录。开始记录你的消耗与充能——看不见的能量，管不住。';
    else if (net < -10) interpretation = `本周净亏损 ${Math.abs(net)}。你在透支——再撑下去，身体或情绪会替你按下暂停键。`;
    else if (net > 10) interpretation = `本周净充能 ${net}。状态好，但要警觉：充能多的同时，是否在回避该面对的消耗（如困难对话、重要决策）？`;
    else interpretation = `本周基本平衡（净 ${net}）。\n平衡≠健康——要看消耗的是否值得，充能的是否真实。`;
    return { totalDrain, totalGain, net, drainCount: drains.length, gainCount: gains.length, topDrains, topGains, interpretation, sampleSize: recent.length };
  },

  // 自动复盘：周/月
  autoReview(period) {
    const now = new Date();
    const days = period === 'month' ? 30 : 7;
    const start = new Date(now); start.setDate(now.getDate() - days);
    const startStr = start.toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];
    const hist = this.buildHistory();
    const range = hist.filter(x => {
      const d = (x.ts || '').split('T')[0];
      return d >= startStr && d <= today;
    });
    const modules = {};
    range.forEach(r => {
      modules[r.mid] = (modules[r.mid] || 0) + 1;
    });
    const sortedMods = Object.entries(modules).sort((a,b) => b[1] - a[1]);

    // 数据汇总
    const emo = range.filter(x => x.mid === 'emotion').map(x => parseFloat(x.data?.rating || x.data?.level || 0)).filter(v => v > 0);
    const slp = range.filter(x => x.mid === 'sleep').map(x => parseFloat(x.data?.hours || x.data?.duration || 0)).filter(v => v > 0);
    const fin = range.filter(x => x.mid === 'finance');
    const exp = fin.filter(x => x.data?.type === 'expense' || x.data?.type === '支出').reduce((s,x) => s + parseFloat(x.data?.amount || 0), 0);
    const inc = fin.filter(x => x.data?.type === 'income' || x.data?.type === '收入').reduce((s,x) => s + parseFloat(x.data?.amount || 0), 0);

    const energy = readData('energy').filter(e => e.date >= startStr);
    const eDrain = energy.filter(e => e.type === 'drain').reduce((s,x) => s+x.amount, 0);
    const eGain = energy.filter(e => e.type === 'gain').reduce((s,x) => s+x.amount, 0);

    // 鬼谷子式总结
    let summary = [];
    const label = period === 'month' ? '本月' : '本周';
    if (range.length === 0) {
      summary.push(`过去${days}天没有记录。\n没有记录，就没有复盘——你以为的"我记得"，一周后只剩20%。`);
    } else {
      summary.push(`过去${days}天共 ${range.length} 条记录，覆盖 ${Object.keys(modules).length} 个维度。`);
      if (emo.length > 0) {
        const avg = emo.reduce((a,b)=>a+b,0)/emo.length;
        summary.push(`情绪均 ${avg.toFixed(1)}/5。${avg < 2.5 ? '偏低——不是事件问题，是结构问题。' : avg > 3.8 ? '偏高——警惕：是真好，还是记录时美化了自己？' : '中正。'}`);
      }
      if (slp.length > 0) {
        const avg = slp.reduce((a,b)=>a+b,0)/slp.length;
        summary.push(`睡眠均 ${avg.toFixed(1)}h。${avg < 6 ? '透支中——所有"效率"都建立在透支地基上。' : avg > 8 ? '充足——但充足不等于"用在刀刃上"。' : '正常。'}`);
      }
      if (fin.length > 0) {
        const diff = inc - exp;
        summary.push(`收支：收入 ${inc.toFixed(0)}，支出 ${exp.toFixed(0)}，${diff >= 0 ? '净 +' + diff.toFixed(0) : '净 ' + diff.toFixed(0)}。`);
        if (diff < 0) summary.push(`入不敷出。短期可忍，长期是慢性失血——根源往往不是"赚得少"，是"花得无感"。`);
      }
      if (energy.length > 0) {
        summary.push(`能量：消耗 ${eDrain}，充能 ${eGain}，净 ${eGain - eDrain}。${eGain - eDrain < 0 ? '透支——你靠"扛"，但扛是有期限的。' : '盈余——但要确认充能是"真"的。'}`);
      }
      // 最关注 vs 最忽略
      if (sortedMods.length > 0) {
        summary.push(`你最关注：${sortedMods.slice(0,2).map(m => m[0] + '(' + m[1] + ')').join('、')}。`);
        const allMods = ['finance','sleep','exercise','emotion','diet','diary','learn','photo','think','work','home','travel','body','relation','growth','spirit'];
        const ignored = allMods.filter(m => !modules[m]);
        if (ignored.length > 3) summary.push(`你忽略的：${ignored.slice(0,5).join('、')}。\n忽略的不是"不重要"，是"不想面对"——被忽略的地方，往往藏着真正的问题。`);
      }
    }

    // 自动提炼建议
    const suggestions = [];
    if (emo.length >= 3) {
      const lowDays = emo.filter(v => v <= 2).length;
      if (lowDays >= 2) suggestions.push(`情绪低落 ${lowDays} 天——不是情绪问题，是生活结构问题。该调整的不是心情，是节奏。`);
    }
    if (slp.length >= 3) {
      const badDays = slp.filter(v => v < 6).length;
      if (badDays >= 2) suggestions.push(`睡眠不足 ${badDays} 天——睡眠是地基，地基塌了上层都是临时的。`);
    }
    if (eDrain > eGain + 5) suggestions.push(`能量透支——本周消耗远超充能。本周必须安排一次"真充能"（运动/独处/深度对话）。`);

    return {
      period, range: `${startStr} ~ ${today}`,
      totalRecords: range.length,
      moduleBreakdown: sortedMods.map(([k,v]) => ({ module: k, count: v })),
      stats: {
        moodAvg: emo.length ? (emo.reduce((a,b)=>a+b,0)/emo.length).toFixed(2) : null,
        sleepAvg: slp.length ? (slp.reduce((a,b)=>a+b,0)/slp.length).toFixed(2) : null,
        income: inc, expense: exp, net: inc - exp,
        energyDrain: eDrain, energyGain: eGain, energyNet: eGain - eDrain
      },
      summary: summary.join('\n'),
      suggestions,
      generatedAt: new Date().toISOString()
    };
  },

  // ===== Phase 3 成长轴方法 =====

  // 信念：判断是"信念"还是"执念"
  belief(item) {
    const b = item.belief || '';
    const lines = [];
    // 识别绝对化词汇
    const absolutes = ['必须','一定','绝不','永远','从来','所有人','没有人','绝对'];
    const hasAbs = absolutes.some(k => b.includes(k));
    if (hasAbs) {
      lines.push(`⚠️ 这句话有绝对化表达。\n绝对化的"信念"往往是"执念"——真信念能容纳例外，执念不能。\n试着把"必须"改成"通常"，看信念是否还成立。`);
    }
    // 识别来源
    if (!item.source || !item.source.trim()) {
      lines.push(`\n你没写来源。\n信念的来源决定它的硬度：\n- 自己验证的 → 硬，可恃\n- 别人告诉的 → 软，要验\n- 创伤形成的 → 警觉，可能以偏概全`);
    } else if (item.source.includes('痛') || item.source.includes('伤') || item.source.includes('失败')) {
      lines.push(`\n来源是"痛"。痛形成的信念最坚硬，但也最容易偏——它是对一次事件的过度总结。\n问：这件事真的"每次"都这样吗？还是你只记住了痛的那次？`);
    }
    // 信心校准
    if (item.confidence >= 5) {
      lines.push(`\n信心5/5。\n高信心是好事，但也要警觉：你是因为"验证过"才确信，还是因为"想确信"才确信？\n前者是真知，后者是自我安慰。`);
    } else if (item.confidence <= 2) {
      lines.push(`\n信心${item.confidence}/5。\n信心低却还相信，说明这是"想信"而非"已验证"。\n想信的东西，往往是你需要的，不一定是真的。`);
    }
    if (lines.length === 0) lines.push(`信念已记录。\n真正的考验不是"你信不信"，是"现实打不打脸"——定期回来检验它。`);
    return lines.join('\n');
  },

  // 信念检验结果
  beliefTest(item) {
    const lines = [];
    if (item.lastTestResult === 'held') {
      lines.push(`信念通过了检验（held ${item.heldUp}次 / broken ${item.broken}次）。\n但警觉：通过检验的信念会变"硬"——硬了就不愿再质疑。\n真信念越验证越谦卑，不是越傲慢。`);
    } else if (item.lastTestResult === 'broken') {
      lines.push(`信念被打破了（broken ${item.broken}次 / held ${item.heldUp}次）。\n这是好事——破一个错信念，比保一个错信念强一百倍。\n问：是信念错了，还是情境特殊？前者要改信念，后者要加限定。`);
    } else {
      lines.push(`结果不确定。\n不确定比"确定错"更难处理——你可能还在为信念找借口。\n问：如果再来一次，你愿意赌它成立吗？不愿意，就是破了。`);
    }
    if (item.broken >= 2 && item.heldUp === 0) {
      lines.push(`\n🚨 已被打破 ${item.broken} 次，从未成立。\n这不是信念，是执念——继续抱着它，等于用一个错地图导航。该换了。`);
    }
    return lines.join('\n');
  },

  // 品格雷达：单次评分反思 + 演化对比
  character(item, list) {
    const lines = [];
    const dims = ['honesty','courage','resilience','restraint','responsibility','altruism'];
    const labels = { honesty:'诚实', courage:'勇气', resilience:'韧性', restraint:'克制', responsibility:'担当', altruism:'利他' };
    const low = dims.filter(d => item[d] <= 3);
    const high = dims.filter(d => item[d] >= 8);
    if (low.length > 0) lines.push(`偏低：${low.map(d => labels[d]+'('+item[d]+')').join('、')}。\n问：这是真实的自己，还是你想成为的自己？前者要接纳，后者要练。`);
    if (high.length > 0) lines.push(`偏高：${high.map(d => labels[d]+'('+item[d]+')').join('、')}。\n警惕：自评偏高往往是"美化自己"——让别人评你，差距才真实。`);
    // 演化对比
    if (list.length >= 2) {
      const prev = list[1]; // 倒数第二条
      const changes = dims.map(d => ({ dim: d, delta: item[d] - (prev[d] || 5) })).filter(c => Math.abs(c.delta) >= 2);
      if (changes.length > 0) {
        lines.push(`\n较上次变化：`);
        changes.forEach(c => {
          lines.push(`  ${labels[c.dim]} ${c.delta > 0 ? '+'+c.delta : c.delta} — ${c.delta > 0 ? '什么让你变强了？复制它。' : '什么让你变弱了？别让它继续。'}`);
        });
      }
    }
    // 诚实的元反思
    if (item.honesty >= 8 && list.length >= 1) {
      lines.push(`\n元问题：你给"诚实"打了${item.honesty}分——这个高分本身，诚实吗？\n真正诚实的人，往往对自己的诚实存疑。`);
    }
    return lines.join('\n');
  },

  // 品格雷达汇总
  characterRadar() {
    const list = readData('character');
    if (list.length === 0) return { current: null, previous: null, evolution: [], interpretation: '还没有品格自评。诚实是所有品格的基石——先诚实，再谈其他。' };
    const dims = ['honesty','courage','resilience','restraint','responsibility','altruism'];
    const labels = { honesty:'诚实', courage:'勇气', resilience:'韧性', restraint:'克制', responsibility:'担当', altruism:'利他' };
    const current = list[0];
    const previous = list.length >= 2 ? list[1] : null;
    const evolution = dims.map(d => ({
      dim: d, label: labels[d],
      current: current[d],
      previous: previous ? previous[d] : null,
      delta: previous ? (current[d] - previous[d]) : null
    }));
    const avg = dims.reduce((s,d) => s + current[d], 0) / dims.length;
    let interpretation = `当前综合 ${avg.toFixed(1)}/10。`;
    if (avg < 4) interpretation += '\n偏低。品格不是"想有就有"，是"做了才有"——选一个维度，本周做3件相关的小事。';
    else if (avg > 7.5) interpretation += '\n偏高。要警觉自评膨胀——让别人评你一次，差距就是你的盲区。';
    else interpretation += '\n中等。中等不是坏事，是"还在路上"——选一个最想提升的，专项训练。';
    return { current, previous, evolution, average: avg, interpretation };
  },

  // 自我画像：基于所有数据生成"你是谁"
  selfPortrait() {
    const hist = this.buildHistory();
    const emo = readData('emotion').filter(e => e.rating).slice(-30);
    const slp = readData('sleep').slice(-30);
    const fin = readData('finance').slice(-30);
    const ex = readData('exercise').slice(-30);
    const mind = readData('mindfulness').slice(-30);
    const energy = readData('energy').slice(-30);
    const principles = readData('principles');
    const beliefs = readData('beliefs');

    // 维度判断
    const tags = [];
    if (emo.length >= 3) {
      const avg = emo.reduce((s,x) => s + parseFloat(x.rating), 0) / emo.length;
      if (avg >= 4) tags.push({ dim:'情绪', value:'稳定向上', desc:`近${emo.length}次均${avg.toFixed(1)}/5` });
      else if (avg <= 2.5) tags.push({ dim:'情绪', value:'承压中', desc:`近${emo.length}次均${avg.toFixed(1)}/5，需要关注` });
      else tags.push({ dim:'情绪', value:'中正', desc:`均${avg.toFixed(1)}/5` });
    }
    if (slp.length >= 3) {
      const avg = slp.reduce((s,x) => s + parseFloat(x.data?.hours || x.hours || 0), 0) / slp.length;
      tags.push({ dim:'睡眠', value: avg >= 7 ? '规律' : avg >= 6 ? '边缘' : '透支', desc:`均${avg.toFixed(1)}h` });
    }
    if (ex.length >= 3) tags.push({ dim:'运动', value:'活跃', desc:`近30天${ex.length}次` });
    else if (hist.length >= 20) tags.push({ dim:'运动', value:'停滞', desc:'运动记录不足——身体在被忽略' });

    if (fin.length >= 5) {
      const exp = fin.filter(x => x.type === 'expense' || x.type === '支出').reduce((s,x) => s + parseFloat(x.amount || 0), 0);
      const inc = fin.filter(x => x.type === 'income' || x.type === '收入').reduce((s,x) => s + parseFloat(x.amount || 0), 0);
      if (inc > exp) tags.push({ dim:'财务', value:'积累', desc:`净+${(inc-exp).toFixed(0)}` });
      else if (exp > inc) tags.push({ dim:'财务', value:'流出', desc:`净-${(exp-inc).toFixed(0)}` });
    }

    if (energy.length >= 3) {
      const drain = energy.filter(e => e.type === 'drain').reduce((s,x) => s+x.amount, 0);
      const gain = energy.filter(e => e.type === 'gain').reduce((s,x) => s+x.amount, 0);
      tags.push({ dim:'能量', value: gain > drain ? '充盈' : '透支', desc:`消耗${drain}/充能${gain}` });
    }

    if (mind.length >= 3) tags.push({ dim:'定力', value:'训练中', desc:`${mind.length}次记录` });
    if (principles.length >= 3) tags.push({ dim:'原则', value:'沉淀中', desc:`${principles.length}条` });
    if (beliefs.length >= 1) tags.push({ dim:'信念', value:'自觉', desc:`${beliefs.length}条待检验` });

    // 你是谁的一句话
    let oneLine = '';
    const focusMap = {};
    hist.slice(0, 50).forEach(h => { focusMap[h.mid] = (focusMap[h.mid]||0) + 1; });
    const topFocus = Object.entries(focusMap).sort((a,b) => b[1]-a[1])[0];
    if (topFocus) {
      const focusLabels = { finance:'钱', sleep:'睡眠', emotion:'情绪', exercise:'身体', think:'思考', diary:'自省', work:'工作', relation:'关系' };
      oneLine = `一个最近在关注「${focusLabels[topFocus[0]] || topFocus[0]}」的人`;
    }

    // 鬼谷子式总结
    let narrative = '';
    if (tags.length === 0) {
      narrative = '数据太少，画像模糊。继续记录，系统会越来越懂你——画像不是你"想成为谁"，是你"实际是谁"。';
    } else {
      narrative = '基于你的记录，你当前是：\n' + tags.map(t => `• ${t.dim}：${t.value}（${t.desc}）`).join('\n');
      narrative += '\n\n这不是评价，是镜像——镜子里的人，是你想成为的那个吗？';
    }

    return { tags, oneLine, narrative, generatedAt: new Date().toISOString(), sampleSize: hist.length };
  },

  // 反熵增监控：检测生活是否在无序化
  entropyMonitor() {
    const now = new Date();
    const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
    const twoWeekAgo = new Date(now); twoWeekAgo.setDate(now.getDate() - 14);
    const ms = weekAgo.toISOString().split('T')[0];
    const pms = twoWeekAgo.toISOString().split('T')[0];

    const signals = [];
    // 1. 记录频率下降
    const hist = this.buildHistory();
    const thisWeek = hist.filter(x => (x.ts||'').split('T')[0] >= ms).length;
    const lastWeek = hist.filter(x => { const d = (x.ts||'').split('T')[0]; return d >= pms && d < ms; }).length;
    if (lastWeek >= 5 && thisWeek < lastWeek * 0.5) {
      signals.push({ dim:'记录习惯', severity:'high', signal:`记录频率从上周${lastWeek}条降至本周${thisWeek}条`, suggestion:'记录是觉察的开始——频率下降往往是生活失控的早期信号' });
    }
    // 2. 情绪下滑
    const emo = readData('emotion');
    const recentEmo = emo.filter(e => e.date >= ms);
    const prevEmo = emo.filter(e => { const d = e.date; return d >= pms && d < ms; });
    if (recentEmo.length >= 2 && prevEmo.length >= 2) {
      const r = recentEmo.reduce((s,x) => s + parseFloat(x.rating), 0) / recentEmo.length;
      const p = prevEmo.reduce((s,x) => s + parseFloat(x.rating), 0) / prevEmo.length;
      if (r - p < -0.5) signals.push({ dim:'情绪', severity:'high', signal:`情绪均分从${p.toFixed(1)}降至${r.toFixed(1)}`, suggestion:'情绪持续下滑不是事件问题，是结构问题' });
    }
    // 3. 睡眠恶化
    const slp = readData('sleep');
    const recentSlp = slp.filter(s => (s.date || (s.data?.date) || '') >= ms);
    const prevSlp = slp.filter(s => { const d = s.date || s.data?.date || ''; return d >= pms && d < ms; });
    if (recentSlp.length >= 2 && prevSlp.length >= 2) {
      const r = recentSlp.reduce((s,x) => s + parseFloat(x.hours || x.data?.hours || 0), 0) / recentSlp.length;
      const p = prevSlp.reduce((s,x) => s + parseFloat(x.hours || x.data?.hours || 0), 0) / prevSlp.length;
      if (r - p < -0.8) signals.push({ dim:'睡眠', severity:'med', signal:`睡眠均时从${p.toFixed(1)}h降至${r.toFixed(1)}h`, suggestion:'睡眠是地基——地基塌了上层都晃' });
    }
    // 4. 运动停滞
    const ex = readData('exercise');
    const recentEx = ex.filter(e => (e.date || '') >= ms).length;
    if (recentEx === 0 && hist.length >= 10) {
      signals.push({ dim:'运动', severity:'med', signal:'本周无运动记录', suggestion:'身体停滞，精力必降——动起来，哪怕10分钟' });
    }
    // 5. 财务流失
    const fin = readData('finance');
    const recentFin = fin.filter(f => (f.date || '') >= ms);
    const exp = recentFin.filter(f => f.type === 'expense' || f.type === '支出').reduce((s,x) => s + parseFloat(x.amount || 0), 0);
    if (exp > 0) {
      const prevFin = fin.filter(f => { const d = f.date || ''; return d >= pms && d < ms; });
      const prevExp = prevFin.filter(f => f.type === 'expense' || f.type === '支出').reduce((s,x) => s + parseFloat(x.amount || 0), 0);
      if (prevExp > 0 && exp > prevExp * 1.5) {
        signals.push({ dim:'财务', severity:'med', signal:`本周支出${exp.toFixed(0)}，比上周${prevExp.toFixed(0)}增加${((exp/prevExp-1)*100).toFixed(0)}%`, suggestion:'支出突增往往是情绪补偿——查根因，不止血' });
      }
    }
    // 6. 未解决的熵增日志
    const entropyLogs = readData('entropy_logs').filter(e => !e.resolved);
    entropyLogs.forEach(e => signals.push({ dim:e.dimension, severity:e.severity, signal:e.signal, suggestion:e.note || '需要处理', logId: e.id }));

    const entropyScore = signals.length === 0 ? 0 : signals.reduce((s,x) => s + (x.severity === 'high' ? 3 : x.severity === 'med' ? 2 : 1), 0);
    let interpretation = '';
    if (entropyScore === 0) interpretation = '熵增低，生活有序。但有序不等于成长——别让"有序"变成"停滞"。';
    else if (entropyScore <= 4) interpretation = `熵增轻度（${entropyScore}）。在可控范围——但要主动干预，别让它累积成崩塌。`;
    else if (entropyScore <= 8) interpretation = `熵增中度（${entropyScore}）。多个维度在恶化——这不是运气差，是系统出了问题。`;
    else interpretation = `🚨 熵增高度（${entropyScore}）。生活正在快速无序化——必须立即行动，从最容易的那个维度开始恢复。`;

    return { signals, entropyScore, interpretation, weekRecords: thisWeek, lastWeekRecords: lastWeek };
  },

  // 反脆弱评估：面对黑天鹅的承受力
  antifragile(item) {
    if (!item) return null;
    const lines = [];
    const dims = { financial:'财务缓冲', skill:'技能冗余', social:'关系网络', health:'身体储备', mental:'心智韧性' };
    const total = item.financial + item.skill + item.social + item.health + item.mental;
    const avg = total / 5;
    // 最短板
    const entries = Object.entries(dims);
    const weakest = entries.reduce((min, [k,v]) => item[k] < item[min[0]] ? [k,v] : min, entries[0]);
    lines.push(`综合 ${avg.toFixed(1)}/10，最短板：${weakest[1]}(${item[weakest[0]]}/10)。\n反脆弱的强度 = 最短板的强度——桶能装多少水，由最短的那块板决定。`);
    // 木桶效应
    if (item[weakest[0]] <= 3) {
      lines.push(`\n🚨 ${weakest[1]}只有${item[weakest[0]]}/10——这是你的致命短板。\n黑天鹅来时，不会从你最硬的地方打你，会从最软的地方。\n本周必须补这块。`);
    }
    // 平衡度
    const values = ['financial','skill','social','health','mental'].map(k => item[k]);
    const max = Math.max(...values), min = Math.min(...values);
    if (max - min >= 5) {
      lines.push(`\n失衡严重：最高${max}，最低${min}。\n反脆弱不是某一项特别强，是各项均衡——失衡的人，一次打击就崩。`);
    }
    // 各维度提醒
    if (item.financial <= 4) lines.push(`\n💰 财务缓冲低——存6个月生活费前，你不算自由。`);
    if (item.skill <= 4) lines.push(`\n🎯 技能冗余低——只会一件事的人，是单点故障。多学一门，就多一条命。`);
    if (item.social <= 4) lines.push(`\n👥 关系网络低——独狼抗风险能力最差。 deepen 3段关系，比认识100人有用。`);
    if (item.health <= 4) lines.push(`\n💪 身体储备低——所有财富都需要身体承载。健康归零，一切归零。`);
    if (item.mental <= 4) lines.push(`\n🧠 心智韧性低——遭遇挫折时的反弹力，是最后的保险。练定力，就是在存这份保险。`);
    return lines.join('\n');
  },

  // ===== Phase 4 船长工具方法 =====

  // 北极星：校准目标对齐
  northStar(item) {
    const lines = [];
    if (!item.ultimate || !item.ultimate.trim()) {
      lines.push('没写终局目标。\n没有终局，所有努力都是漂移——你以为在前进，其实只是移动。\n问自己：如果只能活成一种样子，那是什么？');
    } else {
      // 校准对齐
      if (item.today && !item.thisWeek) lines.push('你写了"今天"却没写"本周"——日行动没有周计划承接，等于随机。');
      if (item.thisWeek && !item.thisQuarter) lines.push('有周计划没季度计划——短期行动没有中期方向，容易陷入"忙碌但无效"。');
      if (item.thisQuarter && !item.oneYear) lines.push('有季度没年度——中期目标缺少年度锚点，方向会漂移。');
      if (item.oneYear && !item.fiveYear) lines.push('有年度没5年——年度目标没有长期愿景，会被短期诱惑带偏。');
      if (item.fiveYear && !item.ultimate) lines.push('有5年没终局——5年是为终局服务的，没有终局的5年只是"再活5年"。');
      if (item.today && item.ultimate) {
        lines.push(`\n对齐检查：\n今天：${item.today}\n终局：${item.ultimate}\n问：今天的这个行动，能让终局近1%吗？\n不能的话，你今天在为谁活？`);
      }
    }
    if (lines.length === 0) lines.push('坐标系已建立。\n但坐标不是写一次就完了——每周回看"今天"是否对齐"本周"，每月回看是否对齐"季度"。漂移是常态，校准是功夫。');
    return lines.join('\n');
  },

  // 危机预案：检验预案的完备性
  crisisPlan(item) {
    const lines = [];
    if (item.probability === 'high' && item.impact === 'critical') {
      lines.push(`🚨 高概率 + 致命影响。\n这不是"可能"，是"迟早"——预案必须可执行，不能停留在口号。\n问：48小时内你能真的启动吗？`);
    }
    if (!item.immediateAction) lines.push(`\n没写"立即行动"——危机头24小时决定70%的结局。\n写下3件头24小时必须做的事，越具体越好。`);
    if (!item.threeDayPlan) lines.push(`\n没写"3天计划"——危机不是1天的事，是1周到1个月。\n3天内的目标：止血、稳住、开始恢复。`);
    if (!item.recoveryPlan) lines.push(`\n没写"恢复计划"——挺过危机不等于走出来，恢复期往往更长更难。`);
    if (item.immediateAction && item.threeDayPlan && item.recoveryPlan) {
      lines.push(`\n预案完整。但完整≠可执行——\n问：这些计划里有"谁帮你"吗？独自预案往往失败，因为人在危机中会冻结。\n指定一个联系人，危机时通知他。`);
    }
    if (!item.precondition) lines.push(`\n提示：写"前置信号"——危机很少突然来，总有征兆。\n识别征兆，能在危机爆发前就启动预案。`);
    return lines.join('\n');
  },

  // 临终测试：反向校准当下
  deathTest(item) {
    const lines = [];
    if (item.regrets) lines.push(`你写下的遗憾：${item.regrets}\n问：这件事，你现在能改吗？\n能改却没改 = 你正在亲手制造未来的遗憾。\n不能改 = 放下它，别再消耗。`);
    if (item.undone) lines.push(`\n想做却没做：${item.undone}\n"没做"比"做错"更可怕——做错可以改，没做只能假设。\n问：你是在等"准备好"吗？准备好是谎言，开始才是真的。`);
    if (item.proudOf) lines.push(`\n让你骄傲的：${item.proudOf}\n这是你的北极星——多做这件事，少做那些"看起来重要"的事。`);
    if (item.wouldChange) lines.push(`\n你想改变的：${item.wouldChange}\n问：你今天做了什么，正在让这个改变发生？\n没做的话，临终时的遗憾，就是现在的你写的。`);
    if (item.focus) lines.push(`\n你的聚焦：${item.focus}\n好。但聚焦不是想一次就够——把它写在显眼处，每周问自己"这周我靠近它了吗"。`);
    if (!item.regrets && !item.undone && !item.wouldChange) {
      lines.push('你什么都没写。\n这不是"没问题"，是"没敢问"——临终测试的价值，就在于敢问那些平时回避的问题。');
    }
    return lines.join('\n');
  },

  // 年度叙事：把数据写成故事
  narrative(year) {
    const yearStart = `${year}-01-01`, yearEnd = `${year}-12-31`;
    const hist = this.buildHistory().filter(x => {
      const d = (x.ts || '').split('T')[0];
      return d >= yearStart && d <= yearEnd;
    });
    const modules = {};
    hist.forEach(h => { modules[h.mid] = (modules[h.mid] || 0) + 1; });
    const sortedMods = Object.entries(modules).sort((a,b) => b[1] - a[1]);

    const emo = hist.filter(x => x.mid === 'emotion').map(x => parseFloat(x.data?.rating || 0)).filter(v => v > 0);
    const slp = hist.filter(x => x.mid === 'sleep').map(x => parseFloat(x.data?.hours || x.data?.duration || 0)).filter(v => v > 0);
    const fin = hist.filter(x => x.mid === 'finance');
    const exp = fin.filter(x => x.data?.type === 'expense' || x.data?.type === '支出').reduce((s,x) => s + parseFloat(x.data?.amount || 0), 0);
    const inc = fin.filter(x => x.data?.type === 'income' || x.data?.type === '收入').reduce((s,x) => s + parseFloat(x.data?.amount || 0), 0);
    const energy = readData('energy').filter(e => e.date >= yearStart && e.date <= yearEnd);
    const eDrain = energy.filter(e => e.type === 'drain').reduce((s,x) => s+x.amount, 0);
    const eGain = energy.filter(e => e.type === 'gain').reduce((s,x) => s+x.amount, 0);
    const principles = readData('principles').filter(p => (p.createdAt || '') >= yearStart);
    const beliefs = readData('beliefs').filter(b => (b.createdAt || '') >= yearStart);

    // 写成故事
    let story = `${year}年，你记录了 ${hist.length} 次，覆盖 ${Object.keys(modules).length} 个维度。\n\n`;
    if (sortedMods.length > 0) {
      story += `这一年，你最多的注意力给了：${sortedMods.slice(0,3).map(m => `${m[0]}(${m[1]}次)`).join('、')}。\n`;
      story += `最少关注的是：${sortedMods.slice(-2).map(m => `${m[0]}(${m[1]}次)`).join('、')}。\n\n`;
    }
    if (emo.length > 0) {
      const avg = emo.reduce((a,b)=>a+b,0) / emo.length;
      const high = emo.filter(v => v >= 4).length;
      const low = emo.filter(v => v <= 2).length;
      story += `情绪：全年均 ${avg.toFixed(1)}/5。${high} 次高涨，${low} 次低谷。\n`;
      story += avg > 3.5 ? `你今年总体是"向上的"——但向上的同时，有没有回避该面对的低谷？\n\n` : avg < 2.5 ? `这一年你过得辛苦——但辛苦往往是转弯的地方。\n\n` : `这一年情绪平稳——平稳是福，也是警讯：是否"平稳"代替了"成长"？\n\n`;
    }
    if (slp.length > 0) {
      const avg = slp.reduce((a,b)=>a+b,0) / slp.length;
      story += `睡眠：全年均 ${avg.toFixed(1)} 小时。\n`;
      story += avg >= 7 ? `你照顾好了身体这个容器。\n\n` : `你在透支——所有"效率"都建立在这个透支上。\n\n`;
    }
    if (fin.length > 0) {
      story += `财务：收入 ${inc.toFixed(0)}，支出 ${exp.toFixed(0)}，${inc >= exp ? '净+'+(inc-exp).toFixed(0) : '净'+(inc-exp).toFixed(0)}。\n`;
      story += inc >= exp ? `你在积累——但积累是为了什么？\n\n` : `你在流失——根源往往不是赚得少，是花得无感。\n\n`;
    }
    if (energy.length > 0) {
      story += `能量：消耗 ${eDrain}，充能 ${eGain}。\n`;
      story += eGain > eDrain ? `你是充盈的——记得保护你的能量源泉。\n\n` : `你是透支的——你的能量黑洞在哪里？\n\n`;
    }
    if (principles.length > 0) story += `你提炼了 ${principles.length} 条原则——这是你今年真正的财富。\n`;
    if (beliefs.length > 0) {
      const tested = beliefs.filter(b => b.tested > 0).length;
      const broken = beliefs.filter(b => b.broken > 0).length;
      story += `你记录了 ${beliefs.length} 条信念，检验了 ${tested} 条，打破 ${broken} 条。${broken > 0 ? '破一个错信念，比保一个错信念强百倍。\n' : '但没检验过的信念，只是想法。\n'}`;
    }

    // 鬼谷子式年度总结
    let conclusion = '';
    if (hist.length === 0) conclusion = `${year}年，你没有留下记录。\n没有记录的一年，等于没活过——记忆会骗你，数据不会。\n明年，留下点什么。`;
    else if (hist.length < 30) conclusion = `${year}年，你记录得太少。\n记录稀疏的人，活得也稀疏——不是生活没发生，是你没看。`;
    else conclusion = `${year}年，你认真地活过、记录过。\n但记录不是终点——这些数据要变成明年的判断力、原则、底线。\n否则，记录只是另一种形式的"假装在努力"。`;

    return { year, totalRecords: hist.length, story, conclusion, stats: { moodAvg: emo.length ? (emo.reduce((a,b)=>a+b,0)/emo.length).toFixed(2) : null, sleepAvg: slp.length ? (slp.reduce((a,b)=>a+b,0)/slp.length).toFixed(2) : null, income: inc, expense: exp, energyDrain: eDrain, energyGain: eGain, principles: principles.length, beliefs: beliefs.length } };
  },

  // 船长宣言
  manifesto(item) {
    const lines = [];
    if (!item.body || item.body.trim().length < 20) {
      lines.push('宣言太短。\n宣言不是口号，是你对自己的契约——短到一句话的宣言，往往撑不过第一次危机。\n写下你愿意为什么付出代价，那才是真宣言。');
    } else {
      // 检查是否过于正面
      const positives = ['相信','坚持','永远','美好','光明','成功'];
      const hasPos = positives.some(k => item.body.includes(k));
      if (hasPos && !item.body.includes('代价') && !item.body.includes('放弃') && !item.body.includes('不')) {
        lines.push('宣言只有"正面"。\n真实的宣言必须包含"代价"——你愿意为什么放弃其他？\n不付代价的宣言，是许愿，不是契约。');
      }
      lines.push('\n宣言已签订。\n但记住：宣言的价值不在"签"，在"履行"——\n每月回看一次：我这个月做的事，对得起这份宣言吗？\n答不上来，要么改行为，要么改宣言——别让宣言变成墙上的装饰。');
    }
    return lines.join('\n');
  },

  // ===== Phase 5 深度认知引擎方法 =====

  // 1. 元认知反思：检测"思维方式本身"的问题
  metacognition(hist) {
    const lines = [];
    const details = {};
    if (!hist) hist = this.buildHistory();

    // 检查回避性记录
    const emo = hist.filter(x => x.mid === 'emotion');
    const negativeRecords = emo.filter(e => parseFloat(e.data?.rating || e.data?.level || 3) <= 2);
    const positiveRecords = emo.filter(e => parseFloat(e.data?.rating || e.data?.level || 3) >= 4);
    if (emo.length >= 5) {
      const negRatio = negativeRecords.length / emo.length;
      const posRatio = positiveRecords.length / emo.length;
      details.avoidantRecording = { negativeCount: negativeRecords.length, positiveCount: positiveRecords.length, total: emo.length, negativeRatio: negRatio };
      if (negRatio < 0.1 && posRatio > 0.6) {
        lines.push(`⚠️ 回避性记录：${emo.length}次情绪记录中，负面仅${negativeRecords.length}次，正面${positiveRecords.length}次。\n你可能在"只记好事"——不是生活没负面，是你在回避面对。\n回避不是保护，是让问题在暗处发酵。`);
      } else if (negRatio > 0.6) {
        lines.push(`⚠️ 沉溺性记录：${emo.length}次情绪记录中，负面占${(negRatio*100).toFixed(0)}%。\n你可能在"只记坏事"——不是生活没正面，是注意力被痛苦吸走。\n沉溺不是深刻，是被情绪绑架。`);
      }
    }

    // 检查选择性记录
    const moduleCounts = {};
    hist.forEach(h => { moduleCounts[h.mid] = (moduleCounts[h.mid] || 0) + 1; });
    const sortedMods = Object.entries(moduleCounts).sort((a, b) => b[1] - a[1]);
    const allMods = ['finance','sleep','exercise','emotion','diet','diary','learn','think','work','body','relation','growth','spirit'];
    const coveredMods = Object.keys(moduleCounts);
    const missingMods = allMods.filter(m => !coveredMods.includes(m));
    details.selectiveRecording = { totalModules: coveredMods.length, missingModules: missingMods, topModules: sortedMods.slice(0, 3) };
    if (coveredMods.length <= 3 && hist.length >= 10) {
      lines.push(`⚠️ 选择性记录：你只覆盖了${coveredMods.length}个维度（${coveredMods.join('、')}）。\n你在选择性地看见自己——被忽略的${missingMods.slice(0, 3).join('、')}，往往藏着真正的问题。`);
    }

    // 检测叙事偏差
    const diary = hist.filter(x => x.mid === 'diary');
    if (diary.length >= 3) {
      const positiveWords = ['成功','美好','开心','棒','优秀','完美','顺利','赢'];
      const negativeWords = ['失败','糟糕','痛苦','难','差','糟糕','崩溃','焦虑'];
      let posCount = 0, negCount = 0;
      diary.forEach(d => {
        const c = (d.data?.content || '').toString();
        if (positiveWords.some(w => c.includes(w))) posCount++;
        if (negativeWords.some(w => c.includes(w))) negCount++;
      });
      details.narrativeBias = { positiveEntries: posCount, negativeEntries: negCount, total: diary.length };
      if (posCount > negCount * 2 && posCount >= 3) {
        lines.push(`⚠️ 叙事偏差：日记中正面词汇是负面的${(posCount/Math.max(negCount,1)).toFixed(1)}倍。\n你可能在用"美化"保护自己——但真实的成长需要看见不完美。`);
      }
    }

    // 思维方式的反思问题
    const questions = [];
    if (details.avoidantRecording && details.avoidantRecording.negativeRatio < 0.1) {
      questions.push('你回避记录负面情绪，是因为它们不存在，还是因为你不想面对？');
    }
    if (details.selectiveRecording && details.selectiveRecording.missingModules.length > 0) {
      questions.push(`你忽略了${details.selectiveRecording.missingModules.slice(0,2).join('、')}——这些对你来说意味着什么？`);
    }
    if (questions.length === 0 && Object.keys(details).length === 0) {
      questions.push('你的记录习惯目前较均衡。\n但要警觉：均衡可能是真均衡，也可能是"没什么值得记录"——后者是麻木，不是平和。');
    }
    lines.push('\n反思你的思维方式：');
    questions.forEach((q, i) => { lines.push(`  ${i+1}. ${q}`); });

    const score = Math.round((details.avoidantRecording ? (1 - Math.abs(details.avoidantRecording.negativeRatio - 0.3) * 2) * 5 : 3) +
      (details.selectiveRecording ? Math.min(coveredMods.length / allMods.length, 1) * 3 : 1) +
      (details.narrativeBias ? (details.narrativeBias.negativeEntries >= details.narrativeBias.positiveEntries ? 2 : 0.5) : 1));

    return { text: lines.join('\n'), score: Math.max(0, Math.min(10, score)), details };
  },

  // 2. 认知偏差检测
  cognitiveBias(hist) {
    const lines = [];
    const details = {};
    if (!hist) hist = this.buildHistory();

    // 确认偏差：是否倾向于寻找支持自己已有判断的证据
    const emo = hist.filter(x => x.mid === 'emotion').slice(0, 20);
    const diary = hist.filter(x => x.mid === 'diary').slice(0, 10);
    let confirmationBias = 0;
    if (emo.length >= 5) {
      const lowMoods = emo.filter(e => parseFloat(e.data?.rating || 3) <= 2);
      const diaryNeg = diary.filter(d => {
        const c = (d.data?.content || '').toString();
        return ['难','痛苦','失败','焦虑','差','糟糕'].some(w => c.includes(w));
      });
      const samePeriod = lowMoods.filter(lm => {
        const d = (lm.ts || '').split('T')[0];
        return diaryNeg.some(dn => (dn.ts || '').split('T')[0] === d);
      });
      confirmationBias = lowMoods.length > 0 && samePeriod.length / lowMoods.length > 0.5 ? 1 : 0;
    }
    details.confirmationBias = { detected: confirmationBias > 0, score: confirmationBias };

    // 锚定效应：是否被最初数据过度影响
    const fin = hist.filter(x => x.mid === 'finance').slice(0, 30);
    if (fin.length >= 5) {
      const firstHalf = fin.slice(0, Math.floor(fin.length / 2));
      const secondHalf = fin.slice(Math.floor(fin.length / 2));
      const firstAvg = firstHalf.reduce((s, x) => s + parseFloat(x.data?.amount || 0), 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, x) => s + parseFloat(x.data?.amount || 0), 0) / secondHalf.length;
      const anchoringStrength = firstAvg > 0 && Math.abs(secondAvg - firstAvg) / firstAvg < 0.15 ? 1 : 0;
      details.anchoringEffect = { firstHalfAvg: firstAvg.toFixed(0), secondHalfAvg: secondAvg.toFixed(0), detected: anchoringStrength > 0 };
      if (anchoringStrength) lines.push(`⚓ 锚定效应：前半段均值${firstAvg.toFixed(0)}，后半段${secondAvg.toFixed(0)}——变化<15%。\n你可能被最初的消费水平"锚定"了——即使情况变化，你仍在参考那个初始数字。`);
    }

    // 损失厌恶：是否对"损失"的敏感度远高于"收益"
    if (fin.length >= 5) {
      const expenses = fin.filter(x => x.data?.type === 'expense' || x.data?.type === '支出');
      const income = fin.filter(x => x.data?.type === 'income' || x.data?.type === '收入');
      const totalExp = expenses.reduce((s, x) => s + parseFloat(x.data?.amount || 0), 0);
      const totalInc = income.reduce((s, x) => s + parseFloat(x.data?.amount || 0), 0);
      const lossAversion = totalExp > totalInc * 1.5 && totalInc > 0 ? 1 : 0;
      details.lossAversion = { totalExpense: totalExp.toFixed(0), totalIncome: totalInc.toFixed(0), detected: lossAversion > 0 };
      if (lossAversion) lines.push(`💔 损失厌恶：支出${totalExp.toFixed(0)}远大于收入${totalInc.toFixed(0)}。\n你可能对"损失"的敏感度远高于"收益"——这让你过度保守，不敢冒险，也不敢投资自己。`);
    }

    // 可得性启发：是否用容易想到的例子做判断
    if (hist.length >= 5) {
      const recentMoods = emo.slice(0, 5);
      const olderMoods = emo.slice(5, 15);
      if (recentMoods.length >= 3 && olderMoods.length >= 3) {
        const rAvg = recentMoods.reduce((s, x) => s + parseFloat(x.data?.rating || 3), 0) / recentMoods.length;
        const oAvg = olderMoods.reduce((s, x) => s + parseFloat(x.data?.rating || 3), 0) / olderMoods.length;
        const availability = Math.abs(rAvg - oAvg) > 1 ? 1 : 0;
        details.availabilityHeuristic = { recentAvg: rAvg.toFixed(1), olderAvg: oAvg.toFixed(1), detected: availability > 0 };
        if (availability) lines.push(`📌 可得性启发：近5次情绪${rAvg.toFixed(1)}，之前${oAvg.toFixed(1)}——差异显著。\n你可能在用"最近容易想到的"来判断整体，而非看全貌。`);
      }
    }

    // 归因偏差：成功归内因，失败归外因
    const successEntries = diary.filter(d => {
      const c = (d.data?.content || '').toString();
      return ['成功','做成','完成','赢','棒'].some(w => c.includes(w));
    });
    const failureEntries = diary.filter(d => {
      const c = (d.data?.content || '').toString();
      return ['失败','没成','搞砸','输','错'].some(w => c.includes(w));
    });
    if (successEntries.length >= 1 && failureEntries.length >= 1) {
      const selfAttributionWords = ['我','我的','我做','我选择','我努力'];
      const externalAttributionWords = ['他','别人','运气','环境','没办法'];
      const successSelf = successEntries.filter(e => selfAttributionWords.some(w => (e.data?.content || '').includes(w))).length;
      const failureExternal = failureEntries.filter(e => externalAttributionWords.some(w => (e.data?.content || '').includes(w))).length;
      const attributionBias = successSelf > successEntries.length * 0.5 && failureExternal > failureEntries.length * 0.5 ? 1 : 0;
      details.attributionBias = { successInternal: successSelf, successTotal: successEntries.length, failureExternal: failureExternal, failureTotal: failureEntries.length, detected: attributionBias > 0 };
      if (attributionBias) lines.push(`🎯 归因偏差：成功${successSelf}/${successEntries.length}次归内因，失败${failureExternal}/${failureEntries.length}次归外因。\n你可能在"成功时说'我厉害'，失败时说'环境不好'——这是自我保护，但也是自我欺骗。`);
    }

    // 汇总
    const detectedCount = Object.values(details).filter(d => d && d.detected).length;
    lines.unshift(`检测到${detectedCount}种认知偏差。\n`);
    if (detectedCount === 0) {
      lines.push('目前未检测到明显的认知偏差。\n但"没检测到"不等于"没有"——偏差最擅长的就是藏在你看不见的地方。');
    }

    const score = 10 - detectedCount * 1.5;
    return { text: lines.join('\n'), score: Math.max(0, score), details };
  },

  // 3. 轨迹分析：30天/90天趋势
  trajectory(hist, days) {
    days = days || 30;
    const lines = [];
    const details = {};
    if (!hist) hist = this.buildHistory();

    const now = new Date();
    const start = new Date(now); start.setDate(now.getDate() - days);
    const startStr = start.toISOString().split('T')[0];

    const range = hist.filter(x => {
      const d = (x.ts || '').split('T')[0];
      return d >= startStr;
    });

    // 计算各核心维度趋势
    const dims = {
      sleep: { label: '睡眠', extract: (d) => parseFloat(d.data?.hours || d.data?.duration || 0), unit: 'h' },
      emotion: { label: '情绪', extract: (d) => parseFloat(d.data?.rating || d.data?.level || 0), unit: '/5' },
      finance: { label: '财务', extract: (d) => { if (d.data?.type === 'expense' || d.data?.type === '支出') return -parseFloat(d.data?.amount || 0); if (d.data?.type === 'income' || d.data?.type === '收入') return parseFloat(d.data?.amount || 0); return 0; }, unit: '元净' },
      exercise: { label: '运动', extract: (d) => parseFloat(d.data?.duration || 0), unit: 'min' }
    };

    const trends = {};
    Object.entries(dims).forEach(([mid, cfg]) => {
      const records = range.filter(x => x.mid === mid);
      if (records.length < 2) return;
      const sorted = records.slice().sort((a, b) => (a.ts < b.ts ? 1 : -1));
      const half = Math.floor(sorted.length / 2);
      const firstHalf = sorted.slice(0, half);
      const secondHalf = sorted.slice(-half);
      const fAvg = firstHalf.reduce((s, x) => s + cfg.extract(x), 0) / firstHalf.length;
      const sAvg = secondHalf.reduce((s, x) => s + cfg.extract(x), 0) / secondHalf.length;
      const change = sAvg - fAvg;
      const pct = fAvg !== 0 ? (change / Math.abs(fAvg)) * 100 : 0;
      const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      trends[mid] = {
        label: cfg.label,
        firstHalfAvg: fAvg.toFixed(1),
        secondHalfAvg: sAvg.toFixed(1),
        change: change.toFixed(1),
        changePct: pct.toFixed(1),
        direction,
        sampleSize: records.length
      };
    });

    details[`trend_${days}d`] = trends;

    // 检测"悄悄恶化"的指标
    const stealthDecline = [];
    Object.values(trends).forEach(t => {
      if (t.direction === 'down' && t.sampleSize >= 3) {
        stealthDecline.push(`${t.label}：${t.firstHalfAvg}→${t.secondHalfAvg}（${t.changePct}%）`);
      }
    });
    details.stealthDecline = stealthDecline;

    if (stealthDecline.length > 0) {
      lines.push(`⚠️ 悄悄恶化的指标：\n${stealthDecline.map(s => '  • ' + s).join('\n')}\n这些变化缓慢但持续向下——就像温水煮青蛙，等你察觉时可能已经很深了。`);
    }

    // 进步vs退步评估
    const improving = Object.values(trends).filter(t => t.direction === 'up');
    const declining = Object.values(trends).filter(t => t.direction === 'down');
    const flat = Object.values(trends).filter(t => t.direction === 'flat');

    lines.push(`\n${days}天评估：`);
    lines.push(`  进步维度（${improving.length}）：${improving.map(t => t.label + ' ↑').join('、') || '无'}`);
    lines.push(`  退步维度（${declining.length}）：${declining.map(t => t.label + ' ↓').join('、') || '无'}`);
    lines.push(`  持平维度（${flat.length}）：${flat.map(t => t.label + ' →').join('、') || '无'}`);

    if (declining.length > improving.length) {
      lines.push(`\n🚨 退步速度超过进步速度。\n这不是"没进步"的问题，是"在倒退"——有些东西正在悄悄流失。`);
    } else if (improving.length > declining.length) {
      lines.push(`\n✨ 进步大于退步。\n但要确认：进步的维度是不是你真正在意的？如果"不重要的进步"盖过了"重要的退步"，那仍是退步。`);
    } else if (Object.keys(trends).length > 0) {
      lines.push(`\n持平。\n持平不是稳定，是"没变化"——没变化可能是在等待，也可能是在停滞。`);
    } else {
      lines.push(`\n数据不足，无法生成${days}天趋势。`);
    }

    const score = Object.values(trends).reduce((s, t) => s + (t.direction === 'up' ? 1 : t.direction === 'down' ? -1 : 0), 0);
    return { text: lines.join('\n'), score: Math.max(0, Math.min(10, 5 + score)), details };
  },

  // 4. 二阶效应分析：行为连锁反应
  secondOrderEffect(item, hist) {
    const lines = [];
    const details = { firstOrder: [], secondOrder: [], thirdOrder: [], warnings: [] };
    if (!hist) hist = this.buildHistory();
    if (!item) return { text: '没有分析对象。', score: 5, details };

    const action = item.action || '';
    const mid = item.mid || '';

    // 一阶效应：直接结果
    const firstOrderMap = {
      sleep: { '少睡': ['精力下降', '判断力下降'], '多睡': ['效率提升', '情绪稳定'] },
      exercise: { '运动': ['精力消耗', '短期疲惫'], '不运动': ['体力下降', '压力累积'] },
      finance: { '消费': ['心理安慰', '短期满足'], '储蓄': ['安全感提升', '长期自由'] },
      emotion: { '压抑': ['短期不爆发', '长期积压'], '表达': ['短期释放', '关系变化'] }
    };

    // 分析一阶效应
    if (firstOrderMap[mid]) {
      const matchKey = Object.keys(firstOrderMap[mid]).find(k => action.includes(k));
      if (matchKey) {
        details.firstOrder = firstOrderMap[mid][matchKey].map(r => ({ effect: r, order: 1 }));
        lines.push(`一阶效应（直接结果）：${details.firstOrder.map(r => r.effect).join('、')}`);
      }
    }
    if (details.firstOrder.length === 0) {
      const firstGuesses = [
        { effect: '直接的情绪反应', order: 1 },
        { effect: '即时的生理感受', order: 1 }
      ];
      details.firstOrder = firstGuesses;
      lines.push(`一阶效应：${firstGuesses.map(r => r.effect).join('、')}`);
    }

    // 二阶效应：直接结果的结果
    const secondOrderEffects = [
      { trigger: '精力下降', effect: '决策质量下降，可能做出糟糕选择' },
      { trigger: '判断力下降', effect: '更容易冲动消费/决策，事后后悔' },
      { trigger: '心理安慰', effect: '真实问题未被解决，下次用同样方式逃避' },
      { trigger: '短期疲惫', effect: '次日效率下降，可能影响工作/关系' },
      { trigger: '压力累积', effect: '可能在不经意间对他人发火或崩溃' },
      { trigger: '安全感提升', effect: '更敢于冒险和投资，进入正向循环' },
      { trigger: '长期积压', effect: '最终以更激烈的方式爆发，伤害关系和自己' }
    ];

    details.firstOrder.forEach(fo => {
      const match = secondOrderEffects.find(s => fo.effect.includes(s.trigger) || s.trigger.includes(fo.effect));
      if (match) {
        details.secondOrder.push({ effect: match.effect, order: 2, source: fo.effect });
      }
    });

    if (details.secondOrder.length === 0) {
      details.secondOrder = [{ effect: '直接结果影响了你的下一步选择', order: 2, source: '通用' }];
    }

    lines.push(`二阶效应（结果的结果）：\n${details.secondOrder.map(r => `  ${r.effect}`).join('\n')}`);

    // 三阶效应：长期影响
    const thirdOrderEffects = [
      { trigger: '决策质量下降', effect: '多次糟糕决策累积，形成自我怀疑的恶性循环' },
      { trigger: '事后后悔', effect: '后悔→自责→更低自尊→更差决策，形成闭环' },
      { trigger: '真实问题未被解决', effect: '问题持续存在且恶化，最终需要更大代价解决' },
      { trigger: '效率下降', effect: '工作积压→加班→睡眠更少→效率更低，形成恶性循环' },
      { trigger: '对他人发火', effect: '伤害关系→愧疚→回避社交→更多情绪积压' },
      { trigger: '正向循环', effect: '信心累积→更大胆行动→更多正向反馈，螺旋上升' },
      { trigger: '更激烈爆发', effect: '可能导致关系破裂、信任丧失、自我失控' }
    ];

    details.secondOrder.forEach(so => {
      const match = thirdOrderEffects.find(t => so.effect.includes(t.trigger) || t.trigger.includes(so.effect));
      if (match) {
        details.thirdOrder.push({ effect: match.effect, order: 3, source: so.effect });
      }
    });

    if (details.thirdOrder.length === 0) {
      details.thirdOrder = [{ effect: '长期来看，这个行为会塑造你的习惯和身份认同', order: 3, source: '通用' }];
    }

    lines.push(`三阶效应（长期影响）：\n${details.thirdOrder.map(r => `  ${r.effect}`).join('\n')}`);

    // 识别"短期有益但长期有害"的行为
    const shortTermGood = ['心理安慰', '短期满足', '精力下降（换时间）', '压抑（避免冲突）'];
    const longTermBad = ['问题未被解决', '后悔', '恶性循环', '长期积压'];
    details.firstOrder.forEach(fo => {
      if (shortTermGood.some(g => fo.effect.includes(g)) || longTermBad.some(b => details.thirdOrder.some(to => to.effect.includes(b)))) {
        details.warnings.push({ action, reason: '短期有益但可能长期有害', firstOrder: fo.effect });
      }
    });

    if (details.warnings.length > 0) {
      lines.push(`\n🚨 警示：${details.warnings.map(w => `"${w.action}" — ${w.reason}`).join('\n')}\n短期舒服的选择，往往是长期的陷阱——你在用未来的自己为现在买单。`);
    } else {
      lines.push(`\n✅ 此行为未检测到明显的"短期好/长期坏"模式。\n但要注意：二阶和三阶效应往往不在当下显现——定期回顾，别等后果来了才回头。`);
    }

    const score = 5 - details.warnings.length * 1.5;
    return { text: lines.join('\n'), score: Math.max(0, Math.min(10, score)), details };
  },

  // 5. 价值观澄清：基于行为数据推断真实价值观
  valuesClarification(hist) {
    const lines = [];
    const details = {};
    if (!hist) hist = this.buildHistory();

    const principles = readData('principles');
    const beliefs = readData('beliefs');
    const northStar = readData('north_star');
    const statedValues = [];

    // 收集宣称的价值观
    if (principles.length > 0) {
      principles.forEach(p => { if (p.text) statedValues.push({ source: '原则', text: p.text.trim() }); });
    }
    if (beliefs.length > 0) {
      beliefs.forEach(b => { if (b.belief) statedValues.push({ source: '信念', text: b.belief.trim() }); });
    }
    if (northStar.length > 0 && northStar[0].ultimate) {
      statedValues.push({ source: '终局', text: northStar[0].ultimate.trim() });
    }

    details.statedValues = statedValues;

    // 推断真实价值观（基于行为数据）
    const moduleWeights = {};
    hist.forEach(h => {
      moduleWeights[h.mid] = (moduleWeights[h.mid] || 0) + 1;
    });
    const sortedByBehavior = Object.entries(moduleWeights).sort((a, b) => b[1] - a[1]);

    const valueLabels = {
      finance: '财务安全', sleep: '健康身体', exercise: '身体活力',
      emotion: '情绪平衡', diet: '身体滋养', diary: '自我反思',
      think: '深度思考', work: '事业发展', body: '身体关注',
      relation: '人际关系', growth: '个人成长', spirit: '精神世界',
      learn: '持续学习', photo: '审美表达', home: '家庭生活',
      travel: '探索体验', time: '时间管理'
    };

    const realValues = sortedByBehavior.slice(0, 5).map(([mid, count]) => ({
      module: mid,
      value: valueLabels[mid] || mid,
      recordCount: count
    }));

    details.realValues = realValues;

    // 对比宣称vs实际
    const statedKeywords = statedValues.map(v => v.text);
    const behaviorKeywords = realValues.map(v => v.value);
    const alignment = [];

    if (statedValues.length > 0 && realValues.length > 0) {
      const topBehaviorValue = realValues[0].value;
      const statedContainsTopBehavior = statedKeywords.some(k => k.includes(topBehaviorValue.slice(0, 2)));
      if (!statedContainsTopBehavior) {
        alignment.push({
          type: 'misalignment',
          stated: statedValues.map(v => v.text.slice(0, 20)).join('、'),
          actual: topBehaviorValue,
          note: `你宣称重视的和你实际投入时间的不一致——这不是"你虚伪"，是"你没意识到自己真正在为什么活"。`
        });
      }
    }

    // 检查时间精力分配
    const totalRecords = hist.length;
    const timeInvestment = {};
    const highPriorityMods = sortedByBehavior.slice(0, 3);
    const lowPriorityMods = sortedByBehavior.slice(-3);
    highPriorityMods.forEach(([m, c]) => { timeInvestment[m] = { count: c, pct: ((c / Math.max(totalRecords, 1)) * 100).toFixed(1) }; });

    details.alignment = alignment;
    details.timeInvestment = timeInvestment;

    lines.push(`宣称的价值观（${statedValues.length}条）：`);
    if (statedValues.length > 0) {
      lines.push(`  ${statedValues.slice(0, 3).map(v => `[${v.source}] ${v.text.slice(0, 30)}`).join('\n  ')}`);
    } else {
      lines.push('  你还没有写下任何原则或信念——没有宣称的价值观，就无法谈对齐度。');
    }

    lines.push(`\n实际体现的价值观（基于${totalRecords}条行为数据）：`);
    lines.push(`  ${realValues.map(v => `${v.value}（${v.recordCount}次记录）`).join('\n  ')}`);

    if (alignment.length > 0) {
      lines.push(`\n⚠️ 对齐问题：`);
      alignment.forEach(a => { lines.push(`  ${a.note}`); });
    } else if (statedValues.length > 0) {
      lines.push(`\n✅ 宣称与行为基本对齐。`);
    }

    // 人生对齐度评估
    let alignmentScore = 5;
    if (alignment.length > 0) alignmentScore -= 2;
    if (statedValues.length === 0) alignmentScore -= 1;
    if (realValues.length >= 3) alignmentScore += 1;

    lines.push(`\n人生对齐度：${Math.max(0, Math.min(10, alignmentScore))}/10`);
    if (alignmentScore < 4) {
      lines.push('  你活在别人的期待里，或活在"应该"里——不是你真正想活的样子。\n  改变从"觉察"开始：先看见真实的自己，再决定要成为谁。');
    } else if (alignmentScore < 7) {
      lines.push('  你在"基本对齐"和"深度对齐"之间。\n  问自己：你最在意的3件事，今天为它们花了多少时间？');
    } else {
      lines.push('  你活得比较对齐——你的行为在服务你的价值观。\n  但要持续校准：漂移是常态，每周检查一次。');
    }

    return { text: lines.join('\n'), score: Math.max(0, Math.min(10, alignmentScore)), details };
  },

  // 6. 反人性对抗：检测认知惰性、现状偏好、短视偏好、回避性偏好
  antiHumanNature(hist) {
    const lines = [];
    const details = {};
    if (!hist) hist = this.buildHistory();

    // 认知惰性：是否回避深度思考
    const thinkRecords = hist.filter(x => x.mid === 'think');
    const diaryRecords = hist.filter(x => x.mid === 'diary');
    const shallowThinking = [];
    if (thinkRecords.length >= 3) {
      thinkRecords.forEach(t => {
        const c = (t.data?.content || '').toString();
        if (c.length < 15) shallowThinking.push({ content: c, length: c.length });
      });
    }
    if (diaryRecords.length >= 3) {
      diaryRecords.forEach(d => {
        const c = (d.data?.content || '').toString();
        if (c.length < 15) shallowThinking.push({ content: c, length: c.length });
      });
    }
    const cognitiveInertia = shallowThinking.length >= 3 ? 1 : 0;
    details.cognitiveInertia = { detected: cognitiveInertia > 0, shallowCount: shallowThinking.length, samples: shallowThinking.slice(0, 3) };
    if (cognitiveInertia) lines.push(`🧠 认知惰性：${shallowThinking.length}条记录字数<15。\n你可能在回避深度思考——用"简短"代替"深刻"，用"记录"代替"思考"。`);

    // 现状偏好：是否即使现状不佳也不愿改变
    const emo = hist.filter(x => x.mid === 'emotion').slice(0, 14);
    if (emo.length >= 5) {
      const lowMoods = emo.filter(e => parseFloat(e.data?.rating || 3) <= 2);
      const lowDays = new Set(lowMoods.map(e => (e.ts || '').split('T')[0]));
      const entropyLogs = readData('entropy_logs').filter(e => !e.resolved);
      const statusQuoBias = lowMoods.length >= 3 && entropyLogs.length >= 2 ? 1 : 0;
      details.statusQuoBias = { detected: statusQuoBias > 0, lowMoodDays: lowDays.size, unresolvedIssues: entropyLogs.length };
      if (statusQuoBias) lines.push(`🔒 现状偏好：你已有${lowDays.size}天情绪低落，${entropyLogs.length}个未解决问题。\n你可能在"即使现状不佳也不愿改变"——改变的痛苦在当下，不改变的痛苦在未来，但未来的痛你感受不到。`);
    }

    // 短视偏好：是否更重视即时满足而非长期收益
    const fin = hist.filter(x => x.mid === 'finance').slice(0, 30);
    if (fin.length >= 5) {
      const expenses = fin.filter(x => x.data?.type === 'expense' || x.data?.type === '支出');
      const smallExp = expenses.filter(e => parseFloat(e.data?.amount || 0) < 50);
      const totalSpend = expenses.reduce((s, x) => s + parseFloat(x.data?.amount || 0), 0);
      const smallRatio = expenses.length > 0 ? smallExp.length / expenses.length : 0;
      const shortTermBias = smallRatio > 0.6 && totalSpend > 0 ? 1 : 0;
      details.shortTermBias = { detected: shortTermBias > 0, smallExpenseRatio: (smallRatio * 100).toFixed(0), smallCount: smallExp.length, totalExpenses: expenses.length };
      if (shortTermBias) lines.push(`⏰ 短视偏好：${(smallRatio*100).toFixed(0)}%的支出是<50元的小额消费。\n你可能在用"小确幸"逃避"大问题"——小额消费的即时满足，让你忘记长期目标需要持续投入。`);
    }

    // 回避性偏好：是否回避面对困难但重要的事
    const allMods = ['finance','sleep','exercise','emotion','diet','diary','think','work','body','relation','growth','spirit'];
    const moduleCounts = {};
    hist.forEach(h => { moduleCounts[h.mid] = (moduleCounts[h.mid] || 0) + 1; });
    const missingMods = allMods.filter(m => !moduleCounts[m]);
    const exerciseGap = !moduleCounts['exercise'] || hist.filter(x => x.mid === 'exercise').length < 2;
    const relationGap = !moduleCounts['relation'];
    const avoidancePreference = (missingMods.length >= 4 || exerciseGap || relationGap) ? 1 : 0;
    details.avoidancePreference = { detected: avoidancePreference > 0, missingModules: missingMods, exerciseGap, relationGap };
    if (avoidancePreference) lines.push(`🙈 回避性偏好：你忽略了${missingMods.slice(0, 4).join('、')}等维度。\n你可能在回避"困难但重要"的事——困难的事往往是成长最快的地方，回避它们等于回避成长。`);

    // 汇总
    const detectedCount = [cognitiveInertia, details.statusQuoBias?.detected ? 1 : 0, details.shortTermBias?.detected ? 1 : 0, avoidancePreference].filter(x => x > 0).length;

    lines.unshift(`反人性检测：${detectedCount}/4 项被检出。\n`);
    if (detectedCount === 0) {
      lines.push('目前未检测到明显的"反人性"倾向。\n但"没检测到"不代表"不存在"——这些偏好是人类出厂设置，每个人都有，只是程度不同。');
    }

    // 对抗建议
    const suggestions = [];
    if (cognitiveInertia) suggestions.push('每天写一段50字以上的深度反思——强迫自己思考，而不是敷衍。');
    if (details.statusQuoBias?.detected) suggestions.push('找一件你明知该改但一直在回避的小事，本周行动——从最小的事开始打破惯性。');
    if (details.shortTermBias?.detected) suggestions.push('记录每笔消费的"3天后果"——3天后还觉得值得吗？');
    if (avoidancePreference) suggestions.push('选一个你回避的维度，用"最小行动"开始——回避的本质是恐惧，恐惧的解药是行动。');

    if (suggestions.length > 0) {
      lines.push('\n对抗建议：');
      suggestions.forEach((s, i) => { lines.push(`  ${i + 1}. ${s}`); });
    }

    const score = 10 - detectedCount * 2;
    return { text: lines.join('\n'), score: Math.max(0, score), details };
  }
};

// ============================================================
// 原则库 API
// ============================================================
app.get('/api/principles', (req, res) => {
  res.json(readData('principles'));
});
app.post('/api/principles', (req, res) => {
  const { text, source } = req.body;
  if (!text || !text.trim()) return res.json({ success: false, message: '原则不能为空' });
  const list = readData('principles');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    text: text.trim(),
    source: source || 'manual',
    createdAt: new Date().toISOString()
  };
  list.push(item);
  writeData('principles', list);
  res.json({ success: true, item });
});
app.delete('/api/principles/:id', (req, res) => {
  const list = readData('principles');
  const targetId = String(req.params.id);
  writeData('principles', list.filter(p => String(p.id) !== targetId));
  res.json({ success: true });
});

// ============================================================
// 决策推演台 API
// ============================================================
app.get('/api/decisions', (req, res) => {
  res.json(readData('decisions'));
});
app.post('/api/decisions', (req, res) => {
  const { title, reasoning, expected, deadline } = req.body;
  if (!title || !title.trim()) return res.json({ success: false, message: '决策标题不能为空' });
  const list = readData('decisions');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    title: title.trim(),
    reasoning: reasoning || '',
    expected: expected || '',
    deadline: deadline || null,
    reviewed: false,
    outcome: null,
    correct: null,
    reviewedAt: null,
    createdAt: new Date().toISOString()
  };
  list.push(item);
  writeData('decisions', list);
  res.json({ success: true, item });
});
app.post('/api/decisions/:id/review', (req, res) => {
  const { outcome, correct } = req.body;
  const list = readData('decisions');
  const targetId = String(req.params.id);
  const item = list.find(d => String(d.id) === targetId);
  if (!item) return res.json({ success: false, message: '决策不存在' });
  item.reviewed = true;
  item.outcome = outcome || '';
  item.correct = correct;
  item.reviewedAt = new Date().toISOString();
  writeData('decisions', list);
  res.json({ success: true, item });
});

// ============================================================
// Phase 2：深度闭环
// 1) 根因分析 5why
// 2) 人际博弈日志
// 3) 定力训练 + 心境基线
// 4) 能量审计
// 5) 周/月自动复盘
// ============================================================

// ---------- 1. 根因分析 5why ----------
app.get('/api/root-cause', (req, res) => {
  res.json(readData('root_cause').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/root-cause', (req, res) => {
  const { trigger, whys, surface, root } = req.body;
  if (!trigger || !whys || !Array.isArray(whys) || whys.length === 0) {
    return res.json({ success: false, message: '请填写触发事件和至少一层追问' });
  }
  const list = readData('root_cause');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    trigger: trigger.trim(),
    whys: whys.slice(0, 7).map(w => (w || '').trim()).filter(Boolean),
    surface: (surface || '').trim(),
    root: (root || '').trim(),
    resolved: false,
    resolvedAction: '',
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  list.push(item);
  writeData('root_cause', list);
  const reflection = ENG.rootCause(item);
  res.json({ success: true, item, reflection });
});

app.post('/api/root-cause/:id/resolve', (req, res) => {
  const list = readData('root_cause');
  const targetId = String(req.params.id);
  const item = list.find(r => String(r.id) === targetId);
  if (!item) return res.json({ success: false, message: '根因记录不存在' });
  item.resolved = true;
  item.resolvedAction = (req.body.action || '').trim();
  item.resolvedAt = new Date().toISOString();
  writeData('root_cause', list);
  res.json({ success: true, item });
});

app.delete('/api/root-cause/:id', (req, res) => {
  const list = readData('root_cause');
  writeData('root_cause', list.filter(r => String(r.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 2. 人际博弈日志 ----------
app.get('/api/interpersonal', (req, res) => {
  res.json(readData('interpersonal').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/interpersonal', (req, res) => {
  const { person, role, event, myGoal, theirGoal, myMove, theirMove, myCost, myGain, lesson } = req.body;
  if (!person || !event) return res.json({ success: false, message: '请填写对象和事件' });
  const list = readData('interpersonal');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    person: person.trim(),
    role: (role || '').trim(),
    event: event.trim(),
    myGoal: (myGoal || '').trim(),
    theirGoal: (theirGoal || '').trim(),
    myMove: (myMove || '').trim(),
    theirMove: (theirMove || '').trim(),
    myCost: parseFloat(myCost) || 0,
    myGain: parseFloat(myGain) || 0,
    lesson: (lesson || '').trim(),
    net: (parseFloat(myGain) || 0) - (parseFloat(myCost) || 0),
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  list.push(item);
  writeData('interpersonal', list);
  const reflection = ENG.interpersonal(item);
  res.json({ success: true, item, reflection });
});

app.delete('/api/interpersonal/:id', (req, res) => {
  const list = readData('interpersonal');
  writeData('interpersonal', list.filter(i => String(i.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 3. 定力训练 + 心境基线 ----------
app.get('/api/mindfulness', (req, res) => {
  res.json(readData('mindfulness').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/mindfulness', (req, res) => {
  const { type, trigger, beforeLevel, afterLevel, durationSec, method, note } = req.body;
  if (!type) return res.json({ success: false, message: '请选择训练类型' });
  const list = readData('mindfulness');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    type,
    trigger: (trigger || '').trim(),
    beforeLevel: Math.min(5, Math.max(1, parseInt(beforeLevel) || 3)),
    afterLevel: Math.min(5, Math.max(1, parseInt(afterLevel) || 3)),
    delta: (parseInt(afterLevel) || 3) - (parseInt(beforeLevel) || 3),
    durationSec: parseInt(durationSec) || 0,
    method: (method || '').trim(),
    note: (note || '').trim(),
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  list.push(item);
  writeData('mindfulness', list);
  const reflection = ENG.mindfulness(item, list);
  res.json({ success: true, item, reflection });
});

app.delete('/api/mindfulness/:id', (req, res) => {
  const list = readData('mindfulness');
  writeData('mindfulness', list.filter(m => String(m.id) !== String(req.params.id)));
  res.json({ success: true });
});

app.get('/api/mindfulness/baseline', (req, res) => {
  res.json(ENG.mindfulnessBaseline());
});

// ---------- 4. 能量审计 ----------
app.get('/api/energy', (req, res) => {
  res.json(readData('energy').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/energy', (req, res) => {
  const { type, source, amount, durationMin, note } = req.body;
  if (!type || !source) return res.json({ success: false, message: '请填写类型和来源' });
  if (!['drain','gain'].includes(type)) return res.json({ success: false, message: '类型必须是 drain 或 gain' });
  const list = readData('energy');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    type,
    source: source.trim(),
    amount: Math.min(10, Math.max(1, parseInt(amount) || 5)),
    durationMin: parseInt(durationMin) || 0,
    note: (note || '').trim(),
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  list.push(item);
  writeData('energy', list);
  const reflection = ENG.energy(item, list);
  res.json({ success: true, item, reflection });
});

app.delete('/api/energy/:id', (req, res) => {
  const list = readData('energy');
  writeData('energy', list.filter(e => String(e.id) !== String(req.params.id)));
  res.json({ success: true });
});

app.get('/api/energy/audit', (req, res) => {
  res.json(ENG.energyAudit());
});

// ---------- 5. 周/月自动复盘 ----------
app.get('/api/review/auto', (req, res) => {
  const period = (req.query.period === 'month') ? 'month' : 'week';
  res.json(ENG.autoReview(period));
});

app.get('/api/reviews', (req, res) => {
  res.json(readData('reviews').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/reviews', (req, res) => {
  const { period, content, highlights, regrets, nextActions } = req.body;
  if (!content || !content.trim()) return res.json({ success: false, message: '复盘内容不能为空' });
  const list = readData('reviews');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    period: period || 'week',
    content: content.trim(),
    highlights: highlights || '',
    regrets: regrets || '',
    nextActions: nextActions || '',
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  list.push(item);
  writeData('reviews', list);
  res.json({ success: true, item });
});

app.delete('/api/reviews/:id', (req, res) => {
  const list = readData('reviews');
  writeData('reviews', list.filter(r => String(r.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ============================================================
// Phase 3：成长轴
// 1) 信念追踪
// 2) 品格雷达
// 3) 自我画像演化
// 4) 反熵增监控
// 5) 反脆弱缓冲评估
// ============================================================

// ---------- 1. 信念追踪 ----------
app.get('/api/beliefs', (req, res) => {
  res.json(readData('beliefs').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/beliefs', (req, res) => {
  const { belief, source, confidence, category } = req.body;
  if (!belief || !belief.trim()) return res.json({ success: false, message: '请写下你的信念' });
  const list = readData('beliefs');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    belief: belief.trim(),
    source: (source || '').trim(),
    confidence: Math.min(5, Math.max(1, parseInt(confidence) || 3)),
    category: category || '人生',
    tested: 0,
    heldUp: 0,
    broken: 0,
    lastTestedAt: null,
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  list.push(item);
  writeData('beliefs', list);
  const reflection = ENG.belief(item);
  res.json({ success: true, item, reflection });
});

app.post('/api/beliefs/:id/test', (req, res) => {
  const { result, note } = req.body;
  if (!['held','broken','uncertain'].includes(result)) {
    return res.json({ success: false, message: 'result 必须是 held/broken/uncertain' });
  }
  const list = readData('beliefs');
  const targetId = String(req.params.id);
  const item = list.find(b => String(b.id) === targetId);
  if (!item) return res.json({ success: false, message: '信念不存在' });
  item.tested = (item.tested || 0) + 1;
  if (result === 'held') item.heldUp = (item.heldUp || 0) + 1;
  if (result === 'broken') item.broken = (item.broken || 0) + 1;
  item.lastTestedAt = new Date().toISOString();
  item.lastTestResult = result;
  item.lastTestNote = (note || '').trim();
  writeData('beliefs', list);
  res.json({ success: true, item, reflection: ENG.beliefTest(item) });
});

app.delete('/api/beliefs/:id', (req, res) => {
  const list = readData('beliefs');
  writeData('beliefs', list.filter(b => String(b.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 2. 品格雷达 ----------
app.get('/api/character', (req, res) => {
  res.json(readData('character').sort((a,b) => (a.date < b.date ? 1 : -1)));
});

app.post('/api/character', (req, res) => {
  const { honesty, courage, resilience, restraint, responsibility, altruism, note } = req.body;
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    honesty: Math.min(10, Math.max(0, parseInt(honesty) || 5)),
    courage: Math.min(10, Math.max(0, parseInt(courage) || 5)),
    resilience: Math.min(10, Math.max(0, parseInt(resilience) || 5)),
    restraint: Math.min(10, Math.max(0, parseInt(restraint) || 5)),
    responsibility: Math.min(10, Math.max(0, parseInt(responsibility) || 5)),
    altruism: Math.min(10, Math.max(0, parseInt(altruism) || 5)),
    note: (note || '').trim(),
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  const list = readData('character');
  list.push(item);
  writeData('character', list);
  res.json({ success: true, item, reflection: ENG.character(item, list) });
});

app.get('/api/character/radar', (req, res) => {
  res.json(ENG.characterRadar());
});

app.delete('/api/character/:id', (req, res) => {
  const list = readData('character');
  writeData('character', list.filter(c => String(c.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 3. 自我画像演化 ----------
app.get('/api/self-portrait', (req, res) => {
  res.json(readData('self_portrait').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/self-portrait/generate', (req, res) => {
  const portrait = ENG.selfPortrait();
  const list = readData('self_portrait');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    ...portrait,
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  // 保留最近12份（每月一份，一年）
  const trimmed = [item, ...list].slice(0, 12);
  writeData('self_portrait', trimmed);
  res.json({ success: true, item });
});

app.delete('/api/self-portrait/:id', (req, res) => {
  const list = readData('self_portrait');
  writeData('self_portrait', list.filter(p => String(p.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 4. 反熵增监控 ----------
app.get('/api/entropy', (req, res) => {
  res.json(ENG.entropyMonitor());
});

app.post('/api/entropy/log', (req, res) => {
  const { dimension, signal, severity, note } = req.body;
  if (!dimension || !signal) return res.json({ success: false, message: '请填写维度和信号' });
  const list = readData('entropy_logs');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    dimension,
    signal: signal.trim(),
    severity: ['low','med','high'].includes(severity) ? severity : 'med',
    note: (note || '').trim(),
    resolved: false,
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  list.push(item);
  writeData('entropy_logs', list);
  res.json({ success: true, item });
});

app.post('/api/entropy/log/:id/resolve', (req, res) => {
  const list = readData('entropy_logs');
  const targetId = String(req.params.id);
  const item = list.find(e => String(e.id) === targetId);
  if (!item) return res.json({ success: false, message: '记录不存在' });
  item.resolved = true;
  item.resolvedAt = new Date().toISOString();
  writeData('entropy_logs', list);
  res.json({ success: true, item });
});

app.get('/api/entropy/logs', (req, res) => {
  res.json(readData('entropy_logs').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.delete('/api/entropy/log/:id', (req, res) => {
  const list = readData('entropy_logs');
  writeData('entropy_logs', list.filter(e => String(e.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 5. 反脆弱缓冲评估 ----------
app.get('/api/antifragile', (req, res) => {
  res.json(ENG.antifragile());
});

app.post('/api/antifragile', (req, res) => {
  const { financial, skill, social, health, mental, note } = req.body;
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    financial: Math.min(10, Math.max(0, parseInt(financial) || 0)),
    skill: Math.min(10, Math.max(0, parseInt(skill) || 0)),
    social: Math.min(10, Math.max(0, parseInt(social) || 0)),
    health: Math.min(10, Math.max(0, parseInt(health) || 0)),
    mental: Math.min(10, Math.max(0, parseInt(mental) || 0)),
    note: (note || '').trim(),
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  const list = readData('antifragile_logs');
  list.push(item);
  writeData('antifragile_logs', list);
  res.json({ success: true, item, reflection: ENG.antifragile(item) });
});

app.get('/api/antifragile/logs', (req, res) => {
  res.json(readData('antifragile_logs').sort((a,b) => (a.date < b.date ? 1 : -1)));
});

app.delete('/api/antifragile/:id', (req, res) => {
  const list = readData('antifragile_logs');
  writeData('antifragile_logs', list.filter(a => String(a.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ============================================================
// Phase 4：船长工具
// 1) 坐标系 + 北极星
// 2) 危机预案
// 3) 临终测试
// 4) 年度叙事
// 5) 船长宣言
// ============================================================

// ---------- 1. 坐标系 + 北极星 ----------
app.get('/api/north-star', (req, res) => {
  res.json(readData('north_star'));
});

app.post('/api/north-star', (req, res) => {
  const { ultimate, fiveYear, oneYear, thisQuarter, thisWeek, today, manifesto } = req.body;
  const data = readData('north_star');
  const item = {
    id: data.length ? data[0].id : Date.now().toString(36),
    ultimate: (ultimate || '').trim(),
    fiveYear: (fiveYear || '').trim(),
    oneYear: (oneYear || '').trim(),
    thisQuarter: (thisQuarter || '').trim(),
    thisWeek: (thisWeek || '').trim(),
    today: (today || '').trim(),
    manifesto: (manifesto || '').trim(),
    updatedAt: new Date().toISOString()
  };
  writeData('north_star', [item]);
  res.json({ success: true, item, reflection: ENG.northStar(item) });
});

app.delete('/api/north-star', (req, res) => {
  writeData('north_star', []);
  res.json({ success: true });
});

// ---------- 2. 危机预案 ----------
app.get('/api/crisis-plan', (req, res) => {
  res.json(readData('crisis_plan').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/crisis-plan', (req, res) => {
  const { scenario, probability, impact, precondition, immediateAction, threeDayPlan, recoveryPlan, note } = req.body;
  if (!scenario || !scenario.trim()) return res.json({ success: false, message: '请填写危机场景' });
  const list = readData('crisis_plan');
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    scenario: scenario.trim(),
    probability: ['low','med','high'].includes(probability) ? probability : 'med',
    impact: ['low','med','high','critical'].includes(impact) ? impact : 'high',
    precondition: (precondition || '').trim(),
    immediateAction: (immediateAction || '').trim(),
    threeDayPlan: (threeDayPlan || '').trim(),
    recoveryPlan: (recoveryPlan || '').trim(),
    note: (note || '').trim(),
    rehearsed: false,
    rehearsedAt: null,
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  list.push(item);
  writeData('crisis_plan', list);
  res.json({ success: true, item, reflection: ENG.crisisPlan(item) });
});

app.post('/api/crisis-plan/:id/rehearse', (req, res) => {
  const { note } = req.body;
  const list = readData('crisis_plan');
  const targetId = String(req.params.id);
  const item = list.find(c => String(c.id) === targetId);
  if (!item) return res.json({ success: false, message: '预案不存在' });
  item.rehearsed = true;
  item.rehearsedAt = new Date().toISOString();
  item.rehearseNote = (note || '').trim();
  writeData('crisis_plan', list);
  res.json({ success: true, item });
});

app.delete('/api/crisis-plan/:id', (req, res) => {
  const list = readData('crisis_plan');
  writeData('crisis_plan', list.filter(c => String(c.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 3. 临终测试 ----------
app.get('/api/death-test', (req, res) => {
  res.json(readData('death_test').sort((a,b) => (a.date < b.date ? 1 : -1)));
});

app.post('/api/death-test', (req, res) => {
  const { regrets, undone, proudOf, wouldChange, focus } = req.body;
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    regrets: (regrets || '').trim(),
    undone: (undone || '').trim(),
    proudOf: (proudOf || '').trim(),
    wouldChange: (wouldChange || '').trim(),
    focus: (focus || '').trim(),
    createdAt: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0]
  };
  const list = readData('death_test');
  list.push(item);
  writeData('death_test', list);
  res.json({ success: true, item, reflection: ENG.deathTest(item) });
});

app.delete('/api/death-test/:id', (req, res) => {
  const list = readData('death_test');
  writeData('death_test', list.filter(d => String(d.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 4. 年度叙事 ----------
app.get('/api/narrative', (req, res) => {
  res.json(readData('narrative').sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1)));
});

app.post('/api/narrative/generate', (req, res) => {
  const year = parseInt(req.body.year) || new Date().getFullYear();
  const narrative = ENG.narrative(year);
  const list = readData('narrative');
  // 同年覆盖
  const filtered = list.filter(n => n.year !== year);
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    year,
    ...narrative,
    createdAt: new Date().toISOString()
  };
  writeData('narrative', [item, ...filtered]);
  res.json({ success: true, item });
});

app.delete('/api/narrative/:id', (req, res) => {
  const list = readData('narrative');
  writeData('narrative', list.filter(n => String(n.id) !== String(req.params.id)));
  res.json({ success: true });
});

// ---------- 5. 船长宣言 ----------
app.get('/api/manifesto', (req, res) => {
  res.json(readData('manifesto'));
});

app.post('/api/manifesto', (req, res) => {
  const { title, body, signedAt } = req.body;
  const data = readData('manifesto');
  const item = {
    id: data.length ? data[0].id : Date.now().toString(36),
    title: (title || '我的船长宣言').trim(),
    body: (body || '').trim(),
    signedAt: signedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeData('manifesto', [item]);
  res.json({ success: true, item, reflection: ENG.manifesto(item) });
});

app.delete('/api/manifesto', (req, res) => {
  writeData('manifesto', []);
  res.json({ success: true });
});

// ============================================================
// Phase 5：深度认知引擎 API
// ============================================================

// ---------- 1. 元认知反思 ----------
app.get('/api/eng/metacognition', (req, res) => {
  const hist = ENG.buildHistory();
  const result = ENG.metacognition(hist);
  res.json({ ...result, generatedAt: new Date().toISOString(), sampleSize: hist.length });
});

// ---------- 2. 认知偏差检测 ----------
app.get('/api/eng/cognitive-bias', (req, res) => {
  const hist = ENG.buildHistory();
  const result = ENG.cognitiveBias(hist);
  res.json({ ...result, generatedAt: new Date().toISOString(), sampleSize: hist.length });
});

// ---------- 3. 轨迹分析 ----------
app.get('/api/eng/trajectory', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const hist = ENG.buildHistory();
  const result = ENG.trajectory(hist, days);
  res.json({ ...result, days, generatedAt: new Date().toISOString(), sampleSize: hist.length });
});

// ---------- 4. 二阶效应分析 ----------
app.post('/api/eng/second-order', (req, res) => {
  const { mid, action } = req.body;
  if (!mid || !action) return res.json({ success: false, message: '缺少mid或action参数' });
  const hist = ENG.buildHistory();
  const result = ENG.secondOrderEffect({ mid, action }, hist);
  res.json({ success: true, ...result, generatedAt: new Date().toISOString() });
});

// ---------- 5. 价值观澄清 ----------
app.get('/api/eng/values-clarification', (req, res) => {
  const hist = ENG.buildHistory();
  const result = ENG.valuesClarification(hist);
  res.json({ ...result, generatedAt: new Date().toISOString(), sampleSize: hist.length });
});

// ---------- 6. 反人性对抗 ----------
app.get('/api/eng/anti-human-nature', (req, res) => {
  const hist = ENG.buildHistory();
  const result = ENG.antiHumanNature(hist);
  res.json({ ...result, generatedAt: new Date().toISOString(), sampleSize: hist.length });
});

// ---------- 7. 认知仪表盘（一次聚合所有深度分析，减少前端请求） ----------
app.get('/api/eng/dashboard', (req, res) => {
  const result = { generatedAt: new Date().toISOString(), sections: {} };
  try {
    const hist = ENG.buildHistory();
    result.sampleSize = hist.length;
    // 风险
    try { result.sections.risks = ENG.risks(hist) || []; } catch (e) { result.sections.risks = []; }
    // 反熵增
    try { result.sections.entropy = ENG.entropyMonitor(); } catch (e) { result.sections.entropy = null; }
    // 反脆弱
    try { result.sections.antifragile = ENG.antifragile(); } catch (e) { result.sections.antifragile = null; }
    // 轨迹 30 天
    try { result.sections.trajectory = ENG.trajectory(hist, 30); } catch (e) { result.sections.trajectory = null; }
    // 元认知
    try { result.sections.metacognition = ENG.metacognition(hist); } catch (e) { result.sections.metacognition = null; }
    // 认知偏差
    try { result.sections.cognitiveBias = ENG.cognitiveBias(hist); } catch (e) { result.sections.cognitiveBias = null; }
    // 自我画像
    try { result.sections.selfPortrait = ENG.selfPortrait(); } catch (e) { result.sections.selfPortrait = null; }
    // 品格雷达
    try { result.sections.characterRadar = ENG.characterRadar(); } catch (e) { result.sections.characterRadar = null; }
    // 能量审计
    try { result.sections.energyAudit = ENG.energyAudit(); } catch (e) { result.sections.energyAudit = null; }
    // 自动复盘（本周）
    try { result.sections.autoReview = ENG.autoReview('week'); } catch (e) { result.sections.autoReview = null; }
    // 反人性
    try { result.sections.antiHumanNature = ENG.antiHumanNature(hist); } catch (e) { result.sections.antiHumanNature = null; }
    // 价值观澄清
    try { result.sections.valuesClarification = ENG.valuesClarification(hist); } catch (e) { result.sections.valuesClarification = null; }
  } catch (e) {
    console.error('[eng/dashboard]', e.message);
    result.error = e.message;
  }
  res.json(result);
});

// ============================================================
// 保存记录（带认知反馈）API
// ============================================================
app.post('/api/record/add', (req, res) => {
  const { mid, data, editId } = req.body;
  if (!mid) return res.json({ success: false, message: '缺少模块ID' });
  if (!data || typeof data !== 'object') return res.json({ success: false, message: '缺少数据' });
  const list = readData(mid);
  let item;
  if (editId) {
    const targetId = String(editId);
    item = list.find(x => String(x.id) === targetId);
    if (item) Object.assign(item, data);
    else { item = Object.assign({ id: targetId, created: new Date().toISOString() }, data); list.push(item); }
  } else {
    item = Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), created: new Date().toISOString() }, data);
    list.push(item);
  }
  writeData(mid, list);

  // === 跨模块联动引擎 ===
  const linkedModules = []; // 记录哪些模块被联动刷新了，返回给前端
  const linkDate = data.date || new Date().toISOString().split('T')[0];
  const linkId = item.id;

  // 统一去重函数：检查目标模块是否已有来自同一源记录的联动数据
  function hasLinked(targetMid, sourceMid, sourceId) {
    try {
      const list = readData(targetMid);
      return list.some(function(x) { return x._linkedModule === sourceMid && x._linkedId === sourceId; });
    } catch (e) { return false; }
  }

  // 1. 宠物花费 → 自动创建财务支出记录
  if (mid === 'pet' && !editId && data.cost && parseFloat(data.cost) > 0) {
    if (!hasLinked('finance', 'pet', linkId)) {
      try {
        const finList = readData('finance');
        finList.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
          type: '支出', amount: parseFloat(data.cost), category: '宠物',
          content: (data.petName || '宠物') + ' - ' + (data.action || '花费'),
          paymentMethod: '', date: linkDate,
          _linkedModule: 'pet', _linkedId: linkId, created: new Date().toISOString()
        });
        writeData('finance', finList);
        linkedModules.push('finance');
      } catch (e) { console.error('[linkage] pet→finance:', e.message); }
    }
  }
  // 2. 医疗/健康花费 → 自动创建财务支出记录
  if (!editId && data.cost && parseFloat(data.cost) > 0 && (mid === 'medical' || mid === 'health')) {
    if (!hasLinked('finance', mid, linkId)) {
      try {
        const finList = readData('finance');
        finList.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
          type: '支出', amount: parseFloat(data.cost), category: '医疗',
          content: (data.hospital || data.symptom || '就医') + ' - ' + (data.type || data.sceneType || ''),
          paymentMethod: data.paymentMethod || '', date: linkDate,
          _linkedModule: mid, _linkedId: linkId, created: new Date().toISOString()
        });
        writeData('finance', finList);
        linkedModules.push('finance');
      } catch (e) { console.error('[linkage] health→finance:', e.message); }
    }
  }
  // 3. 出行花费 → 自动创建财务支出记录
  if (mid === 'travel' && !editId && data.cost && parseFloat(data.cost) > 0) {
    if (!hasLinked('finance', 'travel', linkId)) {
      try {
        const finList = readData('finance');
        let cat = '交通';
        if (data.purpose === '旅行') cat = '娱乐';
        else if (data.purpose === '购物') cat = '购物';
        else if (data.purpose === '约会') cat = '娱乐';
        finList.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
          type: '支出', amount: parseFloat(data.cost), category: cat,
          content: (data.transport || '出行') + ' - ' + (data.purpose || '') + (data.from && data.to ? ' ' + data.from + '→' + data.to : ''),
          paymentMethod: '', date: linkDate,
          _linkedModule: 'travel', _linkedId: linkId, created: new Date().toISOString()
        });
        writeData('finance', finList);
        linkedModules.push('finance');
      } catch (e) { console.error('[linkage] travel→finance:', e.message); }
    }
  }
  // 4. 人情消费 → 自动创建财务支出记录
  if (mid === 'relation' && !editId && data.cost && parseFloat(data.cost) > 0) {
    if (!hasLinked('finance', 'relation', linkId)) {
      try {
        const finList = readData('finance');
        let cat = '其他';
        if (data.favorType === '随份子' || data.favorType === '送礼' || data.favorType === '请客') cat = '娱乐';
        finList.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
          type: '支出', amount: parseFloat(data.cost), category: cat,
          content: (data.person || data.role || '关系') + ' - ' + (data.favorType || data.interaction || '人情'),
          paymentMethod: '', date: linkDate,
          _linkedModule: 'relation', _linkedId: linkId, created: new Date().toISOString()
        });
        writeData('finance', finList);
        linkedModules.push('finance');
      } catch (e) { console.error('[linkage] relation→finance:', e.message); }
    }
  }
  // 5. 工作记录 → 自动创建时间分配记录
  if (mid === 'work' && !editId) {
    if (!hasLinked('time', 'work', linkId)) {
      try {
        const timeList = readData('time');
        let value = '一般';
        const fl = parseInt(String(data.focusLevel || '3').charAt(0), 10);
        const mn = parseInt(String(data.meaning || '3'), 10);
        const avg = (fl + mn) / 2;
        if (avg >= 4.2) value = '非常有';
        else if (avg >= 3.2) value = '比较有';
        else if (avg <= 1.8) value = '后悔';
        else if (avg <= 2.4) value = '浪费';
        timeList.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
          category: '工作', duration: 480, value: value,
          content: (data.role || '工作') + ' - ' + (data.task ? String(data.task).substring(0, 50) : ''),
          date: linkDate,
          _linkedModule: 'work', _linkedId: linkId, created: new Date().toISOString()
        });
        writeData('time', timeList);
        linkedModules.push('time');
      } catch (e) { console.error('[linkage] work→time:', e.message); }
    }
  }
  // 6. 居住记录：花费→财务；购买/丢弃→库存
  if (mid === 'home' && !editId) {
    // 6a 花费自动记账
    if (data.cost && parseFloat(data.cost) > 0) {
      if (!hasLinked('finance', 'home', linkId)) {
        try {
          const finList = readData('finance');
          let cat = '其他';
          if (data.action === '购买') cat = '购物';
          finList.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
            type: '支出', amount: parseFloat(data.cost), category: cat,
            content: (data.space || '居住') + ' - ' + (data.action || '') + (data.items ? ' ' + data.items : ''),
            paymentMethod: '', date: linkDate,
            _linkedModule: 'home', _linkedId: linkId, created: new Date().toISOString()
          });
          writeData('finance', finList);
          linkedModules.push('finance');
        } catch (e) { console.error('[linkage] home→finance:', e.message); }
      }
    }
    // 6b 购买 → 自动写入 inventory
    if ((data.action === '购买') && data.items) {
      if (!hasLinked('inventory', 'home', linkId)) {
        try {
          const invList = readData('inventory');
          const names = String(data.items).split(/[,，、/;\s]+/).filter(function(x) { return x.trim().length > 0; });
          for (const n of names) {
            invList.push({
              id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
              name: n, category: '其他', quantity: 1,
              price: data.cost && names.length === 1 ? parseFloat(data.cost) : undefined,
              purchaseDate: linkDate, location: data.space || '',
              usageFreq: '偶尔', condition: '良好', necessity: '3-偶尔用', declutter: '保留',
              _linkedModule: 'home', _linkedId: linkId, created: new Date().toISOString()
            });
          }
          writeData('inventory', invList);
          linkedModules.push('inventory');
        } catch (e) { console.error('[linkage] home→inventory:', e.message); }
      }
    }
    // 6c 丢弃 → 标记 inventory 断舍离
    if ((data.action === '丢弃') && data.items) {
      try {
        const invList = readData('inventory');
        const names = String(data.items).split(/[,，、/;\s]+/).filter(function(x) { return x.trim().length > 0; });
        let changed = false;
        for (const inv of invList) {
          if (inv._linkedModule === 'home' && inv._linkedId === linkId) continue; // 跳过自己联动的
          for (const n of names) {
            if (inv.name === n || (inv.name && inv.name.indexOf(n) !== -1)) {
              inv.declutter = '已捐赠/出售';
              inv._linkedModule = 'home'; inv._linkedId = linkId;
              changed = true; break;
            }
          }
        }
        if (changed) { writeData('inventory', invList); linkedModules.push('inventory'); }
      } catch (e) { console.error('[linkage] home→inventory(丢弃):', e.message); }
    }
  }

  // 生成认知反馈
  const hist = ENG.buildHistory();
  const reflection = ENG.reflect(mid, data, hist);
  const correlations = ENG.correlate(hist);
  const risks = ENG.risks(hist);
  const dailySummary = ENG.daily(hist);

  let budget = null;
  if (mid === 'finance' && data.type === '支出') {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const month = `${yyyy}-${mm}`;
    const budgetRow = db.prepare("SELECT value FROM kv WHERE key=?").get('budget:' + month);
    const budgetAmount = budgetRow ? parseFloat(budgetRow.value) || 0 : 0;
    const monthStart = `${month}-01`;
    const nextMonthDate = new Date(yyyy, today.getMonth() + 1, 1);
    const nextMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, '0')}-01`;
    const spentRows = db.prepare("SELECT data FROM records WHERE mid='finance' AND created>=? AND created<?").all(monthStart, nextMonth);
    let spent = 0;
    for (const r of spentRows) {
      try {
        const rd = JSON.parse(r.data);
        if (rd.type === '支出' || rd.type === 'expense') spent += parseFloat(rd.amount) || 0;
      } catch (e) {}
    }
    const remaining = budgetAmount - spent;
    budget = { budget: budgetAmount, spent, remaining, over: remaining < 0 };
  }

  res.json({
    success: true,
    item,
    reflection,
    correlations,
    risks,
    dailySummary,
    budget,
    linkedModules: linkedModules.length ? linkedModules : undefined
  });
});

// ============================================================
// 预算 API
// ============================================================
app.get('/api/budget', (req, res) => {
  const targetMonth = req.query.month || (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
  })();
  const [ty, tm] = targetMonth.split('-').map(Number);
  const calcMonthSpent = (yyyy, mm) => {
    const month = `${yyyy}-${String(mm).padStart(2, '0')}`;
    const start = `${month}-01`;
    const nextDate = new Date(yyyy, mm, 1);
    const end = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-01`;
    const rows = db.prepare("SELECT data FROM records WHERE mid='finance' AND created>=? AND created<?").all(start, end);
    let s = 0;
    for (const r of rows) {
      try { const rd = JSON.parse(r.data); if (rd.type === '支出' || rd.type === 'expense') s += parseFloat(rd.amount) || 0; } catch (e) {}
    }
    return s;
  };
  const spent = calcMonthSpent(ty, tm);
  const bRow = db.prepare("SELECT value FROM kv WHERE key=?").get('budget:' + targetMonth);
  const budget = bRow ? parseFloat(bRow.value) || 0 : 0;
  const remaining = budget - spent;
  const history = [];
  for (let i = 2; i >= 0; i--) {
    const d = new Date(ty, tm - 1 - i, 1);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    const mStr = `${y}-${String(m).padStart(2, '0')}`;
    const hRow = db.prepare("SELECT value FROM kv WHERE key=?").get('budget:' + mStr);
    history.push({
      month: mStr,
      budget: hRow ? parseFloat(hRow.value) || 0 : 0,
      spent: calcMonthSpent(y, m)
    });
  }
  res.json({ budget, spent, remaining, over: remaining < 0, history });
});
app.post('/api/budget', (req, res) => {
  const { month, amount } = req.body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.json({ success: false, message: '月份格式应为 YYYY-MM' });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 0) return res.json({ success: false, message: '金额无效' });
  db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run('budget:' + month, String(amt));
  res.json({ success: true, month, budget: amt });
});

// ============================================================
// 习惯 API
// ============================================================
const DEFAULT_HABITS = [
  { id: 'earlysleep', name: '早睡', icon: '🌙', target: '23:00前睡' },
  { id: 'exercise', name: '锻炼', icon: '🏃', target: '每日30分钟' },
  { id: 'meditate', name: '冥想', icon: '🧘', target: '每日10分钟' }
];
function getHabitCheckins(habitId) {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get('habit_checkin:' + habitId);
  if (!row) return [];
  try { const arr = JSON.parse(row.value); return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
}
function saveHabitCheckins(habitId, list) {
  db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run('habit_checkin:' + habitId, JSON.stringify(list));
}
function calcStreak(checkins, todayStr) {
  const dateSet = new Set(checkins.map(c => c.date));
  let streak = 0;
  const cur = new Date(todayStr);
  while (true) {
    const s = cur.toISOString().split('T')[0];
    if (dateSet.has(s)) { streak++; cur.setDate(cur.getDate() - 1); }
    else break;
  }
  return streak;
}
app.get('/api/habits', (req, res) => {
  const todayStr = new Date().toISOString().split('T')[0];
  const todayDate = new Date(todayStr);
  const last30Dates = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayDate); d.setDate(d.getDate() - i);
    last30Dates.push(d.toISOString().split('T')[0]);
  }
  const habits = DEFAULT_HABITS.map(h => {
    const checkins = getHabitCheckins(h.id);
    const dateSet = new Set(checkins.map(c => c.date));
    const last30days = last30Dates.map(d => ({ date: d, done: dateSet.has(d) }));
    const streak = calcStreak(checkins, todayStr);
    const todayDone = dateSet.has(todayStr);
    return { ...h, streak, todayDone, last30days };
  });
  res.json(habits);
});
app.post('/api/habit/checkin', (req, res) => {
  const { habitId, date } = req.body;
  if (!habitId) return res.json({ success: false, message: '缺少 habitId' });
  if (!DEFAULT_HABITS.find(h => h.id === habitId)) return res.json({ success: false, message: '习惯不存在' });
  const todayStr = new Date().toISOString().split('T')[0];
  const targetDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayStr;
  const checkins = getHabitCheckins(habitId);
  const idx = checkins.findIndex(c => c.date === targetDate);
  let action;
  if (idx >= 0) { checkins.splice(idx, 1); action = '取消打卡'; }
  else { checkins.push({ date: targetDate, time: new Date().toISOString() }); action = '打卡成功'; }
  saveHabitCheckins(habitId, checkins);
  const streak = calcStreak(checkins, todayStr);
  const todayDone = new Set(checkins.map(c => c.date)).has(todayStr);
  res.json({ success: true, action, habitId, date: targetDate, streak, todayDone });
});
app.delete('/api/habit/checkin/:hid/:date', (req, res) => {
  const { hid, date } = req.params;
  if (!DEFAULT_HABITS.find(h => h.id === hid)) return res.json({ success: false, message: '习惯不存在' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ success: false, message: '日期格式错误' });
  const checkins = getHabitCheckins(hid);
  const filtered = checkins.filter(c => c.date !== date);
  saveHabitCheckins(hid, filtered);
  const todayStr = new Date().toISOString().split('T')[0];
  const streak = calcStreak(filtered, todayStr);
  res.json({ success: true, removed: checkins.length - filtered.length, streak });
});

// ============================================================
// v6.4.2 行动闭环：todo 状态机 + 建议转任务
// ============================================================
// 待办状态机：切换 todo 状态（待办/进行中/已完成/已取消）
app.post('/api/todo/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    const validStatus = ['待办', '进行中', '已完成', '已取消'];
    if (!validStatus.includes(status)) {
      return res.json({ success: false, message: '无效状态，可选：' + validStatus.join('/') });
    }
    const list = readData('todo');
    const item = list.find(t => String(t.id) === String(req.params.id));
    if (!item) return res.json({ success: false, message: '待办不存在' });
    const oldStatus = item.status || '待办';
    item.status = status;
    if (status === '已完成' && !item.completedAt) item.completedAt = new Date().toISOString();
    if (status !== '已完成') { delete item.completedAt; }
    item.updatedAt = new Date().toISOString();
    writeData('todo', list);
    res.json({ success: true, item, oldStatus, newStatus: status });
  } catch (e) {
    console.error('[todo/status]', e.message);
    res.status(500).json({ success: false, message: '状态更新失败' });
  }
});

// 待办按状态分组
app.get('/api/todo/by-status', (req, res) => {
  try {
    const list = readData('todo');
    const groups = { '待办': [], '进行中': [], '已完成': [], '已取消': [] };
    list.forEach(t => {
      const s = t.status || '待办';
      if (groups[s]) groups[s].push(t);
    });
    // 待办按优先级排序（高-紧急 > 中-重要 > 低-有空做）
    const pOrder = { '高-紧急': 0, '中-重要': 1, '低-有空做': 2 };
    ['待办', '进行中'].forEach(s => {
      groups[s].sort((a, b) => (pOrder[a.priority] || 3) - (pOrder[b.priority] || 3));
    });
    // 已完成按完成时间倒序
    groups['已完成'].sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
    res.json(groups);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 建议 → 任务：把 insights.suggestion 转为 todo 记录
app.post('/api/suggestion/to-todo', (req, res) => {
  try {
    const { text, priority, dueDate, module } = req.body;
    if (!text) return res.json({ success: false, message: '建议文本不能为空' });
    const list = readData('todo');
    // 去重：同文本建议 7 天内不重复创建
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const exists = list.some(t => t.title === text && t.createdAt >= sevenDaysAgo);
    if (exists) return res.json({ success: false, message: '该建议近7天已转为任务', duplicate: true });
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: text,
      category: '生活',
      priority: ['高-紧急', '中-重要', '低-有空做'].includes(priority) ? priority : '中-重要',
      status: '待办',
      dueDate: dueDate || '',
      content: '由认知引擎建议自动生成' + (module ? '（来源模块：' + module + '）' : ''),
      date: new Date().toISOString().split('T')[0],
      createdAt: new Date().toISOString(),
      source: 'suggestion'
    };
    list.push(item);
    writeData('todo', list);
    res.json({ success: true, item });
  } catch (e) {
    console.error('[suggestion/to-todo]', e.message);
    res.status(500).json({ success: false, message: '转换失败' });
  }
});

// ============================================================
// v5.6: 健康指标趋势 API
// ============================================================
app.get('/api/health-trends', (req, res) => {
  const days = parseInt(req.query.days) || 90;
  const body = readData('body');
  // 收集体重和血压数据，按日期排序
  const weightPoints = [];
  const bpPoints = [];
  for (const r of body) {
    if (!r.date) continue;
    const w = parseFloat(r.weight);
    if (!isNaN(w) && w > 0) weightPoints.push({ date: r.date, weight: w });
    if (r.bloodPressure && typeof r.bloodPressure === 'string') {
      const m = r.bloodPressure.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) {
        const sys = parseInt(m[1]);
        const dia = parseInt(m[2]);
        if (sys > 0 && dia > 0) bpPoints.push({ date: r.date, sys, dia });
      }
    }
  }
  weightPoints.sort((a,b) => a.date < b.date ? -1 : 1);
  bpPoints.sort((a,b) => a.date < b.date ? -1 : 1);
  // 只取最近N天
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const wFiltered = weightPoints.filter(p => p.date >= cutoffStr);
  const bpFiltered = bpPoints.filter(p => p.date >= cutoffStr);
  // 统计
  const stats = {};
  if (wFiltered.length) {
    const vals = wFiltered.map(p => p.weight);
    const first = vals[0], last = vals[vals.length - 1];
    const min = Math.min(...vals), max = Math.max(...vals);
    const avg = vals.reduce((a,b) => a+b, 0) / vals.length;
    stats.weight = {
      count: vals.length, first: +first.toFixed(1), last: +last.toFixed(1),
      min: +min.toFixed(1), max: +max.toFixed(1), avg: +avg.toFixed(1),
      change: +(last - first).toFixed(1),
      trend: last > first + 0.5 ? '上升' : last < first - 0.5 ? '下降' : '稳定'
    };
  }
  if (bpFiltered.length) {
    const sysVals = bpFiltered.map(p => p.sys);
    const diaVals = bpFiltered.map(p => p.dia);
    const sysAvg = sysVals.reduce((a,b) => a+b, 0) / sysVals.length;
    const diaAvg = diaVals.reduce((a,b) => a+b, 0) / diaVals.length;
    const lastBp = bpFiltered[bpFiltered.length - 1];
    stats.bp = {
      count: bpFiltered.length,
      sysAvg: Math.round(sysAvg), diaAvg: Math.round(diaAvg),
      lastSys: lastBp.sys, lastDia: lastBp.dia,
      level: lastBp.sys >= 140 || lastBp.dia >= 90 ? '偏高' :
             lastBp.sys < 90 || lastBp.dia < 60 ? '偏低' : '正常'
    };
  }
  res.json({
    weight: wFiltered,
    bloodPressure: bpFiltered,
    stats,
    days
  });
});

// ============================================================
// v5.6: 周/月计划 API
// ============================================================
function getPlans() {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get('plans');
  if (!row) return [];
  try { const arr = JSON.parse(row.value); return Array.isArray(arr) ? arr : []; } catch(e) { return []; }
}
function savePlans(list) {
  db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run('plans', JSON.stringify(list));
}
function isoWeek(d) {
  const date = new Date(d);
  date.setHours(0,0,0,0);
  date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
  const week1 = new Date(date.getFullYear(), 0, 4);
  return 1 + Math.round(((date - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}
function getPeriodKey(type, dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  if (type === 'week') {
    const y = d.getFullYear();
    const w = isoWeek(d);
    return `${y}-W${String(w).padStart(2,'0')}`;
  } else {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }
}
app.get('/api/plan', (req, res) => {
  const type = req.query.type; // 'week' or 'month'
  const period = req.query.period;
  let plans = getPlans();
  if (type) plans = plans.filter(p => p.type === type);
  if (period) plans = plans.filter(p => p.period === period);
  // 计算完成度
  plans = plans.map(p => {
    const total = (p.items || []).length;
    const done = (p.items || []).filter(i => i.done).length;
    return { ...p, total, done, progress: total > 0 ? Math.round(done/total*100) : 0 };
  });
  // 按period倒序
  plans.sort((a,b) => (a.period < b.period ? 1 : -1));
  res.json(plans);
});
app.post('/api/plan', (req, res) => {
  const { type, period, title, items } = req.body;
  if (!type || !['week','month'].includes(type)) return res.json({ success: false, message: '类型应为 week 或 month' });
  const targetPeriod = period || getPeriodKey(type);
  const plans = getPlans();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const newPlan = {
    id,
    type,
    period: targetPeriod,
    title: title || (type === 'week' ? '第'+targetPeriod.split('-W')[1]+'周计划' : targetPeriod+'月计划'),
    items: Array.isArray(items) ? items.map((t,i) => ({ id: 'pi_'+i, text: t, done: false })) : [],
    createdAt: new Date().toISOString()
  };
  plans.push(newPlan);
  savePlans(plans);
  res.json({ success: true, plan: newPlan });
});
app.delete('/api/plan/:id', (req, res) => {
  const plans = getPlans();
  const filtered = plans.filter(p => p.id !== req.params.id);
  savePlans(filtered);
  res.json({ success: true, removed: plans.length - filtered.length });
});
app.post('/api/plan/:id/item', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ success: false, message: '内容不能为空' });
  const plans = getPlans();
  const p = plans.find(p => p.id === req.params.id);
  if (!p) return res.json({ success: false, message: '计划不存在' });
  if (!p.items) p.items = [];
  p.items.push({ id: 'pi_' + Date.now().toString(36), text: text.trim(), done: false });
  savePlans(plans);
  res.json({ success: true, items: p.items });
});
app.post('/api/plan/:planId/item/:itemId/toggle', (req, res) => {
  const plans = getPlans();
  const p = plans.find(p => p.id === req.params.planId);
  if (!p) return res.json({ success: false, message: '计划不存在' });
  const it = (p.items || []).find(i => i.id === req.params.itemId);
  if (!it) return res.json({ success: false, message: '事项不存在' });
  it.done = !it.done;
  if (it.done) it.completedAt = new Date().toISOString();
  else delete it.completedAt;
  savePlans(plans);
  const done = (p.items || []).filter(i => i.done).length;
  const total = (p.items || []).length;
  res.json({ success: true, item: it, done, total, progress: total > 0 ? Math.round(done/total*100) : 0 });
});
app.delete('/api/plan/:planId/item/:itemId', (req, res) => {
  const plans = getPlans();
  const p = plans.find(p => p.id === req.params.planId);
  if (!p) return res.json({ success: false, message: '计划不存在' });
  p.items = (p.items || []).filter(i => i.id !== req.params.itemId);
  savePlans(plans);
  res.json({ success: true, items: p.items });
});
// 计划执行对比（与上一周期对比完成率）
app.get('/api/plan/compare', (req, res) => {
  const type = req.query.type || 'week';
  const plans = getPlans().filter(p => p.type === type).sort((a,b) => (a.period < b.period ? -1 : 1));
  if (plans.length === 0) return res.json({ history: [], message: '暂无'+(type==='week'?'周':'月')+'计划数据' });
  const history = plans.map(p => {
    const total = (p.items || []).length;
    const done = (p.items || []).filter(i => i.done).length;
    return {
      period: p.period,
      title: p.title,
      total, done,
      rate: total > 0 ? Math.round(done/total*100) : 0
    };
  });
  let message = '';
  if (history.length >= 2) {
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    const diff = last.rate - prev.rate;
    if (diff > 5) message = `📈 ${last.period}完成率${last.rate}%，比上一周期提升${diff}个百分点`;
    else if (diff < -5) message = `📉 ${last.period}完成率${last.rate}%，比上一周期下降${Math.abs(diff)}个百分点，需要关注`;
    else message = `➡️ ${last.period}完成率${last.rate}%，与上一周期基本持平`;
  } else {
    message = `首个${type==='week'?'周':'月'}计划，完成率${history[0].rate}%`;
  }
  res.json({ history, message });
});

// ============================================================
// v5.7: 因果推断引擎（滞后时间窗）
// ============================================================
function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((a,b) => a+b, 0) / n;
  const my = y.reduce((a,b) => a+b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}
app.get('/api/eng/causal', (req, res) => {
  const lagDays = parseInt(req.query.lag) || 1; // 滞后天数
  const maxLag = parseInt(req.query.maxLag) || 7;
  // 因变量候选：情绪rating
  // 自变量候选：睡眠hours、锻炼duration、饮食calories
  const emotion = readData('emotion').filter(e => e.date && e.rating);
  const sleep = readData('sleep').filter(s => s.date && s.hours);
  const exercise = readData('exercise').filter(e => e.date && e.duration);
  if (emotion.length < 7) {
    return res.json({
      success: false, message: '需要至少7条情绪记录才能进行因果推断',
      sampleSize: emotion.length
    });
  }
  // 构建每日指标map
  const dayMap = {};
  emotion.forEach(e => {
    const d = e.date;
    if (!dayMap[d]) dayMap[d] = {};
    dayMap[d].mood = parseFloat(e.rating) || 0;
  });
  sleep.forEach(s => {
    if (!dayMap[s.date]) dayMap[s.date] = {};
    dayMap[s.date].sleep = parseFloat(s.hours) || 0;
  });
  exercise.forEach(e => {
    if (!dayMap[e.date]) dayMap[e.date] = {};
    dayMap[e.date].exercise = parseFloat(e.duration) || 0;
  });
  // 因子列表
  const factors = [
    { key: 'sleep', name: '睡眠时长', unit: '小时' },
    { key: 'exercise', name: '锻炼时长', unit: '分钟' }
  ];
  // 对每个因子，测试0~maxLag天的滞后相关性
  const results = factors.map(f => {
    const lagTests = [];
    for (let lag = 0; lag <= maxLag; lag++) {
      const x = [], y = [];
      Object.keys(dayMap).forEach(d => {
        if (dayMap[d].mood === undefined) return;
        const srcDate = new Date(d);
        srcDate.setDate(srcDate.getDate() - lag);
        const srcKey = srcDate.toISOString().split('T')[0];
        const srcVal = dayMap[srcKey] && dayMap[srcKey][f.key];
        if (srcVal !== undefined) {
          x.push(srcVal);
          y.push(dayMap[d].mood);
        }
      });
      if (x.length >= 5) {
        const r = pearsonCorrelation(x, y);
        lagTests.push({ lag, r: +r.toFixed(3), n: x.length });
      }
    }
    // 找最强滞后
    let bestLag = 0, bestR = 0;
    lagTests.forEach(t => {
      if (Math.abs(t.r) > Math.abs(bestR)) { bestR = t.r; bestLag = t.lag; }
    });
    return {
      factor: f.key, factorName: f.name, unit: f.unit,
      lagTests, bestLag, bestR: +bestR.toFixed(3),
      strength: Math.abs(bestR) > 0.5 ? '强' : Math.abs(bestR) > 0.3 ? '中' : '弱',
      direction: bestR > 0 ? '正向' : '负向',
      insight: bestR > 0.3
        ? `${f.name}${bestLag === 0 ? '当天' : bestLag + '天前'}对情绪有${Math.abs(bestR) > 0.5 ? '显著' : '一定'}影响（r=${bestR.toFixed(2)}），${bestR > 0 ? '越多情绪越好' : '越多情绪反而越差'}`
        : `${f.name}与情绪的关联较弱，可能不是关键因素`
    };
  });
  res.json({
    success: true,
    sampleSize: emotion.length,
    lagDays, maxLag,
    factors: results,
    generatedAt: new Date().toISOString()
  });
});

// ============================================================
// v5.7: 个人基线算法
// ============================================================
app.get('/api/eng/baseline', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const filterRecent = (arr, key) => arr
    .filter(r => r.date && r.date >= cutoffStr && r[key] !== undefined && r[key] !== '' && !isNaN(parseFloat(r[key])))
    .map(r => parseFloat(r[key]));
  const stats = (vals) => {
    if (!vals.length) return null;
    vals.sort((a,b) => a-b);
    const sum = vals.reduce((a,b) => a+b, 0);
    const mean = sum / vals.length;
    const variance = vals.reduce((a,b) => a + (b-mean)**2, 0) / vals.length;
    return {
      count: vals.length,
      mean: +mean.toFixed(2),
      median: +vals[Math.floor(vals.length/2)].toFixed(2),
      min: +vals[0].toFixed(2),
      max: +vals[vals.length-1].toFixed(2),
      p25: +vals[Math.floor(vals.length*0.25)].toFixed(2),
      p75: +vals[Math.floor(vals.length*0.75)].toFixed(2),
      std: +Math.sqrt(variance).toFixed(2),
      cv: mean !== 0 ? +(Math.sqrt(variance)/Math.abs(mean)*100).toFixed(1) : 0
    };
  };
  // 各维度基线
  const emotion = readData('emotion');
  const sleep = readData('sleep');
  const exercise = readData('exercise');
  const diet = readData('diet');
  const baselines = {};
  const moodStats = stats(filterRecent(emotion, 'rating'));
  if (moodStats) baselines.mood = { ...moodStats, label: '情绪基线', unit: '/10', normal: [moodStats.p25, moodStats.p75] };
  const sleepStats = stats(filterRecent(sleep, 'hours'));
  if (sleepStats) baselines.sleep = { ...sleepStats, label: '睡眠基线', unit: '小时', normal: [sleepStats.p25, sleepStats.p75] };
  const exStats = stats(filterRecent(exercise, 'duration'));
  if (exStats) baselines.exercise = { ...exStats, label: '锻炼基线', unit: '分钟', normal: [exStats.p25, exStats.p75] };
  // 今日偏离
  const today = new Date().toISOString().split('T')[0];
  const deviations = [];
  const todayMood = emotion.find(e => e.date === today);
  const todaySleep = sleep.find(s => s.date === today);
  const todayEx = exercise.find(e => e.date === today);
  if (baselines.mood && todayMood && todayMood.rating) {
    const v = parseFloat(todayMood.rating);
    deviations.push({ key: 'mood', label: '今日情绪', value: v, baseline: baselines.mood.mean, dev: +(v - baselines.mood.mean).toFixed(2), status: v < baselines.mood.p25 ? 'below' : v > baselines.mood.p75 ? 'above' : 'normal' });
  }
  if (baselines.sleep && todaySleep && todaySleep.hours) {
    const v = parseFloat(todaySleep.hours);
    deviations.push({ key: 'sleep', label: '今日睡眠', value: v, baseline: baselines.sleep.mean, dev: +(v - baselines.sleep.mean).toFixed(2), status: v < baselines.sleep.p25 ? 'below' : v > baselines.sleep.p75 ? 'above' : 'normal' });
  }
  if (baselines.exercise && todayEx && todayEx.duration) {
    const v = parseFloat(todayEx.duration);
    deviations.push({ key: 'exercise', label: '今日锻炼', value: v, baseline: baselines.exercise.mean, dev: +(v - baselines.exercise.mean).toFixed(2), status: v < baselines.exercise.p25 ? 'below' : v > baselines.exercise.p75 ? 'above' : 'normal' });
  }
  // 综合评估
  const dimensions = Object.keys(baselines).length;
  const insight = dimensions === 0
    ? `近${days}天数据不足，无法建立基线。建议持续记录情绪、睡眠、锻炼数据。`
    : `已基于近${days}天${dimensions}个维度数据建立个人基线。基线是"你的常态"，偏离基线的事件才值得关注——平稳不一定是好事，剧烈波动也不一定是坏事，关键是知道"为什么偏"。`;
  res.json({
    success: true,
    days,
    baselines,
    deviations,
    insight,
    generatedAt: new Date().toISOString()
  });
});

// ============================================================
// v5.7: 人生节点标记
// ============================================================
app.get('/api/life-milestone', (req, res) => {
  res.json(readData('life_milestone'));
});
app.post('/api/life-milestone', (req, res) => {
  const { title, date, type, description, impact, lesson } = req.body;
  if (!title || !date) return res.json({ success: false, message: '标题和日期必填' });
  const list = readData('life_milestone');
  const item = {
    id: genId(),
    title,
    date,
    type: type || '转折',
    description: description || '',
    impact: impact || '',
    lesson: lesson || '',
    createdAt: new Date().toISOString()
  };
  list.push(item);
  writeData('life_milestone', list);
  res.json({ success: true, item });
});
app.put('/api/life-milestone/:id', (req, res) => {
  const list = readData('life_milestone');
  const item = list.find(i => String(i.id) === String(req.params.id));
  if (!item) return res.json({ success: false, message: '节点不存在' });
  Object.assign(item, req.body);
  writeData('life_milestone', list);
  res.json({ success: true, item });
});
app.delete('/api/life-milestone/:id', (req, res) => {
  const list = readData('life_milestone');
  const filtered = list.filter(i => String(i.id) !== String(req.params.id));
  writeData('life_milestone', filtered);
  res.json({ success: true, removed: list.length - filtered.length });
});

// ============================================================
// v5.7: 季节性情绪分析
// ============================================================
app.get('/api/eng/seasonal', (req, res) => {
  const emotion = readData('emotion').filter(e => e.date && e.rating);
  if (emotion.length < 14) {
    return res.json({
      success: false,
      message: '需要至少14条情绪记录才能进行季节性分析',
      sampleSize: emotion.length
    });
  }
  // 按月聚合
  const byMonth = {};
  for (let m = 1; m <= 12; m++) byMonth[m] = [];
  emotion.forEach(e => {
    const d = new Date(e.date);
    if (isNaN(d.getTime())) return;
    const m = d.getMonth() + 1;
    byMonth[m].push(parseFloat(e.rating) || 0);
  });
  const monthly = [];
  for (let m = 1; m <= 12; m++) {
    const vals = byMonth[m];
    if (vals.length > 0) {
      monthly.push({
        month: m,
        monthName: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'][m-1],
        avg: +(vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(2),
        count: vals.length,
        min: +Math.min(...vals).toFixed(1),
        max: +Math.max(...vals).toFixed(1)
      });
    }
  }
  // 按季节聚合
  const seasons = {
    '春季': [3,4,5],
    '夏季': [6,7,8],
    '秋季': [9,10,11],
    '冬季': [12,1,2]
  };
  const seasonal = [];
  Object.keys(seasons).forEach(name => {
    const months = seasons[name];
    const vals = months.flatMap(m => byMonth[m] || []);
    if (vals.length > 0) {
      seasonal.push({
        season: name,
        months: months.join(','),
        avg: +(vals.reduce((a,b) => a+b, 0) / vals.length).toFixed(2),
        count: vals.length
      });
    }
  });
  // 找最高/最低季节
  let bestSeason = null, worstSeason = null;
  if (seasonal.length >= 2) {
    const sorted = [...seasonal].sort((a,b) => b.avg - a.avg);
    bestSeason = sorted[0];
    worstSeason = sorted[sorted.length - 1];
  }
  // 当前季节
  const nowMonth = new Date().getMonth() + 1;
  let currentSeason = null;
  Object.keys(seasons).forEach(name => {
    if (seasons[name].includes(nowMonth)) currentSeason = name;
  });
  const currentSeasonData = seasonal.find(s => s.season === currentSeason);
  // 生成洞察
  let insight = '';
  if (bestSeason && worstSeason && bestSeason.season !== worstSeason.season) {
    const diff = bestSeason.avg - worstSeason.avg;
    if (diff > 0.5) {
      insight = `检测到明显季节性差异：${bestSeason.season}情绪最高(${bestSeason.avg}分)，${worstSeason.season}最低(${worstSeason.avg}分)，相差${diff.toFixed(1)}分。`;
      if (worstSeason.season === '冬季') insight += '可能存在冬季情绪低落（SAD），建议增加日照、补充维生素D。';
      else if (worstSeason.season === '夏季') insight += '夏季情绪偏低，可能与高温、湿度有关，注意降温避暑。';
      else if (worstSeason.season === '春季') insight += '春季情绪偏低，注意"春困"，保持规律作息。';
      else insight += '注意识别该季节的低落诱因，提前预防。';
    } else {
      insight = `各季节情绪差异不大(${diff.toFixed(1)}分)，情绪相对稳定，季节性影响不显著。`;
    }
  } else {
    insight = '数据不足以判断季节性差异，建议记录满一年后再做分析。';
  }
  if (currentSeasonData) {
    insight += ` 当前为${currentSeason}，平均${currentSeasonData.avg}分。`;
  }
  res.json({
    success: true,
    sampleSize: emotion.length,
    monthly,
    seasonal,
    bestSeason,
    worstSeason,
    currentSeason,
    currentSeasonData,
    insight,
    generatedAt: new Date().toISOString()
  });
});

// ============================================================
// 备份 API：备份目录放在项目根目录，与 data/ 隔离，防止误删 data 时连带清空备份
// 备份格式 v2：.pack.gz（gzip 压缩的 JSON 包，含 qiezi.db + auth.json + .env 快照）
// 向后兼容 v1：.db 格式（只含 SQLite DB，auth.json 不含在内）
// ============================================================
const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
// 旧备份目录（data/backups/），用于兼容迁移
const OLD_BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PACK_GZ_EXT = '.pack.gz';
const OLD_DB_EXT = '.db';
const BACKUP_PACK_VERSION = 1;

function isBackupFile(f) {
  return f.startsWith('qiezi-') && (f.endsWith(PACK_GZ_EXT) || f.endsWith(OLD_DB_EXT));
}
function isNewFormat(f) { return f.endsWith(PACK_GZ_EXT); }

// 读取备份包文件并解析，返回 { version, created, files: { qiezi.db: Buffer, auth.json: Buffer, '.env': Buffer } }
function unpackBackup(fpath) {
  const fname = path.basename(fpath);
  if (isNewFormat(fname)) {
    const raw = fs.readFileSync(fpath);
    const json = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
    const files = {};
    for (const [name, b64] of Object.entries(json.files || {})) {
      files[name] = Buffer.from(b64, 'base64');
    }
    return { version: json.version, created: json.created, files };
  } else {
    // v1 旧格式：只包含 DB
    return {
      version: 0,
      created: fs.statSync(fpath).mtimeMs,
      files: { 'qiezi.db': fs.readFileSync(fpath) }
    };
  }
}

// 恢复备份文件到指定目录：写入 qiezi.db + auth.json（如果有）+ .env（如果有）
function restoreBackupToDisk(fpath, targetDir) {
  const pack = unpackBackup(fpath);
  if (!pack.files['qiezi.db']) throw new Error('备份文件不包含 qiezi.db，损坏');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'qiezi.db'), pack.files['qiezi.db']);
  if (pack.files['auth.json']) {
    fs.writeFileSync(path.join(targetDir, 'auth.json'), pack.files['auth.json']);
  }
  if (pack.files['.env']) {
    const envPath = path.join(targetDir, '..', '.env');
    try { fs.writeFileSync(envPath, pack.files['.env']); } catch (e) {}
  }
  return pack;
}

// 备份完整性校验：尝试打开 DB + 解析 pack 结构
function verifyBackup(fpath) {
  const fname = path.basename(fpath);
  try {
    const pack = unpackBackup(fpath);
    const dbBuf = pack.files['qiezi.db'];
    if (!dbBuf || dbBuf.length < 100) return { ok: false, reason: 'DB size too small' };
    const tmpDb = path.join(BACKUP_DIR, `_verify_${Date.now()}_${Math.random().toString(36).slice(2,6)}.db`);
    try {
      fs.writeFileSync(tmpDb, dbBuf);
      const vdb = new (require('better-sqlite3'))(tmpDb, { readonly: true });
      vdb.prepare('SELECT COUNT(*) as c FROM records').get();
      vdb.close();
      return { ok: true, dbSize: dbBuf.length, hasAuth: !!pack.files['auth.json'], hasEnv: !!pack.files['.env'] };
    } finally {
      try { fs.unlinkSync(tmpDb); } catch (e) {}
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// 主备份函数：创建 pack.gz 格式，含 DB + auth.json + .env
async function doBackup() {
  try {
    const now = new Date();
    const fname = formatBackupFileName(now);
    const dst = path.join(BACKUP_DIR, fname);

    // 1. SQLite 官方 API 备份 DB（WAL checkpoint 后备份，比 cp 安全）
    const tmpDb = path.join(BACKUP_DIR, `_backup_${Date.now()}.db`);
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
    try { fs.unlinkSync(tmpDb); } catch (e) {}
    await db.backup(tmpDb);
    const dbBuffer = fs.readFileSync(tmpDb);
    try { fs.unlinkSync(tmpDb); } catch (e) {}
    if (dbBuffer.length < 100) throw new Error('DB backup too small (<100B), abort');

    // 2. 收集额外文件（auth.json, .env）
    const fileBuffers = {};
    fileBuffers['qiezi.db'] = dbBuffer;
    if (fs.existsSync(AUTH_FILE)) {
      fileBuffers['auth.json'] = fs.readFileSync(AUTH_FILE);
    }
    if (fs.existsSync(ENV_FILE)) {
      try { fileBuffers['.env'] = fs.readFileSync(ENV_FILE); } catch (e) {}
    }

    // 3. 打包成 JSON → gzip → 写入 .pack.gz
    const b64Files = {};
    for (const [name, buf] of Object.entries(fileBuffers)) {
      b64Files[name] = buf.toString('base64');
    }
    const packObj = {
      version: BACKUP_PACK_VERSION,
      created: now.toISOString(),
      createdMs: now.getTime(),
      files: b64Files
    };
    const gz = zlib.gzipSync(JSON.stringify(packObj), { level: 6 });
    fs.writeFileSync(dst, gz);

    const size = fs.statSync(dst).size;
    // 4. 清理旧备份
    try { cleanupOldBackups(); } catch (e) {}
    return { ok: true, file: fname, size, format: 'pack.gz' };
  } catch (e) {
    throw new Error('doBackup 失败: ' + e.message);
  }
}

// 统一列出所有备份：扫描新目录 + 旧目录，合并去重，按时间倒序
function listAllBackups() {
  const all = new Map();
  const scanDir = (dir, label) => {
    try {
      const files = fs.readdirSync(dir).filter(isBackupFile);
      for (const f of files) {
        if (all.has(f)) continue;
        try {
          const st = fs.statSync(path.join(dir, f));
          all.set(f, {
            name: f, size: st.size, mtime: st.mtimeMs, dir, label,
            format: isNewFormat(f) ? 'pack.gz' : 'db',
            isNew: isNewFormat(f)
          });
        } catch (e) {}
      }
    } catch (e) {}
  };
  scanDir(BACKUP_DIR, 'backups/');
  scanDir(OLD_BACKUP_DIR, 'data/backups/');
  return Array.from(all.values()).sort((a, b) => b.mtime - a.mtime);
}

// 启动时：把旧备份从 data/backups/ 迁移到根目录 backups/（防止下次 rm -rf data 再次丢失）
(function migrateOldBackups() {
  try {
    if (!fs.existsSync(OLD_BACKUP_DIR)) return;
    const files = fs.readdirSync(OLD_BACKUP_DIR).filter(isBackupFile);
    let moved = 0;
    for (const f of files) {
      const src = path.join(OLD_BACKUP_DIR, f);
      const dst = path.join(BACKUP_DIR, f);
      if (!fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); moved++; } catch (e) {}
      }
    }
    if (moved > 0) console.log(`[migrateOldBackups] ✅ 从 data/backups/ 迁移 ${moved} 份历史备份到 backups/`);
  } catch (e) {
    console.warn('[migrateOldBackups] 迁移异常:', e.message);
  }
})();

// 统一查找备份文件（兼容两个目录）
function findBackupPath(fname) {
  if (!isBackupFile(fname)) return null;
  const newPath = path.join(BACKUP_DIR, fname);
  if (fs.existsSync(newPath)) return newPath;
  const oldPath = path.join(OLD_BACKUP_DIR, fname);
  if (fs.existsSync(oldPath)) return oldPath;
  return null;
}

// ============ 数据守护：启动时检测数据完整性 ============
// 防止误操作（如 rm -rf data）后产生空库导致用户以为数据丢了
(function dataGuardian() {
  const dbExists = fs.existsSync(DB_PATH);
  const dbSize = dbExists ? fs.statSync(DB_PATH).size : 0;
  const availableBackups = listAllBackups();

  if (!dbExists || dbSize < 8192) {
    // 数据库不存在或极小（< 8KB，基本是空库），尝试从最近备份恢复
    if (availableBackups.length > 0) {
      const latest = availableBackups[0];
      console.warn(`[dataGuardian] ⚠️  检测到异常：DB ${dbExists ? '仅' + dbSize + 'B' : '不存在'}，自动恢复最近备份 ${latest.label}${latest.name} (${latest.size}B)`);
      try {
        try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) {}
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        restoreBackupToDisk(path.join(latest.dir, latest.name), DATA_DIR);
        try { fs.unlinkSync(DB_PATH + '-wal'); } catch (e) {}
        try { fs.unlinkSync(DB_PATH + '-shm'); } catch (e) {}
        console.log(`[dataGuardian] ✅ 已从备份恢复: ${latest.name}（含 auth.json）`);
        setTimeout(() => process.exit(0), 500);
      } catch (e) {
        console.error('[dataGuardian] ❌ 自动恢复失败:', e.message);
      }
    } else if (dbSize < 8192) {
      console.warn('[dataGuardian] ⚠️  数据库为空且无可用备份，请检查是否误删了 data/ 目录');
    }
  }
  const hasNewFormat = availableBackups.some(b => b.isNew);
  console.log(`[dataGuardian] DB=${dbSize}B, 备份=${availableBackups.length}份${hasNewFormat ? '（含新格式）' : ''}${availableBackups[0] ? ', 最近=' + availableBackups[0].name : ''}`);
})();

function pad(n) { return String(n).padStart(2, '0'); }
// 统一用本地时间命名，hasTodayBackup 也用本地时间，避免 UTC 时区错位
function formatBackupFileName(d) {
  return `qiezi-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${PACK_GZ_EXT}`;
}
function getTodayLocalStr() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
}
// ============ 增强备份策略：写入防抖自动备份 + 分级保留 ============
// 规则：
// 1. 写入 API 触发后，5 分钟内连续写入只做 1 次备份（防抖）
// 2. 定时兜底：每小时检查当日是否已有备份，无则补 1 份
// 3. 保留策略分级：最近24小时全部保留 → 1-7天每天保留1份 → 7-30天每天保留1份 → 30天外删除
let lastBackupAt = 0;
const BACKUP_DEBOUNCE_MS = 5 * 60 * 1000;
function scheduleAutoBackup() {
  const now = Date.now();
  if (now - lastBackupAt < BACKUP_DEBOUNCE_MS) return;
  lastBackupAt = now;
  setImmediate(async () => {
    try {
      const r = await doBackup();
      if (r.ok) console.log(`[autoBackup] ✅ 写入触发备份: ${r.file} (${r.size}B, ${r.format})`);
    } catch (e) { console.warn('[autoBackup]', e.message); }
  });
}
function cleanupOldBackups() {
  const now = Date.now();
  const cut30d = now - 30 * 86400 * 1000;
  try {
    const processDir = (dir) => {
      try {
        const files = fs.readdirSync(dir).filter(isBackupFile);
        const withStat = files.map(f => {
          try {
            const st = fs.statSync(path.join(dir, f));
            return { name: f, mtime: st.mtimeMs, dir };
          } catch (e) { return null; }
        }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
        const keepKeys = new Set();
        const dayBuckets = {};
        for (const f of withStat) {
          const age = now - f.mtime;
          if (age < 86400000) { keepKeys.add(f.name); continue; }          // 最近24h 全留
          if (age < 7 * 86400000) {                                      // 1-7天 每天1份
            const day = new Date(f.mtime).toISOString().slice(0, 10);
            if (!dayBuckets['7d-' + day]) { dayBuckets['7d-' + day] = true; keepKeys.add(f.name); }
            continue;
          }
          if (age < 30 * 86400000) {                                     // 7-30天 每天1份
            const day = new Date(f.mtime).toISOString().slice(0, 10);
            if (!dayBuckets['30d-' + day]) { dayBuckets['30d-' + day] = true; keepKeys.add(f.name); }
            continue;
          }
          if (f.mtime < cut30d) { /* 超30天，不保留 */ continue; }
        }
        for (const f of withStat) {
          if (!keepKeys.has(f.name)) {
            try { fs.unlinkSync(path.join(f.dir, f.name)); } catch (e) {}
          }
        }
      } catch (e) {}
    };
    processDir(BACKUP_DIR);
    processDir(OLD_BACKUP_DIR);
  } catch (e) {}
}
function hasTodayBackup() {
  const todayStr = getTodayLocalStr();
  const check = (dir) => {
    try {
      return fs.readdirSync(dir).filter(f => f.startsWith('qiezi-' + todayStr) && isBackupFile(f)).length > 0;
    } catch (e) { return false; }
  };
  return check(BACKUP_DIR) || check(OLD_BACKUP_DIR);
}
// 备份列表 API：扫描两个目录
app.get('/api/backup/list', (req, res) => {
  try {
    const list = listAllBackups().map(b => ({
      file: b.name,
      size: b.size,
      mtime: b.mtime,
      mtimeStr: new Date(b.mtime).toISOString(),
      source: b.label,
      format: b.format
    }));
    res.json({ success: true, count: list.length, backups: list });
  } catch (e) {
    res.status(500).json({ success: false, message: '读取备份列表失败' });
  }
});
// 备份下载：兼容两个目录
app.get('/api/backup/download/:file', (req, res) => {
  try {
    const fname = path.basename(req.params.file);
    const fpath = findBackupPath(fname);
    if (!fpath) return res.status(404).json({ success: false, message: '备份文件不存在' });
    res.download(fpath, fname);
  } catch (e) {
    res.status(500).json({ success: false, message: '下载失败' });
  }
});
// 备份恢复：兼容两个目录 + 恢复前先快照当前状态
// 恢复内容：DB + auth.json + .env（如果 pack 里有）
app.post('/api/backup/restore/:file', async (req, res) => {
  try {
    const fname = path.basename(req.params.file);
    const fpath = findBackupPath(fname);
    if (!fpath) return res.status(404).json({ success: false, message: '备份文件不存在' });
    await doBackup();  // 先快照当前状态，防恢复错了回不来
    try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) {}
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const pack = restoreBackupToDisk(fpath, DATA_DIR);
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch (e) {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch (e) {}
    res.json({
      success: true,
      message: `恢复成功（含${pack.files['auth.json'] ? '密码配置' : 'DB数据'}），进程即将重启`,
      restored: {
        hasDb: !!pack.files['qiezi.db'],
        hasAuth: !!pack.files['auth.json'],
        hasEnv: !!pack.files['.env']
      }
    });
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    console.error('[restore]', e.message);
    res.status(500).json({ success: false, message: '恢复失败: ' + e.message });
    setTimeout(() => process.exit(1), 1000);
  }
});
// 新增：一键恢复最近备份（简化操作）
app.post('/api/backup/restore-latest', async (req, res) => {
  const list = listAllBackups();
  if (!list.length) return res.status(404).json({ success: false, message: '没有可用备份' });
  const latest = list[0];
  try {
    await doBackup();
    try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) {}
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const pack = restoreBackupToDisk(path.join(latest.dir, latest.name), DATA_DIR);
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch (e) {}
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch (e) {}
    res.json({
      success: true,
      message: `已恢复最近备份：${latest.name}（含${pack.files['auth.json'] ? '密码配置' : 'DB数据'}），进程即将重启`,
      file: latest.name,
      restored: {
        hasDb: !!pack.files['qiezi.db'],
        hasAuth: !!pack.files['auth.json'],
        hasEnv: !!pack.files['.env']
      }
    });
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    console.error('[restore-latest]', e.message);
    res.status(500).json({ success: false, message: '恢复失败: ' + e.message });
    setTimeout(() => process.exit(1), 1000);
  }
});
// 手动验证备份完整性
app.post('/api/backup/verify/:file', (req, res) => {
  try {
    const fname = path.basename(req.params.file);
    const fpath = findBackupPath(fname);
    if (!fpath) return res.status(404).json({ success: false, message: '备份文件不存在' });
    const r = verifyBackup(fpath);
    res.json({ success: r.ok, ...r, file: fname });
  } catch (e) {
    res.status(500).json({ success: false, message: '校验失败: ' + e.message });
  }
});
// 定时兜底备份：每小时检查 + 启动立即检查
const backupInterval = setInterval(async () => {
  if (!hasTodayBackup()) await doBackup();
}, 60 * 60 * 1000);
(async () => { if (!hasTodayBackup()) await doBackup(); })();

// ============================================================
// 服务器运维：WAL checkpoint + 数据库 VACUUM + 日志清理
// ============================================================
// WAL checkpoint：每小时将 WAL 日志合并到主库，避免 -wal 文件无限增长
// VACUUM：每天凌晨 3 点重建数据库文件，回收碎片空间
// PM2 日志清理：每天检查 PM2 日志大小，超过 10MB 自动轮转
function walCheckpoint() {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    console.log('[walCheckpoint] OK');
  } catch (e) {
    console.error('[walCheckpoint]', e.message);
  }
}
function vacuumDb() {
  try {
    db.exec('VACUUM');
    console.log('[vacuumDb] OK');
  } catch (e) {
    console.error('[vacuumDb]', e.message);
  }
}
function cleanupPm2Logs() {
  try {
    const os = require('os');
    const pm2LogDir = path.join(os.homedir(), '.pm2', 'logs');
    if (!fs.existsSync(pm2LogDir)) return;
    const files = fs.readdirSync(pm2LogDir);
    for (const f of files) {
      try {
        const fp = path.join(pm2LogDir, f);
        const st = fs.statSync(fp);
        if (st.size > 10 * 1024 * 1024) {
          // 超过 10MB，截断保留最后 1000 行
          const content = fs.readFileSync(fp, 'utf-8').split('\n');
          const tail = content.slice(-1000).join('\n');
          fs.writeFileSync(fp, tail);
          console.log('[cleanupPm2Logs] 截断', f, '从', st.size, '到', tail.length);
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('[cleanupPm2Logs]', e.message);
  }
}
// WAL checkpoint 每小时
const walInterval = setInterval(walCheckpoint, 60 * 60 * 1000);
// VACUUM + PM2日志清理 每天 03:00
function runDailyMaintenance() {
  vacuumDb();
  cleanupPm2Logs();
}
const dailyInterval = setInterval(() => {
  const now = new Date();
  if (now.getHours() === 3 && now.getMinutes() < 5) {
    runDailyMaintenance();
  }
}, 5 * 60 * 1000);
// 启动时先做一次 WAL checkpoint
setTimeout(walCheckpoint, 5000);
// 提供 API 让用户手动触发运维
app.post('/api/maintenance', (req, res) => {
  try {
    walCheckpoint();
    cleanupPm2Logs();
    const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    const walSize = fs.existsSync(DB_PATH + '-wal') ? fs.statSync(DB_PATH + '-wal').size : 0;
    const backupCount = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).length : 0;
    res.json({
      success: true,
      dbSize: dbSize,
      walSize: walSize,
      backupCount: backupCount,
      message: '运维完成：WAL已checkpoint, PM2日志已清理'
    });
  } catch (e) {
    res.status(500).json({ success: false, message: '运维失败: ' + e.message });
  }
});
app.post('/api/maintenance/vacuum', (req, res) => {
  try {
    vacuumDb();
    res.json({ success: true, message: 'VACUUM 完成，数据库已压缩' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
// 数据库状态查询
app.get('/api/maintenance/status', (req, res) => {
  try {
    const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    const walSize = fs.existsSync(DB_PATH + '-wal') ? fs.statSync(DB_PATH + '-wal').size : 0;
    const shmSize = fs.existsSync(DB_PATH + '-shm') ? fs.statSync(DB_PATH + '-shm').size : 0;
    const backupCount = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).length : 0;
    const backupSize = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).reduce((s, f) => {
      try { return s + fs.statSync(path.join(BACKUP_DIR, f)).size; } catch (e) { return s; }
    }, 0) : 0;
    res.json({
      success: true,
      dbSize: dbSize,
      walSize: walSize,
      shmSize: shmSize,
      backupCount: backupCount,
      backupSize: backupSize,
      totalSize: dbSize + walSize + shmSize + backupSize
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 回收站 API（必须在通用 CRUD 之前定义，否则会被 /api/:module 截获）
app.get('/api/trash', (req, res) => {
  try {
    const trash = readData('deleted');
    // 清理30天前的
    const now = Date.now();
    const valid = trash.filter(t => {
      if (!t._deletedAt) return false;
      return (now - new Date(t._deletedAt).getTime()) < 30 * 86400000;
    });
    if (valid.length !== trash.length) writeData('deleted', valid);
    res.json(valid);
  } catch (e) {
    console.error('[GET /api/trash]', e.message);
    res.status(500).json({ success: false, message: '读取回收站失败' });
  }
});
app.post('/api/trash/:id/restore', (req, res) => {
  try {
    const trash = readData('deleted');
    const item = trash.find(t => String(t.id) === String(req.params.id));
    if (!item) return res.json({ success: false, message: '记录不存在' });
    const mod = item._module;
    const restored = Object.assign({}, item);
    delete restored._module; delete restored._deletedAt;
    const modData = readData(mod);
    modData.push(restored);
    writeData(mod, modData);
    writeData('deleted', trash.filter(t => String(t.id) !== String(req.params.id)));
    res.json({ success: true });
  } catch (e) {
    console.error('[POST /api/trash/restore]', e.message);
    res.status(500).json({ success: false, message: '恢复失败' });
  }
});
app.delete('/api/trash/:id', (req, res) => {
  try {
    const trash = readData('deleted');
    writeData('deleted', trash.filter(t => String(t.id) !== String(req.params.id)));
    res.json({ success: true });
  } catch (e) {
    console.error('[DELETE /api/trash/:id]', e.message);
    res.status(500).json({ success: false, message: '删除失败' });
  }
});
// 清空回收站
app.delete('/api/trash', (req, res) => {
  try {
    writeData('deleted', []);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: '清空失败' });
  }
});

// 清空全部业务数据（仅清空 VALID_MODULES 内的记录，保留 deleted 回收站与系统配置）
app.post('/api/clear-all', (req, res) => {
  try {
    const cleared = [];
    VALID_MODULES.forEach(m => {
      try {
        const before = readData(m);
        if (before.length > 0) {
          writeData(m, []);
          cleared.push(m + ':' + before.length);
        }
      } catch (e) {
        console.error('[clear-all] 清空失败 mid=' + m + ':', e.message);
      }
    });
    // 同时清空回收站
    try { writeData('deleted', []); } catch (e) {}
    walCheckpoint();
    console.log('[clear-all] 已清空模块:', cleared.join(', ') || '无数据');
    res.json({ success: true, cleared: cleared, message: '已清空全部业务数据' });
  } catch (e) {
    console.error('[clear-all]', e.message);
    res.status(500).json({ success: false, message: '清空失败: ' + e.message });
  }
});

// ============================================================
// 通用 CRUD API（必须放在所有具体路由之后！）
// ============================================================
// 系统模块：禁止通过通用路由读取/写入，保护回收站等内部数据
const SYSTEM_MODULES = new Set(['deleted', 'trash', '__proto__', 'constructor', 'prototype']);
// 已知业务模块白名单（含 v5.6/v5.7 新增）
const VALID_MODULES = new Set([
  'finance','sleep','exercise','emotion','diet','body','relation','work','home','travel',
  'time','growth','spirit','learn','photo','think','diary','inventory','space','pet','medical','todo','health',
  'life_milestone','habits','quickNote','dailyQuestion','principles','decisions','fiveWhy',
  'interview','skill','work_mode','reading','bills','contacts','housework','mindfulness',
  'belief','character','selfImage','entropy','fragility','northstar','crisis','dyingTest',
  'annualNarrative','captainManifest','energy','reflection','rootCause','gameTheory',
  'discipline','review','habit_checkin','plan','growth_stage','journey','wisdom','reminder'
]);
function isModuleAllowed(m) {
  if (!m || typeof m !== 'string') return false;
  if (SYSTEM_MODULES.has(m)) return false;
  if (m.startsWith('kv_')) return false;
  return VALID_MODULES.has(m);
}

// ============ API 输入数据白名单校验 ============
// 定义每个模块允许的业务字段（不含系统字段 id/created/updated/_*）
const MODULE_ALLOWED_FIELDS = {
  finance: ['amount','category','date','note','type','account'],
  sleep: ['date','duration','quality','note','bedtime','waketime'],
  exercise: ['date','type','duration','intensity','note','calories'],
  emotion: ['date','type','level','note','trigger'],
  diet: ['date','type','food','calories','note','meal'],
  body: ['date','weight','height','bmi','note','measurement'],
  relation: ['name','type','note','contact','birthday'],
  work: ['title','content','status','priority','dueDate','tags'],
  home: ['room','item','note','status'],
  travel: ['destination','date','note','status','cost'],
  time: ['activity','duration','date','note'],
  growth: ['topic','content','date','status'],
  spirit: ['practice','duration','date','note'],
  learn: ['topic','content','date','progress','tags'],
  photo: ['url','caption','date','tags'],
  think: ['topic','content','date','tags'],
  diary: ['content','date','mood','tags'],
  inventory: ['name','quantity','location','note'],
  space: ['name','type','note'],
  pet: ['petName','type','sceneType','action','mood','food','cost','healthNote','vetNote','content','date'],
  medical: ['type','hospital','department','doctor','symptom','diagnosis','prescription','cost','paymentMethod','nextVisit','content','date'],
  todo: ['title','category','priority','status','dueDate','completed','content','date'],
  health: ['sceneType','symptom','area','severity','measure','weight','bloodPressure','type','hospital','department','doctor','diagnosis','prescription','cost','paymentMethod','nextVisit','content','date'],
  life_milestone: ['title','date','description','category'],
  habits: ['name','frequency','goal','note'],
  quickNote: ['content','date'],
  dailyQuestion: ['question','answer','date'],
  principles: ['title','content','importance'],
  decisions: ['title','rationale','date','outcome'],
  fiveWhy: ['topic','whys','conclusion'],
  interview: ['company','position','date','result','note'],
  skill: ['name','level','progress','category'],
  work_mode: ['mode','description','status'],
  reading: ['book','author','progress','note','rating'],
  bills: ['item','amount','dueDate','status'],
  contacts: ['name','phone','email','relation','note'],
  housework: ['task','frequency','lastDone'],
  mindfulness: ['type','duration','date','note'],
  belief: ['topic','content','strength'],
  character: ['trait','strength','growthArea'],
  selfImage: ['aspect','score','note'],
  entropy: ['source','impact','mitigation'],
  fragility: ['factor','mitigation','status'],
  northstar: ['description','steps','status'],
  crisis: ['trigger','response','outcome','date'],
  dyingTest: ['question','answer','date'],
  annualNarrative: ['year','narrative','highlights'],
  captainManifest: ['item','content','status'],
  energy: ['date','level','source','note'],
  reflection: ['topic','content','date','insight'],
  rootCause: ['problem','analysis','solution'],
  gameTheory: ['scenario','players','payoff','decision'],
  discipline: ['area','rule','violation','consequence'],
  review: ['topic','content','date','rating'],
  habit_checkin: ['habitId','date','completed','note'],
  plan: ['title','content','dueDate','status','priority'],
  growth_stage: ['stage','milestone','date','reflection'],
  journey: ['title','content','date','tags'],
  wisdom: ['topic','content','source','applicability']
};

// 系统保留字段，任何模块都不允许用户直接设置
const SYSTEM_FIELDS = new Set(['id', 'created', 'updated']);
const SYSTEM_FIELD_PREFIX = '_';

/**
 * 根据模块白名单清洗用户输入数据
 * @param {string} module - 模块名
 * @param {Object} data - 用户输入的单条数据对象
 * @returns {Object} - 清洗后的数据对象
 */
function sanitizeInputData(module, data) {
  if (!data || typeof data !== 'object') return null;
  
  const allowed = MODULE_ALLOWED_FIELDS[module];
  const sanitized = {};
  
  if (allowed) {
    // 模块有明确白名单：只保留白名单内的字段
    for (const key of allowed) {
      if (key in data) {
        sanitized[key] = data[key];
      }
    }
  } else {
    // 模块无白名单（如旧模块/未注册模块）：保留所有非系统字段
    for (const key in data) {
      if (!SYSTEM_FIELDS.has(key) && !key.startsWith(SYSTEM_FIELD_PREFIX)) {
        sanitized[key] = data[key];
      }
    }
  }
  
  return sanitized;
}

// ============ v6.5.9 提醒系统：到期检查端点 ============
app.get('/api/reminders/due', (req, res) => {
  try {
    const reminders = readData('reminder');
    const now = Date.now();
    const due = [];
    for (const r of reminders) {
      if (r.enabled === false) continue;
      const targetTime = new Date(r.datetime || r.date || '').getTime();
      if (isNaN(targetTime)) continue;
      // 判断是否到期：目标时间 <= 当前时间 且 未触发 或 重复提醒
      const lastTriggered = r.lastTriggered ? new Date(r.lastTriggered).getTime() : 0;
      if (r.repeat && r.repeat !== 'none') {
        // 重复提醒：计算最近一次应该触发的时间
        let nextTrigger = targetTime;
        if (r.repeat === 'daily') {
          while (nextTrigger < now) nextTrigger += 86400000;
        } else if (r.repeat === 'weekly') {
          while (nextTrigger < now) nextTrigger += 7 * 86400000;
        } else if (r.repeat === 'monthly') {
          while (nextTrigger < now) {
            const d = new Date(nextTrigger);
            d.setMonth(d.getMonth() + 1);
            nextTrigger = d.getTime();
          }
        }
        // 如果上次触发时间 < 本次应触发时间，则到期
        if (lastTriggered < nextTrigger - 86400000 && nextTrigger <= now + 60000) {
          due.push(r);
        }
      } else {
        // 一次性提醒：目标时间已到且未触发过
        if (targetTime <= now && lastTriggered === 0) {
          due.push(r);
        }
      }
    }
    res.json({ success: true, due, count: due.length });
  } catch (e) {
    res.status(500).json({ success: false, message: '提醒检查失败' });
  }
});

// ============ 首屏聚合接口：一次性返回所有核心模块数据 ============
// 替代前端 19 次串行请求，减少网络瀑布，首屏提速 3-5 倍
app.get('/api/bootstrap', (req, res) => {
  try {
    const BOOTSTRAP_MODULES = [
      'finance','sleep','exercise','emotion','diet','diary','learn','photo','think',
      'inventory','space','work','home','travel','body','relation','time','growth','spirit','pet','medical','todo','health','reminder'
    ];
    const result = {};
    for (const m of BOOTSTRAP_MODULES) {
      try {
        result[m] = readData(m);
      } catch (e) {
        result[m] = [];
      }
    }
    res.json(result);
  } catch (e) {
    console.error('[GET /api/bootstrap]', e.message);
    res.status(500).json({ success: false, message: '聚合加载失败' });
  }
});

// ============ 跨模块联动仪表盘 ============
// 宠物仪表盘：聚合宠物记录 + 财务花费 + 库存物资
app.get('/api/pet-dashboard', (req, res) => {
  try {
    const petRecords = readData('pet');
    const financeRecords = readData('finance');
    const inventoryRecords = readData('inventory');

    // 本月宠物花费（含联动自动创建的财务记录 + pet 自身 cost 字段）
    const now = new Date();
    const monthPrefix = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    let monthCost = 0;
    let totalCost = 0;
    for (const r of petRecords) {
      const c = parseFloat(r.cost) || 0;
      if (c > 0) {
        totalCost += c;
        if ((r.date || '').indexOf(monthPrefix) === 0) monthCost += c;
      }
    }
    // 也统计 finance 中 category=宠物 的记录
    let financePetCost = 0;
    for (const f of financeRecords) {
      if ((f.category === '宠物') && (f.type === '支出' || f.type === 'expense')) {
        financePetCost += parseFloat(f.amount) || 0;
      }
    }

    // 宠物物资（从库存中筛选名称包含宠物相关关键词的物品）
    const petKeywords = ['猫', '狗', '宠物', 'pet', '粮', '砂', '罐头', '零食', '牵引', '窝', '笼', '玩具', '指甲', '梳'];
    const petSupplies = inventoryRecords.filter(function(item) {
      const name = (item.name || '').toLowerCase();
      return petKeywords.some(function(kw) { return name.indexOf(kw) !== -1; });
    }).map(function(item) {
      return {
        name: item.name,
        quantity: item.quantity,
        category: item.category,
        condition: item.condition,
        purchaseDate: item.purchaseDate,
        price: item.price,
        lowStock: (parseInt(item.quantity) || 0) <= 1
      };
    });
    const lowStockItems = petSupplies.filter(function(s) { return s.lowStock; });

    // 最近就医记录
    const vetVisits = petRecords.filter(function(r) {
      return r.sceneType === '健康医疗' || (r.action && ['就医看病','打疫苗','驱虫','绝育/手术','健康检查'].indexOf(r.action) !== -1);
    }).slice(0, 5);

    // 按宠物名分组统计
    const petMap = {};
    for (const r of petRecords) {
      const name = r.petName || '未命名';
      if (!petMap[name]) petMap[name] = { name: name, type: r.type || '', count: 0, cost: 0, lastAction: '', lastDate: '' };
      petMap[name].count++;
      const c = parseFloat(r.cost) || 0;
      if (c > 0) petMap[name].cost += c;
      if (!petMap[name].lastDate || (r.date || '') > petMap[name].lastDate) {
        petMap[name].lastDate = r.date || '';
        petMap[name].lastAction = r.action || '';
      }
    }

    res.json({
      totalRecords: petRecords.length,
      monthCost: monthCost,
      totalCost: totalCost,
      financePetCost: financePetCost,
      petSummary: Object.values(petMap),
      supplies: petSupplies,
      lowStockAlerts: lowStockItems,
      recentVetVisits: vetVisits
    });
  } catch (e) {
    console.error('[GET /api/pet-dashboard]', e.message);
    res.status(500).json({ success: false, message: '宠物仪表盘加载失败' });
  }
});
// 未知模块兜底：允许读（返回空数组），但写操作必须显式校验
function isWriteModuleAllowed(m) {
  return isModuleAllowed(m);
}

app.get('/api/:module', (req, res) => {
  try {
    const m = req.params.module;
    // 系统模块不通过通用路由读取（health/trash/backup 等有专门路由）
    if (SYSTEM_MODULES.has(m)) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    res.json(readData(m));
  } catch (e) {
    console.error('[GET /api/:module]', e.message);
    res.status(500).json({ success: false, message: '读取失败' });
  }
});
app.post('/api/:module', (req, res) => {
  try {
    const m = req.params.module;
    if (!isWriteModuleAllowed(m)) {
      return res.status(400).json({ success: false, message: '模块名不合法: ' + m });
    }
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: '请求体必须是数组（全量替换语义）' });
    }
    // 字段白名单清洗：对数组中的每个对象进行清洗
    const sanitizedArray = req.body.map(item => sanitizeInputData(m, item)).filter(item => item !== null);
    writeData(m, sanitizedArray);
    scheduleAutoBackup();
    logger.info({ module: m, count: sanitizedArray.length }, 'POST /api/:module 全量替换');
    res.json({ success: true });
  } catch (e) {
    logger.error({ msg: e.message, stack: e.stack }, 'POST /api/:module 失败');
    res.status(500).json({ success: false, message: e.message || '保存失败' });
  }
});
app.post('/api/:module/add', (req, res) => {
  try {
    const m = req.params.module;
    if (!isWriteModuleAllowed(m)) {
      return res.status(400).json({ success: false, message: '模块名不合法: ' + m });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: '请求体必须是对象' });
    }
    const d = readData(m);
    // 字段白名单清洗
    const sanitized = sanitizeInputData(m, req.body);
    if (!sanitized || Object.keys(sanitized).length === 0) {
      return res.status(400).json({ success: false, message: '数据为空或字段不合法' });
    }
    const newItem = sanitized;
    if (!newItem.id) newItem.id = genId();
    d.push(newItem);
    writeData(m, d);
    scheduleAutoBackup();
    logger.info({ module: m, id: newItem.id }, 'POST /api/:module/add 新增');
    res.json({ success: true, id: newItem.id });
  } catch (e) {
    logger.error({ msg: e.message, stack: e.stack }, 'POST /api/:module/add 失败');
    res.status(500).json({ success: false, message: e.message || '保存失败' });
  }
});
app.delete('/api/:module/:id', (req, res) => {
  try {
    const m = req.params.module;
    if (SYSTEM_MODULES.has(m)) {
      return res.status(400).json({ success: false, message: '不能通过此路由删除系统模块' });
    }
    const d = readData(m);
    const targetId = String(req.params.id);
    const deletedItem = d.find(i => String(i.id) === targetId);
    // 回收站：移到 deleted 模块，30天后自动清理
    if (deletedItem) {
      const trash = readData('deleted');
      trash.push(Object.assign({}, deletedItem, { _module: m, _deletedAt: new Date().toISOString() }));
      writeData('deleted', trash);
    }
    writeData(m, d.filter(i => String(i.id) !== targetId));
    scheduleAutoBackup();
    res.json({ success: true, removed: d.length - readData(m).length });
  } catch (e) {
    console.error('[DELETE /api/:module/:id]', e.message);
    res.status(500).json({ success: false, message: '删除失败' });
  }
});

// 全局错误中间件：兜底所有未捕获异常，统一返回 JSON，不泄露堆栈
app.use((err, req, res, next) => {
  console.error('[UNCAUGHT]', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: '服务器内部错误' });
});
// 未捕获 Promise 拒绝：记录但不退出（Promise 拒绝非致命，避免误杀进程）
process.on('unhandledRejection', (reason) => {
  logger.error({
    msg: reason && reason.message,
    stack: reason && reason.stack
  }, 'unhandledRejection');
});
// 未捕获异常：进程已不稳定，记录后优雅退出由 PM2 重启
process.on('uncaughtException', (err) => {
  logger.fatal({
    msg: err && err.message,
    stack: err && err.stack
  }, 'uncaughtException -> gracefulShutdown');
  // 直接走 gracefulShutdown：清理定时器 -> 关 HTTP -> WAL checkpoint -> 关 DB -> 退出(1)
  // PM2 检测到退出后会自动拉起一个全新健康的进程
  try {
    if (!isShuttingDown) gracefulShutdown('uncaughtException');
    else process.exit(1);
  } catch (e) {
    logger.fatal({ msg: e && e.message }, 'gracefulShutdown 调用失败，强制退出');
    process.exit(1);
  }
});

// 回收站 API 已在通用 CRUD 之前定义，避免被 /api/:module 截获

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, '🍆 茄子管家启动');
});

// 优雅关闭：收到信号时停止接受新请求，等现有请求结束，关闭数据库
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.warn({ signal }, 'gracefulShutdown 开始');
  // 停止备份定时器
  try { clearInterval(backupInterval); clearInterval(walInterval); clearInterval(dailyInterval); } catch (e) {}
  server.close((err) => {
    if (err) logger.error({ msg: err.message }, 'gracefulShutdown server.close 错误');
    else logger.info('gracefulShutdown HTTP 服务已停止');
    try {
      // WAL checkpoint 后关闭数据库，避免数据丢失
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      logger.info('gracefulShutdown 数据库已关闭');
    } catch (e) {
      logger.error({ msg: e.message }, 'gracefulShutdown 数据库关闭错误');
    }
    // 信号触发正常退出 0；uncaughtException 触发退出 1，便于 PM2/监控识别异常重启
    process.exit(signal === 'uncaughtException' ? 1 : 0);
  });
  // 兜底：5 秒后强制退出，避免卡死
  setTimeout(() => {
    logger.error('gracefulShutdown 超时强制退出');
    process.exit(1);
  }, 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
