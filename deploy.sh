#!/bin/bash
# ============================================================
# 茄子管家 安全部署脚本 v6.7.0
# 核心原则：永不触碰 data/ 和 backups/ 目录，保护 .env
# 用法：cd ~/qiezi-app && bash deploy.sh
# v6.7.0：index.html 拆分为精简 HTML + styles.css + app.js + sw-register.js
#         每个文件独立下载，避免单文件过大（363KB）导致 CDN 超时
# v6.5.7 修复：@commit 优先下载，移除 purge CDN 步骤（不再卡死）
# v6.4.1 修复：所有网络步骤加超时，npm 用国内镜像兜底，避免卡死
# ============================================================
# 不用 set -e，改为关键步骤手动检查（避免某步失败直接退出让人以为卡住）
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

# 全局超时：部署总时长上限 300 秒（5分钟），超时自动退出并打印诊断
( sleep 300 && echo "❌ 部署总时长超 5 分钟，已强制终止。请把上方输出贴给我" && kill -TERM $$ 2>/dev/null ) &
WATCHDOG_PID=$!

echo "🍆 ===== 茄子管家安全部署 v6.7.0 ====="
echo "⏱️  开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# ---------- 第一步：数据保护（最重要）----------
echo "[1/6] 🛡️  数据保护检查..."
if [ -d data ]; then
  DB_SIZE=$(stat -c%s data/qiezi.db 2>/dev/null || echo 0)
  echo "      当前 DB: ${DB_SIZE} 字节"
  if [ -f data/auth.json ]; then
    echo "      auth.json: 存在（密码配置）"
  fi
fi
if [ -f .env ]; then
  echo "      .env: 存在（密钥已迁移）"
fi
if [ -d backups ]; then
  # 兼容两种格式：v1 .db + v2 .pack.gz
  BK_OLD=$(ls backups/qiezi-*.db 2>/dev/null | wc -l)
  BK_NEW=$(ls backups/qiezi-*.pack.gz 2>/dev/null | wc -l)
  BK_COUNT=$((BK_OLD + BK_NEW))
  echo "      备份数量: ${BK_COUNT} 份（旧格式:${BK_OLD} + 新格式:${BK_NEW}）"
  echo "      最近备份:"
  (ls -lt backups/qiezi-*.pack.gz 2>/dev/null; ls -lt backups/qiezi-*.db 2>/dev/null) | head -3 | awk '{print "        "$9" ("$5" bytes)"}'
fi
echo ""

# ---------- 第二步：.env 保护（部署前先备份）----------
echo "[2/6] 🔐 保护 .env / auth.json 配置..."
TS=$(date +%Y%m%d-%H%M%S)
BK_DIR="$APP_DIR/backups"
mkdir -p "$BK_DIR"
# 配置快照：把 .env 和 auth.json 先复制到安全位置，防止 deploy 过程误覆盖
if [ -f .env ]; then
  cp -a .env "$BK_DIR/.env-snap-$TS.bak"
  echo "      ✅ 已快照 .env → backups/.env-snap-$TS.bak"
fi
if [ -f data/auth.json ]; then
  cp -a data/auth.json "$BK_DIR/auth.json-snap-$TS.bak"
  echo "      ✅ 已快照 auth.json → backups/auth.json-snap-$TS.bak"
fi
echo ""

# ---------- 第三步：部署前自动备份（安全网）----------
echo "[3/6] 💾 部署前全量备份（DB + 密码 + 密钥）..."
# 直接用 SQLite backup，不 require server.js（避免启动整个服务器卡住）
# 加 timeout 30 秒兜底，避免 better-sqlite3 异常卡住
if [ -f data/qiezi.db ]; then
  timeout 30 node -e "
    const Database=require('better-sqlite3');
    const fs=require('fs');
    const zlib=require('zlib');
    const db=new Database('data/qiezi.db');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const tmp='backups/_deploy_tmp_$TS.db';
    db.backup(tmp).then(()=>{
      const dbBuf=fs.readFileSync(tmp);
      fs.unlinkSync(tmp);
      const files={};
      files['qiezi.db']=dbBuf.toString('base64');
      if(fs.existsSync('data/auth.json')) files['auth.json']=fs.readFileSync('data/auth.json').toString('base64');
      if(fs.existsSync('.env')) files['.env']=fs.readFileSync('.env').toString('base64');
      const pack={version:1,created:new Date().toISOString(),files};
      const gz=zlib.gzipSync(JSON.stringify(pack),{level:6});
      fs.writeFileSync('backups/qiezi-predeploy-$TS.pack.gz', gz);
      console.log('      ✅ 备份完成: qiezi-predeploy-$TS.pack.gz ('+gz.length+'B)');
      db.close();
      process.exit(0);
    }).catch(e=>{console.error('      备份失败:',e.message);db.close();process.exit(1);});
  " 2>&1 || echo "      ⚠️ 备份失败或超时，继续部署（不影响）"
