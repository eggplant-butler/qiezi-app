# 重心版最终部署指南

## 重要发现
服务器有自动重启机制（systemd或PM2），导致旧服务不断重启。

## 解决方案：执行以下命令序列

### 步骤1：查找并停止所有自动启动服务
```bash
systemctl list-units --type=service | grep -E "(qiezi|eggplant|node)"
```

### 步骤2：查看cron任务
```bash
crontab -l && ls -la /etc/cron.d/
```

### 步骤3：查看所有node进程的完整路径
```bash
ps auxf | grep node
```

### 步骤4：查找PM2配置
```bash
pm2 list 2>/dev/null && ls -la ~/.pm2/ 2>/dev/null
```

### 步骤5：查找systemd服务文件
```bash
ls -la /etc/systemd/system/ | grep -E "(qiezi|eggplant)"
systemctl cat qiezi 2>/dev/null || systemctl cat eggplant 2>/dev/null
```

## 执行以上命令后，把结果发给AI分析

---

## 快速修复版（推荐）

直接执行这个完整脚本：

```bash
cat > /tmp/fix-all.sh << 'SCRIPT_EOF'
#!/bin/bash
echo "=== 1. 查找所有自动启动机制 ==="
systemctl list-units --type=service --state=running | grep -E "(qiezi|eggplant|node)" || echo "无systemd服务"
pm2 list 2>/dev/null || echo "无PM2"
crontab -l 2>/dev/null || echo "无cron任务"

echo ""
echo "=== 2. 停止并禁用systemd服务 ==="
for svc in qiezi eggplant; do
    if systemctl is-active --quiet $svc 2>/dev/null; then
        echo "停止服务: $svc"
        systemctl stop $svc
        systemctl disable $svc
    fi
done

echo ""
echo "=== 3. 清理PM2 ==="
pm2 stop all 2>/dev/null || true
pm2 delete all 2>/dev/null || true
pm2 save --force 2>/dev/null || true
pm2 kill 2>/dev/null || true

echo ""
echo "=== 4. 杀掉所有node进程 ==="
pkill -9 -f "node.*server" 2>/dev/null || true
pkill -9 -f "eggplant" 2>/dev/null || true
pkill -9 -f "qiezi" 2>/dev/null || true
pkill -9 node 2>/dev/null || true
sleep 3

echo ""
echo "=== 5. 确认进程已清理 ==="
REMAIN=$(ps aux | grep node | grep -v grep | wc -l)
echo "剩余node进程: $REMAIN"
if [ "$REMAIN" -gt 0 ]; then
    ps aux | grep node | grep -v grep
fi

echo ""
echo "=== 6. 进入目录并下载重心版 ==="
cd /home/ubuntu/qiezi-app
curl -s -o server.js https://cdn.jsdelivr.net/gh/eggplant-butler/qiezi-app@main/server.js
echo "下载完成: $(wc -l server.js)"

echo ""
echo "=== 7. 启动重心版 ==="
nohup node server.js > /tmp/qiezi-new.log 2>&1 &
sleep 3

echo ""
echo "=== 8. 验证 ==="
ps aux | grep "node server.js" | grep -v grep
curl -s http://localhost:3000/ | grep title

echo ""
echo "=== 完成 ==="
SCRIPT_EOF
chmod +x /tmp/fix-all.sh && bash /tmp/fix-all.sh
```