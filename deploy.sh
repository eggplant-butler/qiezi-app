#!/bin/bash
# 茄子管家 Phase 2/3/4 部署脚本（不依赖 git clone，使用 wget tarball）
# 在腾讯云服务器上执行：bash deploy.sh

set -e

echo "=========================================="
echo "  茄子管家 Phase 2/3/4 部署脚本"
echo "=========================================="
echo ""

# ---- 配置 ----
INSTALL_DIR="/home/ubuntu/qiezi-app"
PORT=3000
TARBALL_URL="https://ghproxy.com/https://github.com/eggplant-butler/qiezi-app/archive/refs/heads/main.tar.gz"
TARBALL_FALLBACK="https://codeload.github.com/eggplant-butler/qiezi-app/tar.gz/refs/heads/main"

# ---- 1. 检测/安装 Node.js ----
echo "[1/7] 检查 Node.js..."
if ! command -v node &> /dev/null; then
  echo "  安装 Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node.js 版本: $(node -v)"

# ---- 2. 检测/安装 PM2 ----
echo ""
echo "[2/7] 检查 PM2..."
if ! command -v pm2 &> /dev/null; then
  echo "  安装 PM2..."
  sudo npm install -g pm2
fi
echo "  PM2 版本: $(pm2 --version)"

# ---- 3. 下载最新代码（tarball，不依赖 git）----
echo ""
echo "[3/7] 下载最新代码..."
sudo rm -rf /home/ubuntu/qiezi-app-main /home/ubuntu/qiezi-app.tar.gz 2>/dev/null || true

# 备份现有数据（防止覆盖）
if [ -d "$INSTALL_DIR/data" ]; then
  BACKUP_DIR="/tmp/qiezi-data-backup-$(date +%Y%m%d%H%M%S)"
  sudo cp -r "$INSTALL_DIR/data" "$BACKUP_DIR" 2>/dev/null || true
  echo "  已备份现有数据到 $BACKUP_DIR"
fi

# 尝试加速镜像下载，失败则回退官方源
echo "  尝试加速镜像下载..."
if wget --no-check-certificate --timeout=60 -q "$TARBALL_URL" -O /home/ubuntu/qiezi-app.tar.gz; then
  echo "  加速镜像下载成功"
else
  echo "  加速镜像失败，尝试官方源..."
  if wget --no-check-certificate --timeout=60 "$TARBALL_FALLBACK" -O /home/ubuntu/qiezi-app.tar.gz; then
    echo "  官方源下载成功"
  else
    echo "  ❌ 下载失败，请检查服务器网络"
    exit 1
  fi
fi

# ---- 4. 解压并替换 ----
echo ""
echo "[4/7] 解压并替换代码..."
cd /home/ubuntu
tar -xzf qiezi-app.tar.gz
if [ ! -d qiezi-app-main ]; then
  echo "  ❌ 解压失败，未找到 qiezi-app-main 目录"
  exit 1
fi

# 备份的数据目录保留，新代码解压后再恢复（仅当新代码无 data 时）
HAS_NEW_DATA="no"
if [ -d "qiezi-app-main/data" ]; then HAS_NEW_DATA="yes"; fi

sudo rm -rf "$INSTALL_DIR"
sudo mv qiezi-app-main "$INSTALL_DIR"
sudo chown -R ubuntu:ubuntu "$INSTALL_DIR"

# 恢复备份的 data（如果有备份且新代码没有 data）
if [ -n "$BACKUP_DIR" ] && [ "$HAS_NEW_DATA" = "no" ]; then
  sudo cp -r "$BACKUP_DIR" "$INSTALL_DIR/data"
  echo "  已恢复备份数据"
fi

cd "$INSTALL_DIR"
echo "  代码已就绪"

# ---- 5. 安装依赖 ----
echo ""
echo "[5/7] 安装依赖..."
npm install express cors 2>&1 | tail -3
echo "  依赖安装完成"

# ---- 6. 清理旧进程并重启 ----
echo ""
echo "[6/7] 重启服务..."
pm2 delete eggplant 2>/dev/null || true
pm2 delete qiezi 2>/dev/null || true
pm2 delete all 2>/dev/null || true
sudo fuser -k ${PORT}/tcp 2>/dev/null || true
sudo pkill -f "node.*server.js" 2>/dev/null || true
sudo pkill -f "python.*server" 2>/dev/null || true
sleep 2

cd "$INSTALL_DIR"
pm2 start server.js --name eggplant
pm2 save
echo "  服务已启动"

# ---- 7. 验证 ----
echo ""
echo "[7/7] 验证服务..."
sleep 3
HEALTH=$(curl -s http://localhost:${PORT}/api/health)
if echo "$HEALTH" | grep -q "ok"; then
  echo "  ✅ 服务运行正常"
  echo "  $HEALTH"
else
  echo "  ❌ 服务未响应，检查日志:"
  pm2 logs eggplant --lines 30 --nostream
  exit 1
fi

# 验证 Phase 2/3/4 API
echo ""
echo "--- 验证 Phase 2/3/4 API ---"
for ep in "/api/root-cause" "/api/interpersonal" "/api/mindfulness" "/api/energy/audit" "/api/reviews" \
         "/api/beliefs" "/api/character/radar" "/api/self-portrait" "/api/entropy" "/api/antifragile" \
         "/api/north-star" "/api/crisis-plan" "/api/death-test" "/api/narrative" "/api/manifesto"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}${ep}")
  if [ "$code" = "200" ]; then
    echo "  ✅ $ep"
  else
    echo "  ❌ $ep (HTTP $code)"
  fi
done

echo ""
echo "=========================================="
echo "✅ 部署完成！"
echo "=========================================="
echo ""
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "你的服务器IP")
echo "访问地址: http://${PUBLIC_IP}:${PORT}"
echo ""
echo "PM2 管理命令:"
echo "  查看状态: pm2 status"
echo "  查看日志: pm2 logs eggplant"
echo "  重启服务: pm2 restart eggplant"
echo "  停止服务: pm2 stop eggplant"
echo ""
