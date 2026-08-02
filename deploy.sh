#!/bin/bash
# 茄子管家 部署脚本（jsDelivr CDN 版，国内最稳）
# 用法：bash deploy.sh
set -e

echo "=========================================="
echo "  茄子管家 部署脚本 (jsDelivr CDN)"
echo "=========================================="

INSTALL_DIR="/home/ubuntu/qiezi-app"
PORT=3000
BASE="https://cdn.jsdelivr.net/gh/eggplant-butler/qiezi-app@main"

# ---- 1. Node.js ----
echo "[1/6] 检查 Node.js..."
if ! command -v node &> /dev/null; then
  echo "  安装 Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node: $(node -v)"

# ---- 2. PM2 ----
echo "[2/6] 检查 PM2..."
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
fi
echo "  PM2: $(pm2 --version)"

# ---- 3. 下载代码（jsDelivr CDN 逐文件，国内最稳）----
echo "[3/6] 下载代码..."
# 备份现有数据
if [ -d "$INSTALL_DIR/data" ]; then
  sudo cp -r "$INSTALL_DIR/data" "/tmp/qiezi-backup-$(date +%s)" 2>/dev/null || true
fi
sudo rm -rf "$INSTALL_DIR"
sudo mkdir -p "$INSTALL_DIR/frontend" "$INSTALL_DIR/data"
sudo chown -R ubuntu:ubuntu "$INSTALL_DIR"

# 下载 server.js
if curl -fsSL "$BASE/server.js" -o "$INSTALL_DIR/server.js"; then
  echo "  server.js  OK"
else
  echo "  server.js 下载失败"
  exit 1
fi

# 下载前端
if curl -fsSL "$BASE/frontend/index.html" -o "$INSTALL_DIR/frontend/index.html"; then
  echo "  index.html OK"
else
  echo "  index.html 下载失败"
  exit 1
fi

# package.json（失败就用默认）
curl -fsSL "$BASE/package.json" -o "$INSTALL_DIR/package.json" 2>/dev/null || \
  echo '{"name":"qiezi","version":"5.1","main":"server.js","dependencies":{"express":"latest","cors":"latest"}}' > "$INSTALL_DIR/package.json"
echo "  package.json OK"

# ---- 4. 安装依赖 ----
echo "[4/6] 安装依赖..."
cd "$INSTALL_DIR"
npm install express cors 2>&1 | tail -2

# ---- 5. 清理旧进程并启动 ----
echo "[5/6] 启动服务..."
pm2 delete eggplant 2>/dev/null || true
pm2 delete all 2>/dev/null || true
sudo fuser -k ${PORT}/tcp 2>/dev/null || true
sleep 2

cd "$INSTALL_DIR"
pm2 start server.js --name eggplant
pm2 save

# ---- 6. 验证 ----
echo "[6/6] 验证..."
sleep 3
HEALTH=$(curl -s http://localhost:${PORT}/api/health)
if echo "$HEALTH" | grep -q "ok"; then
  echo "  ✅ 服务正常: $HEALTH"
else
  echo "  ❌ 服务未响应"
  pm2 logs eggplant --lines 30 --nostream
  exit 1
fi

echo ""
echo "--- 验证 Phase 2/3/4 API ---"
for ep in /api/root-cause /api/interpersonal /api/mindfulness /api/energy/audit /api/reviews /api/beliefs /api/character/radar /api/self-portrait /api/entropy /api/antifragile /api/north-star /api/crisis-plan /api/death-test /api/narrative /api/manifesto; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}${ep}")
  [ "$code" = "200" ] && echo "  ✅ $ep" || echo "  ❌ $ep ($code)"
done

echo ""
echo "=========================================="
echo "✅ 部署完成"
echo "访问: http://$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo 服务器IP):${PORT}"
echo "=========================================="