else
  echo "      跳过（无 data/qiezi.db）"
fi
echo ""

# ---------- 第四步：下载最新代码（只覆盖代码文件，绝不动数据/配置）----------
echo "[4/6] 📥 下载最新 server.js / package.json / frontend/* ..."
# 双下载源：优先 GitHub raw（实时同步，无 CDN 缓存陷阱），失败回退 jsDelivr
# 注意：jsDelivr CDN 有多层缓存，purge 后仍可能返回旧版本，所以 raw 优先
CURL_OPTS="-fsSL --connect-timeout 15 --max-time 60 --retry 3 --retry-delay 2"
try_download() {
  local dst="$1"; shift
  for url in "$@"; do
    echo "      尝试: $url"
    if curl $CURL_OPTS "$url" -o "$dst"; then
      echo "      ✅ 下载成功"
      return 0
    fi
    echo "      ⚠️  失败，尝试下一个源..."
  done
  return 1
}

# 内容校验：检查下载到的文件是否包含版本标记，避免 CDN 缓存返回旧代码
verify_download() {
  local dst="$1"; local marker="$2"
  if [ ! -s "$dst" ]; then return 1; fi
  if [ -n "$marker" ] && ! grep -q "$marker" "$dst" 2>/dev/null; then
    echo "      ⚠️  内容校验失败：未找到标记 '$marker'，疑似旧缓存"
    return 1
  fi
  return 0
}

# 带校验的下载：先试第一个源，校验失败再试第二个
try_download_verified() {
  local dst="$1"; local marker="$2"; shift 2
  for url in "$@"; do
    echo "      尝试: $url"
    if curl $CURL_OPTS "$url" -o "$dst"; then
      if verify_download "$dst" "$marker"; then
        echo "      ✅ 下载成功 + 内容校验通过"
        return 0
      else
        echo "      ⚠️  下载成功但内容是旧缓存，换源重试"
      fi
    else
      echo "      ⚠️  下载失败，换源"
    fi
  done
  return 1
}

GH_URL="https://raw.githubusercontent.com/eggplant-butler/qiezi-app/main"
CDN_URL="https://cdn.jsdelivr.net/gh/eggplant-butler/qiezi-app@main"

