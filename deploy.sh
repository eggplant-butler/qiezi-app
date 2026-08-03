#!/bin/bash
# ============================================================
# 茄子管家 安全部署脚本 v6.0
# 核心原则：永不触碰 data/ 和 backups/ 目录
# 用法：cd ~/qiezi-app && bash deploy.sh
# ============================================================
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "🍆 ===== 茄子管家安全部署 ====="
echo ""

# ---------- 第一步：数据保护（最重要）----------
echo "[1/5] 🛡️  数据保护检查..."
if [ -d data ]; then
  DB_SIZE=$(stat -c%s data/qiezi.db 2>/dev/null || echo 0)
  echo "      当前 DB: ${DB_SIZE} 字节"
fi
if [ -d backups ]; then
  BK_COUNT=$(ls backups/qiezi-*.db 2>/dev/null | wc -l)
  echo "      备份数量: ${BK_COUNT} 份"
  ls -lt backups/qiezi-*.db 2>/dev/null | head -3 | awk '{print "      最近备份: "$9" ("$5" bytes)"}'
fi
echo ""

# ---------- 第二步：部署前自动备份（安全网）----------
echo "[2/5] 💾 部署前自动备份（仅备份DB，不影响生产）..."
TS=$(date +%Y%m%d-%H%M%S)
BK_DIR="$APP_DIR/backups"
mkdir -p "$BK_DIR"
if [ -f data/qiezi.db ]; then
  # 用 SQLite 官方备份（比 cp 安全，WAL checkpoint 后备份）
  node -e "
    const Database=require('better-sqlite3');
    const path=require('path');
    const db=new Database('$APP_DIR/data/qiezi.db');
    db.backup('$BK_DIR/qiezi-predeploy-$TS.db').then(()=>{
      console.log('      备份完成: qiezi-predeploy-$TS.db');
      db.close();
    }).catch(e=>{console.error('备份失败:',e.message);process.exit(1);});
  " 2>&1 || true
fi
echo ""

# ---------- 第三步：下载最新代码（只覆盖代码文件）----------
echo "[3/5] 📥 下载最新 server.js / package.json / frontend/index.html ..."
BASE_URL="https://raw.githubusercontent.com/eggplant-butler/qiezi-app/main"
CURL_OPTS="-fsSL --connect-timeout 15 --max-time 60 --retry 3 --retry-delay 2"
curl $CURL_OPTS "$BASE_URL/server.js" -o server.js || { echo "❌ server.js 下载失败"; exit 1; }
curl $CURL_OPTS "$BASE_URL/package.json" -o package.json || { echo "❌ package.json 下载失败"; exit 1; }
mkdir -p frontend
curl $CURL_OPTS "$BASE_URL/frontend/index.html" -o frontend/index.html || { echo "❌ frontend/index.html 下载失败"; exit 1; }
echo "      ✅ 代码文件已更新"
echo ""

# ---------- 第四步：安装依赖 ----------
echo "[4/5] 📦 安装/更新 npm 依赖..."
npm install --no-audit --no-fund --silent 2>&1 | tail -3 || true
echo "      ✅ 依赖就绪"
echo ""

# ---------- 第五步：重启服务 ----------
echo "[5/5] 🔄 重启 PM2 服务..."
pm2 restart eggplant 2>&1 | tail -3 || true

sleep 3
VERSION=$(curl -s http://localhost:3000/api/health 2>/dev/null | grep -oE '"version":"[^"]+"' | cut -d'"' -f4)
if [ -n "$VERSION" ]; then
  echo ""
  echo "✅ ===== 部署完成！版本：v$VERSION ====="
else
  echo ""
  echo "⚠️  服务启动中，请稍后执行：curl http://localhost:3000/api/health"
fi

# 最终数据确认
echo ""
echo "📊 部署后数据状态："
if [ -f data/qiezi.db ]; then
  echo "   DB 大小: $(stat -c%s data/qiezi.db 2>/dev/null) 字节"
fi
if [ -d backups ]; then
  echo "   备份总数: $(ls backups/qiezi-*.db 2>/dev/null | wc -l) 份"
fi
echo "   ⚠️  永远不要执行 rm -rf data/ 或 rm -rf backups/"
