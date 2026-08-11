/* eslint-disable */
// ============================================================
// 安全硬伤3：异地备份（自动上传到腾讯云COS）
// 用法：
//   1) cd /home/ubuntu/qiezi-app
//   2) npm install cos-nodejs-sdk-v5   # 安装COS SDK
//   3) 在 .env 追加 COS 配置（见下方 CONFIG 注释）
//   4) node patch-cos-backup.js
//   5) pm2 restart eggplant
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const PKG = path.join(__dirname, 'package.json');

if (!fs.existsSync(SERVER)) {
  console.error('❌ 找不到 server.js，请在项目根目录执行');
  process.exit(1);
}

let src = fs.readFileSync(SERVER, 'utf8');
const orig = src;

// ---------- 1. package.json 增加 cos-nodejs-sdk-v5 依赖 ----------
let pkgChanged = false;
try {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (!pkg.dependencies) pkg.dependencies = {};
  if (!pkg.dependencies['cos-nodejs-sdk-v5']) {
    pkg.dependencies['cos-nodejs-sdk-v5'] = '^2.14.4';
    fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2));
    pkgChanged = true;
    console.log('✅ package.json 已加入 cos-nodejs-sdk-v5 依赖');
  }
} catch (e) {
  console.warn('⚠️  package.json 修改失败（可手动添加）:', e.message);
}

// ---------- 2. server.js：在 doBackup 成功后挂载 COS 上传 ----------
const OLD_RET = `    const size = fs.statSync(dst).size;
    // 4. 清理旧备份
    try { cleanupOldBackups(); } catch (e) {}
    return { ok: true, file: fname, size, format: 'pack.gz' };`;

const NEW_RET = `    const size = fs.statSync(dst).size;
    // 4. 清理旧备份
    try { cleanupOldBackups(); } catch (e) {}
    // 5. 异地备份：上传到腾讯云COS（非阻塞，失败不影响本地备份结果）
    try { scheduleCosUpload(dst, fname); } catch (e) { console.warn('[cos] hook error:', e.message); }
    return { ok: true, file: fname, size, format: 'pack.gz', cosScheduled: isCosEnabled() };`;

if (src.indexOf(OLD_RET) === -1) {
  console.error('❌ 未匹配到 doBackup 返回块，可能已打过补丁或代码已变更');
  process.exit(1);
}
src = src.replace(OLD_RET, NEW_RET);
console.log('✅ doBackup 已挂载 COS 上传钩子');

// ---------- 3. server.js：插入 COS 模块代码（在"定时兜底备份"前） ----------
const ANCHOR = '// 定时兜底备份：每小时检查 + 启动立即检查';
if (src.indexOf(ANCHOR) === -1) {
  console.error('❌ 未匹配到插入锚点（定时兜底备份注释）');
  process.exit(1);
}

