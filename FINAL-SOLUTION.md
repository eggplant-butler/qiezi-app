# 🍆 茄子管家·重心版 - 最终解决方案

## 问题根因
服务器有自动重启机制（systemd服务或PM2），导致旧服务不断重启，无法替换为重心版。

---

## 🎯 开会回来后，只需执行这一条命令：

```bash
curl -sSL https://cdn.jsdelivr.net/gh/eggplant-butler/qiezi-app@main/ultimate-fix.sh | bash
```

---

## 执行步骤（复制粘贴即可）

1. 打开腾讯云控制台
2. 进入轻量应用服务器
3. 点击"登录"（网页终端）
4. 在终端里粘贴上面的命令，按回车执行
5. 等待显示 "✅ 成功！重心版已部署"
6. 手机用无痕模式访问 http://49.235.185.200

---

## 如果上面命令无法执行，请分步执行：

### 第一步：下载脚本
```bash
curl -o /tmp/fix.sh https://cdn.jsdelivr.net/gh/eggplant-butler/qiezi-app@main/ultimate-fix.sh
```

### 第二步：执行脚本
```bash
bash /tmp/fix.sh
```

---

## 预期结果

执行成功后，您将看到：
- ✅ 页面标题变为 "茄子管家·重心版"
- ✅ 暗色主题界面
- ✅ 4个重心卡片：工作收入、摄影能力、身体健康、认知思考
- ✅ 6个核心模块：财务、睡眠、锻炼、情绪、日记、学习复盘

---

## 如果仍有问题

请执行诊断命令：
```bash
systemctl list-units --type=service --state=running | grep -E "(node|qiezi|eggplant)"
```

把结果发给AI继续分析。

---

## 脚本功能说明

此脚本会：
1. 查找并停止所有自动启动机制（systemd、PM2、supervisor、cron）
2. 彻底杀掉所有相关进程
3. 下载重心版服务端
4. 安装必要依赖
5. 启动重心版服务
6. 验证部署结果

---

**当前状态**：服务器运行旧版 v2.0-final
**目标状态**：服务器运行重心版 v3.0-center
**预计执行时间**：30秒

---

**AI助手已准备好，您回来后随时可以开始！**