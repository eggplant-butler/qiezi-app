#!/bin/bash
# 彻底清理并部署重心版
echo "========================================"
echo "茄子管家 重心版 - 彻底修复脚本"
echo "========================================"

# 1. 杀掉所有相关进程
echo "[1/8] 停止所有Node进程..."
pkill -9 -f "node.*server" 2>/dev/null || true
pkill -9 -f "eggplant" 2>/dev/null || true
pkill -9 -f "qiezi" 2>/dev/null || true
sleep 2

# 2. 停止systemd服务
echo "[2/8] 停止系统服务..."
systemctl stop qiezi 2>/dev/null || true
systemctl stop eggplant 2>/dev/null || true
systemctl disable qiezi 2>/dev/null || true
systemctl disable eggplant 2>/dev/null || true

# 3. 清理PM2
echo "[3/8] 清理PM2进程..."
pm2 stop all 2>/dev/null || true
pm2 delete all 2>/dev/null || true
pm2 save --force 2>/dev/null || true

# 4. 再次确认进程已清理
echo "[4/8] 确认进程清理..."
pkill -9 node 2>/dev/null || true
sleep 2
REMAINING=$(ps aux | grep -E "(node|eggplant|qiezi)" | grep -v grep | wc -l)
if [ "$REMAINING" -gt 0 ]; then
    echo "警告: 仍有 $REMAINING 个进程运行"
    ps aux | grep -E "(node|eggplant|qiezi)" | grep -v grep
    # 强制杀掉
    ps aux | grep -E "(node|eggplant|qiezi)" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null || true
    sleep 2
fi

# 5. 进入应用目录
echo "[5/8] 进入应用目录..."
cd /home/ubuntu/qiezi-app || {
    echo "错误: 目录不存在"
    exit 1
}

# 6. 下载重心版服务端
echo "[6/8] 下载重心版服务端..."
curl -s -o server.js https://cdn.jsdelivr.net/gh/eggplant-butler/qiezi-app@main/server.js
if [ ! -f server.js ]; then
    echo "错误: 下载失败"
    exit 1
fi
echo "下载完成: $(ls -lh server.js | awk '{print $5}')"

# 7. 确保依赖已安装
echo "[7/8] 安装依赖..."
if [ ! -d "node_modules" ]; then
    npm init -y
    npm install express cors
fi

# 8. 启动服务
echo "[8/8] 启动重心版服务..."
nohup node server.js > /tmp/qiezi-center.log 2>&1 &
sleep 3

# 验证
echo ""
echo "========================================"
echo "验证服务状态..."
echo "========================================"

# 检查进程
PROCESS=$(ps aux | grep "node server.js" | grep -v grep | head -1)
if [ -z "$PROCESS" ]; then
    echo "错误: 服务未启动"
    cat /tmp/qiezi-center.log
    exit 1
fi
echo "进程: $PROCESS"

# 检查端口
PORT=$(netstat -tlnp 2>/dev/null | grep 3000)
if [ -z "$PORT" ]; then
    echo "错误: 端口3000未监听"
    exit 1
fi
echo "端口: $PORT"

# 检查页面标题
TITLE=$(curl -s http://localhost:3000/ | grep -o '<title>[^<]*</title>' | head -1)
echo "页面: $TITLE"

echo ""
echo "========================================"
if echo "$TITLE" | grep -q "重心版"; then
    echo "✅ 成功！重心版已部署"
else
    echo "⚠️ 服务已启动，但可能不是重心版"
    echo "请检查日志: cat /tmp/qiezi-center.log"
fi
echo "========================================"
echo ""
echo "访问地址: http://49.235.185.200"
echo ""