const COS_BLOCK = `// ============================================================
// 异地备份：自动上传到腾讯云COS（安全硬伤3）
// 配置（写入 .env）：
//   COS_SECRET_ID=AKIDxxxxxxxxxxxx
//   COS_SECRET_KEY=xxxxxxxxxxxxxx
//   COS_BUCKET=qiezi-backup-1234567890   # 格式: <name>-<appid>
//   COS_REGION=ap-guangzhou
//   COS_PATH_PREFIX=backups/             # 可选，默认 backups/
//   COS_RETENTION=30                     # 可选，COS 端保留份数，默认 30
// 设计原则：
//   1. 懒加载 SDK——未安装 cos-nodejs-sdk-v5 也不影响服务启动
//   2. 配置缺失→静默禁用，不报错不崩溃
//   3. 异步非阻塞上传——本地备份成功即返回，COS 上传在后台进行
//   4. 上传失败不影响本地备份，仅记录到状态文件
//   5. COS 端独立保留策略（默认30份），与本地保留解耦
// ============================================================
let _cosClient = null;
let _cosInited = false;
const COS_STATE_FILE = path.join(DATA_DIR, 'cos-state.json');
let _cosUploadRunning = false; // 简单并发控制：同一时刻只跑一个上传

function isCosEnabled() {
  return !!(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY &&
            process.env.COS_BUCKET && process.env.COS_REGION);
}

function getCosClient() {
  if (_cosInited) return _cosClient;
  _cosInited = true;
  if (!isCosEnabled()) return null;
  let COS = null;
  try { COS = require('cos-nodejs-sdk-v5'); } catch (e) {
    console.warn('[cos] SDK 未安装（cos-nodejs-sdk-v5），异地备份已禁用。运行 npm install cos-nodejs-sdk-v5 启用。');
    return null;
  }
  try {
    _cosClient = new COS({
      SecretId: process.env.COS_SECRET_ID,
      SecretKey: process.env.COS_SECRET_KEY,
      Protocol: 'https:'
    });
    console.log('[cos] ✅ COS 客户端已初始化，Bucket=' + process.env.COS_BUCKET + ' Region=' + process.env.COS_REGION);
  } catch (e) {
    console.warn('[cos] 客户端初始化失败:', e.message);
    _cosClient = null;
  }
  return _cosClient;
}

function getCosKey(fname) {
  const prefix = (process.env.COS_PATH_PREFIX || 'backups/').replace(/\\/+$/, '');
  return prefix + '/' + fname;
}

function loadCosState() {
  try {
    if (fs.existsSync(COS_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(COS_STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { lastUploadAt: null, lastSuccessAt: null, lastError: null, totalUploaded: 0, lastFile: null };
}

function saveCosState(s) {
  try {
    const tmp = COS_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, COS_STATE_FILE);
  } catch (e) { console.warn('[cos] state save fail:', e.message); }
}

// 非阻塞调度上传：被 doBackup 调用
function scheduleCosUpload(localPath, fname) {
  if (!isCosEnabled()) return;
  if (_cosUploadRunning) {
    console.log('[cos] 上一次上传仍在进行，跳过本次（' + fname + '）');
    return;
  }
  setImmediate(() => { uploadBackupToCos(localPath, fname).catch(() => {}); });
}

// 实际上传实现（返回 Promise）
async function uploadBackupToCos(localPath, fname) {
  const client = getCosClient();
  if (!client) return { ok: false, reason: 'disabled' };
  if (_cosUploadRunning) return { ok: false, reason: 'busy' };
  _cosUploadRunning = true;
  const startedAt = new Date().toISOString();
  let state = loadCosState();
  try {
    if (!fs.existsSync(localPath)) throw new Error('本地备份文件不存在: ' + localPath);
    const Key = getCosKey(fname);
    await new Promise((resolve, reject) => {
      client.putObject({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Key,
        StorageClass: 'STANDARD_IA',   // 低频存储，省钱仍可快速取回
        Body: fs.createReadStream(localPath),
        onProgress: function(p) { /* 静默，避免日志噪音 */ }
      }, function(err, data) {
        if (err) reject(err); else resolve(data);
      });
    });
    state.lastUploadAt = startedAt;
    state.lastSuccessAt = new Date().toISOString();
    state.lastFile = fname;
    state.lastError = null;
    state.totalUploaded = (state.totalUploaded || 0) + 1;
    saveCosState(state);
    console.log('[cos] ✅ 已上传 ' + fname + ' → ' + Key);
    // 上传成功后清理 COS 端旧备份（不阻塞）
    cleanupCosBackups(client).catch(e => console.warn('[cos] cleanup fail:', e.message));
    return { ok: true, key: Key };
  } catch (e) {
    state.lastUploadAt = startedAt;
    state.lastError = e.message;
    saveCosState(state);
    console.warn('[cos] ❌ 上传失败 (' + fname + '):', e.message);
    return { ok: false, error: e.message };
  } finally {
    _cosUploadRunning = false;
  }
}

// COS 端保留策略：按份数保留（默认30），超出的最旧删除
async function cleanupCosBackups(client) {
  const retention = parseInt(process.env.COS_RETENTION || '30', 10);
  if (!retention || retention < 1) return;
  const prefix = (process.env.COS_PATH_PREFIX || 'backups/').replace(/\\/+$/, '') + '/';
  const objects = await new Promise((resolve, reject) => {
    const collected = [];
    let marker = '';
    function fetchPage() {
      client.getBucket({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Prefix: prefix,
        Marker: marker,
        MaxKeys: 200
      }, function(err, data) {
        if (err) return reject(err);
        (data.Contents || []).forEach(it => collected.push({ Key: it.Key, LastModified: it.LastModified }));
        if (data.IsTruncated === 'true' && data.NextMarker) {
          marker = data.NextMarker;
          fetchPage();
        } else {
          resolve(collected);
        }
      });
    }
    fetchPage();
  });
  // 只处理 qiezi-*.pack.gz 备份文件，按时间倒序
  const backups = objects
    .filter(o => /^qiezi-.*\\.pack\\.gz$/.test(path.basename(o.Key)))
    .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
  if (backups.length <= retention) return { kept: backups.length, deleted: 0 };
  const toDelete = backups.slice(retention);
  // COS 批量删除（每次最多1000）
  for (let i = 0; i < toDelete.length; i += 1000) {
    const chunk = toDelete.slice(i, i + 1000);
    await new Promise((resolve, reject) => {
      client.deleteMultipleObject({
        Bucket: process.env.COS_BUCKET,
        Region: process.env.COS_REGION,
        Objects: chunk.map(o => ({ Key: o.Key }))
      }, function(err) { if (err) reject(err); else resolve(); });
    });
  }
  console.log('[cos] 清理旧备份：删除 ' + toDelete.length + ' 份，保留 ' + retention + ' 份');
  return { kept: retention, deleted: toDelete.length };
}

// 手动触发：上传最近一份本地备份
app.get('/api/backup/cos-status', (req, res) => {
  try {
    const enabled = isCosEnabled();
    const sdkReady = !!getCosClient();
    const state = loadCosState();
    res.json({
      success: true,
      enabled,
      sdkReady,
      bucket: process.env.COS_BUCKET || null,
      region: process.env.COS_REGION || null,
      prefix: (process.env.COS_PATH_PREFIX || 'backups/'),
      retention: parseInt(process.env.COS_RETENTION || '30', 10),
      state
    });
  } catch (e) {
    res.status(500).json({ success: false, message: '查询 COS 状态失败: ' + e.message });
  }
});

app.post('/api/backup/cos-upload', async (req, res) => {
  try {
    if (!isCosEnabled()) {
      return res.status(400).json({ success: false, message: 'COS 未配置，请在 .env 设置 COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION' });
    }
    const list = listAllBackups();
    if (!list.length) return res.status(404).json({ success: false, message: '没有本地备份可上传' });
    const latest = list[0];
    const localPath = path.join(latest.dir, latest.name);
    // 手动触发时同步等待结果（便于用户立即看到反馈）
    const r = await uploadBackupToCos(localPath, latest.name);
    if (r.ok) {
      auditLog('cos_upload', req.ip, { file: latest.name, key: r.key }, true);
      res.json({ success: true, message: '已上传到 COS: ' + latest.name, file: latest.name, key: r.key });
    } else {
      auditLog('cos_upload', req.ip, { file: latest.name, error: r.error || r.reason }, false);
      res.status(500).json({ success: false, message: '上传失败: ' + (r.error || r.reason) });
    }
  } catch (e) {
    console.error('[cos-upload]', e.message);
    res.status(500).json({ success: false, message: '上传异常: ' + e.message });
  }
});

`;

src = src.replace(ANCHOR, COS_BLOCK + ANCHOR);
console.log('✅ COS 异地备份模块已插入 server.js');

// ---------- 4. 写回 ----------
if (src === orig) {
  console.log('ℹ️  无变更（可能已打过补丁）');
} else {
  fs.writeFileSync(SERVER, src);
  console.log('✅ server.js 已更新');
}

console.log('\n📋 后续步骤：');
console.log('  1. npm install cos-nodejs-sdk-v5');
console.log('  2. 在 .env 追加 COS 配置（参考脚本顶部注释）');
console.log('  3. pm2 restart eggplant');
console.log('  4. 验证：curl -H "Authorization: Bearer <token>" http://localhost:3000/api/backup/cos-status');
console.log('  5. 手动上传测试：curl -X POST -H "Authorization: Bearer <token>" http://localhost:3000/api/backup/cos-upload');
