#!/bin/bash
# 超级彻底修复脚本 - 解决所有自动重启问题
set -e

echo "========================================"
echo "茄子管家 重心版 - 超级修复脚本"
echo "========================================"
echo ""

# ===== 第1步：彻底停止所有自动启动机制 =====
echo "【第1步】查找并停止所有自动启动机制..."

# 1.1 查找systemd服务
echo ">>> 检查systemd服务..."
for SVC in qiezi eggplant node app; do
    if systemctl list-unit-files | grep -q "^${SVC}.service"; then
        echo "发现systemd服务: $SVC"
        systemctl stop $SVC 2>/dev/null || true
        systemctl disable $SVC 2>/dev/null || true
        rm -f /etc/systemd/system/${SVC}.service 2>/dev/null || true
        systemctl daemon-reload
        echo "已停止并禁用: $SVC"
    fi
done

# 1.2 查找PM2进程
echo ">>> 检查PM2..."
if command -v pm2 &>/dev/null; then
    pm2 list 2>/dev/null | grep -v "empty" && {
        pm2 stop all 2>/dev/null || true
        pm2 delete all 2>/dev/null || true
        pm2 save --force 2>/dev/null || true
        pm2 kill 2>/dev/null || true
        rm -rf ~/.pm2 2>/dev/null || true
        echo "PM2已清理"
    }
fi

# 1.3 查找supervisor
echo ">>> 检查supervisor..."
if command -v supervisorctl &>/dev/null; then
    supervisorctl stop all 2>/dev/null || true
    for CONF in /etc/supervisor/conf.d/*.conf; do
        if [ -f "$CONF" ]; then
            rm -f "$CONF"
            echo "已删除supervisor配置: $CONF"
        fi
    done
    supervisorctl reread 2>/dev/null || true
    supervisorctl update 2>/dev/null || true
fi

# 1.4 查找cron任务
echo ">>> 检查cron任务..."
CRON_TEMP=$(mktemp)
crontab -l 2>/dev/null | grep -v -E "(eggplant|qiezi|node)" > "$CRON_TEMP" 2>/dev/null || true
crontab "$CRON_TEMP" 2>/dev/null || true
rm -f "$CRON_TEMP"
echo "cron任务已清理"

# 1.5 查找init.d脚本
echo ">>> 检查init.d脚本..."
for SCRIPT in /etc/init.d/*; do
    if [ -f "$SCRIPT" ]; then
        if grep -l -E "(eggplant|qiezi)" "$SCRIPT" 2>/dev/null; then
            update-rc.d -f "$(basename $SCRIPT)" remove 2>/dev/null || true
            rm -f "$SCRIPT"
            echo "已删除init.d脚本: $SCRIPT"
        fi
    fi
done

echo ""

# ===== 第2步：杀掉所有相关进程 =====
echo "【第2步】杀掉所有相关进程..."

# 2.1 强制杀掉所有node进程
pkill -9 -f "node.*server" 2>/dev/null || true
pkill -9 -f "eggplant" 2>/dev/null || true
pkill -9 -f "qiezi" 2>/dev/null || true
pkill -9 node 2>/dev/null || true

# 2.2 等待进程完全退出
echo "等待进程退出..."
sleep 5

# 2.3 再次确认
REMAINING=$(ps aux | grep -E "node.*(server|eggplant|qiezi)" | grep -v grep | wc -l)
if [ "$REMAINING" -gt 0 ]; then
    echo "警告: 仍有进程运行，强制终止..."
    ps aux | grep -E "node.*(server|eggplant|qiezi)" | grep -v grep | awk '{print $2}' | xargs -I{} kill -9 {} 2>/dev/null || true
    sleep 3
fi

# 2.4 确认端口3000已释放
if lsof -i :3000 2>/dev/null; then
    echo "警告: 端口3000仍被占用，强制释放..."
    lsof -ti :3000 | xargs kill -9 2>/dev/null || true
    sleep 2
fi

echo "进程已清理完毕"
echo ""

# ===== 第3步：准备重心版应用 =====
echo "【第3步】准备重心版应用..."

APP_DIR="/home/ubuntu/qiezi-app"

# 3.1 创建目录
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# 3.2 下载重心版服务端
echo "下载重心版服务端..."
curl -sL -o server.js https://cdn.jsdelivr.net/gh/eggplant-butler/qiezi-app@main/server.js

if [ ! -f "server.js" ] || [ ! -s "server.js" ]; then
    echo "错误: 下载失败"
    exit 1
fi

echo "下载完成: $(wc -l < server.js) 行"

# 3.3 安装依赖
if [ ! -d "node_modules" ] || [ ! -d "node_modules/express" ]; then
    echo "安装依赖..."
    npm init -y 2>/dev/null || true
    npm install --silent express cors
fi

# 3.4 确保数据目录存在
mkdir -p "$APP_DIR/data"

echo ""

# ===== 第4步：启动重心版 =====
echo "【第4步】启动重心版服务..."

cd "$APP_DIR"
nohup node server.js > /tmp/qiezi-center.log 2>&1 &
NODE_PID=$!
sleep 3

# 验证进程是否运行
if ! ps -p $NODE_PID > /dev/null 2>&1; then
    echo "错误: 服务启动失败"
    echo "日志内容:"
    cat /tmp/qiezi-center.log
    exit 1
fi

echo "服务已启动，PID: $NODE_PID"
echo ""

# ===== 第5步：验证 =====
echo "【第5步】验证服务状态..."

# 5.1 检查进程
echo ">>> 进程状态:"
ps aux | grep "node server.js" | grep -v grep

# 5.2 检查端口
echo ""
echo ">>> 端口状态:"
netstat -tlnp 2>/dev/null | grep 3000 || lsof -i :3000

# 5.3 检查API
echo ""
echo ">>> API状态:"
curl -s http://localhost:3000/api/health

# 5.4 检查页面标题
echo ""
echo ">>> 页面标题:"
TITLE=$(curl -s http://localhost:3000/ | grep -o '<title>[^<]*</title>')
echo "$TITLE"

echo ""
echo "========================================"
if echo "$TITLE" | grep -q "重心版"; then
    echo "✅✅✅ 成功！重心版已部署 ✅✅✅"
    echo ""
    echo "访问地址: http://49.235.185.200"
    echo ""
    echo "功能说明:"
    echo "  - 4个重心：工作收入、摄影能力、身体健康、认知思考"
    echo "  - 6个核心模块：财务、睡眠、锻炼、情绪、日记、学习复盘"
else
    echo "⚠️ 服务已启动，但可能不是重心版"
    echo "请检查: cat /tmp/qiezi-center.log"
fi
echo "========================================"