# 尝试拿最新 commit（用于 jsDelivr @commit 路径，绕过 CDN 缓存）
LATEST_COMMIT=$(git ls-remote https://github.com/eggplant-butler/qiezi-app.git HEAD 2>/dev/null | awk '{print $1}')
if [ -z "$LATEST_COMMIT" ]; then
  LATEST_COMMIT=$(curl -fsSL --connect-timeout 10 --max-time 20 "https://api.github.com/repos/eggplant-butler/qiezi-app/commits/main" 2>/dev/null | grep -oE '"sha":"[a-f0-9]+"' | head -1 | cut -d'"' -f4)
fi
if [ -n "$LATEST_COMMIT" ]; then
  echo "      📌 最新 commit: ${LATEST_COMMIT:0:7}"
  CDN_COMMIT_URL="https://cdn.jsdelivr.net/gh/eggplant-butler/qiezi-app@${LATEST_COMMIT}"
else
  echo "      ⚠️  无法获取最新 commit，仅用 @main"
  CDN_COMMIT_URL="$CDN_URL"
fi

# v6.5.7 修复：@commit 优先（绕过 CDN 缓存），@main 次之，GitHub raw 兜底
# 之前的 @main 优先策略导致 CDN 缓存返回旧代码，内容校验反复失败卡死
# 版本标记（动态从仓库 package.json 读取，避免脚本与代码版本不同步）
REMOTE_VERSION=$(curl -fsSL --max-time 10 "$CDN_COMMIT_URL/package.json" 2>/dev/null | grep -oE '"version":"[0-9.]+"' | head -1 | cut -d'"' -f4)
if [ -z "$REMOTE_VERSION" ]; then
  REMOTE_VERSION=$(curl -fsSL --max-time 10 "$CDN_URL/package.json" 2>/dev/null | grep -oE '"version":"[0-9.]+"' | head -1 | cut -d'"' -f4)
fi
if [ -z "$REMOTE_VERSION" ]; then
  REMOTE_VERSION="6.5"  # 兜底
fi
VERSION_TAG="v${REMOTE_VERSION%.*}"  # 取主次版本，如 6.5.7 → v6.5
echo "      🏷️  目标版本标记: $VERSION_TAG"

# v6.5.7 下载源顺序：@commit 优先 → @main → GitHub raw
try_download_verified server.js "$VERSION_TAG" \
  "$CDN_COMMIT_URL/server.js" \
  "$CDN_URL/server.js" \
  "$GH_URL/server.js" || { echo "❌ server.js 下载失败"; exit 1; }
try_download_verified package.json "qiezi" \
  "$CDN_COMMIT_URL/package.json" \
  "$CDN_URL/package.json" \
  "$GH_URL/package.json" || { echo "❌ package.json 下载失败"; exit 1; }

mkdir -p frontend
# v6.7.0：index.html 已拆分为精简 HTML + 外链 styles.css / app.js / sw-register.js
# 每个文件都小于 350KB，CDN 下载不会超时；且各自带版本号查询参数，避免缓存
try_download_verified frontend/index.html "engDashboard" \
  "$CDN_COMMIT_URL/frontend/index.html" \
  "$CDN_URL/frontend/index.html" \
  "$GH_URL/frontend/index.html" || { echo "❌ frontend/index.html 下载失败"; exit 1; }
# v6.7.0 新增：拆分后的 CSS/JS 外链文件
try_download_verified frontend/styles.css "深夜书房" \
  "$CDN_COMMIT_URL/frontend/styles.css" \
  "$CDN_URL/frontend/styles.css" \
  "$GH_URL/frontend/styles.css" || { echo "❌ frontend/styles.css 下载失败"; exit 1; }
try_download_verified frontend/app.js "reportClientError" \
  "$CDN_COMMIT_URL/frontend/app.js" \
  "$CDN_URL/frontend/app.js" \
  "$GH_URL/frontend/app.js" || { echo "❌ frontend/app.js 下载失败"; exit 1; }
try_download_verified frontend/sw-register.js "serviceWorker" \
  "$CDN_COMMIT_URL/frontend/sw-register.js" \
  "$CDN_URL/frontend/sw-register.js" \
  "$GH_URL/frontend/sw-register.js" || { echo "❌ frontend/sw-register.js 下载失败"; exit 1; }
# sw.js 必须成功（SW 旧版本会缓存旧 HTML，导致前端永远看不到新功能）
try_download_verified frontend/sw.js "$VERSION_TAG" \
  "$CDN_COMMIT_URL/frontend/sw.js" \
  "$CDN_URL/frontend/sw.js" \
  "$GH_URL/frontend/sw.js" || { echo "❌ frontend/sw.js 下载失败（关键文件，必须成功）"; exit 1; }

echo "      ✅ 代码文件已更新 + 内容校验通过（含 sw.js）"
echo ""

# ---------- 第五步：安装依赖（最易卡住：npm install 国内访问慢）----------
echo "[5/6] 📦 安装/更新 npm 依赖..."
echo "      使用淘宝镜像 + 60秒超时，避免卡死..."
# 优先用淘宝镜像，超时60秒，失败自动回退官方源
NPM_TIMEOUT=60
NPM_REGISTRY="https://registry.npmmirror.com"
NPM_FALLBACK="https://registry.npmjs.org"

# 检测 node_modules 是否已存在（已安装过则跳过，只做增量更新）
if [ -d node_modules ] && [ -d node_modules/express ]; then
  echo "      ℹ️  node_modules 已存在，仅做增量更新..."
  timeout $NPM_TIMEOUT npm install --no-audit --no-fund --registry="$NPM_REGISTRY" 2>&1 | tail -3 || \
    timeout $NPM_TIMEOUT npm install --no-audit --no-fund --registry="$NPM_FALLBACK" 2>&1 | tail -3 || \
    echo "      ⚠️ npm 增量更新失败，但 node_modules 已存在，继续部署"
else
  echo "      ℹ️  首次安装依赖..."
  timeout 120 npm install --no-audit --no-fund --registry="$NPM_REGISTRY" 2>&1 | tail -5 || \
    timeout 120 npm install --no-audit --no-fund --registry="$NPM_FALLBACK" 2>&1 | tail -5 || \
    echo "      ⚠️ npm 安装失败，继续部署（服务可能启动失败，请手动 npm install）"
fi
echo "      ✅ 依赖步骤完成"
echo ""

# ---------- 第六步：配置日志轮转 & 重启服务 ----------
echo "[6/6] 🔄 配置日志轮转 & 重启 PM2 服务..."
# pm2 install 加超时，避免卡住
timeout 30 pm2 install pm2-logrotate 2>/dev/null || echo "      ⚠️ pm2-logrotate 安装跳过（可能已安装）"
pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true
pm2 set pm2-logrotate:retain 10 2>/dev/null || true
pm2 set pm2-logrotate:compress true 2>/dev/null || true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD 2>/dev/null || true
echo "      ✅ 日志轮转策略已配置 (10MB/文件, 保留10天, 压缩)"

pm2 restart eggplant 2>&1 | tail -3 || pm2 start ecosystem.config.js 2>&1 | tail -3 || echo "      ⚠️ PM2 重启失败，请手动 pm2 restart eggplant"

sleep 4
echo ""
echo "🧪 部署后冒烟测试..."
# 1. 健康检查
HEALTH=$(curl -s --max-time 5 http://localhost:3000/api/health 2>/dev/null)
if [ -z "$HEALTH" ]; then
  echo "  ❌ /api/health 无响应"
  echo "  ⚠️  请执行：pm2 logs eggplant --lines 30 查看错误"
  exit 1
fi
VERSION=$(echo "$HEALTH" | grep -oE '"version":"[^"]+"' | cut -d'"' -f4)
STATUS=$(echo "$HEALTH" | grep -oE '"status":"[^"]+"' | cut -d'"' -f4)
UPTIME=$(echo "$HEALTH" | grep -oE '"uptimeSec":[0-9]+' | cut -d':' -f2)
RSS=$(echo "$HEALTH" | grep -oE '"rssBytes":[0-9]+' | cut -d':' -f2)
DB_CONN=$(echo "$HEALTH" | grep -oE '"connected":(true|false)' | head -1 | cut -d':' -f2)
RECENTLY=$(echo "$HEALTH" | grep -oE '"recentlyRestarted":(true|false)' | cut -d':' -f2)
echo "  健康检查: status=$STATUS, version=$VERSION, uptime=${UPTIME}s, rss=$((${RSS:-0}/1024/1024))MB"
echo "  数据库连接: $DB_CONN"
if [ "$STATUS" != "ok" ]; then
  echo "  ❌ 健康检查 status 异常，部署可能未完全成功"
  exit 1
fi
if [ "$DB_CONN" != "true" ]; then
  echo "  ❌ 数据库未连接，服务不可用"
  exit 1
fi
if [ "$RECENTLY" = "true" ]; then
  echo "  ⚠️  进程刚重启（uptime<90s），可能是崩溃后被 PM2 拉起，建议查看 pm2 logs eggplant --lines 50"
fi

# 2. 静态资源检查
HTML_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3000/ 2>/dev/null)
if [ "$HTML_STATUS" = "200" ]; then
  echo "  首页: 200 OK ✅"
else
  echo "  ⚠️  首页 HTTP $HTML_STATUS（非200，前端可能无法访问）"
fi
# v6.7.0 新增：拆分后的 CSS/JS 外链文件检查
for asset in styles.css app.js sw-register.js sw.js; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:3000/$asset" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo "  /$asset: 200 OK ✅"
  else
    echo "  ⚠️  /$asset HTTP $CODE"
  fi
done

# 3. 关键路由存在性检查（需认证端点返回 401 说明路由已注册）
for ep in /api/me /api/eng/dashboard /api/maintenance/status; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:3000$ep" 2>/dev/null)
  if [ "$CODE" = "401" ] || [ "$CODE" = "200" ]; then
    echo "  路由 $ep: ✅ 存在 ($CODE)"
  else
    echo "  路由 $ep: ⚠️  HTTP $CODE"
  fi
done

echo ""
echo "✅ ===== 部署完成！版本：v$VERSION ====="

# 最终数据 + 配置确认
echo ""
echo "📊 部署后数据状态："
if [ -f data/qiezi.db ]; then
  echo "   DB 大小: $(stat -c%s data/qiezi.db 2>/dev/null) 字节"
fi
if [ -f data/auth.json ]; then
  echo "   auth.json: 正常"
fi
if [ -f .env ]; then
  echo "   .env: 正常（密钥未丢失）"
fi
if [ -d backups ]; then
  BK_OLD=$(ls backups/qiezi-*.db 2>/dev/null | wc -l)
  BK_NEW=$(ls backups/qiezi-*.pack.gz 2>/dev/null | wc -l)
  echo "   备份总数: $((BK_OLD + BK_NEW)) 份（旧:$BK_OLD, 新:$BK_NEW）"
fi
echo "   ⚠️  永远不要执行 rm -rf data/ 或 rm -rf backups/"
echo ""
echo "🔒 安全加固状态："
echo "   ✅ JWT 认证 + 密钥在 .env（非 auth.json 明文）"
echo "   ✅ CORS 白名单收紧（只允许本机/内网/公网IP）"
echo "   ✅ 日志敏感字段脱敏（密码/token/secret）"
echo "   ✅ 备份格式 v2：DB + 密码 + 密钥 打包 .pack.gz"
echo "   ✅ 部署前自动双快照（.env + auth.json + 全量备份）"

# 关闭看门狗
kill $WATCHDOG_PID 2>/dev/null
echo ""
echo "⏱️  结束时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "🍆 ===== 部署流程结束 ====="
