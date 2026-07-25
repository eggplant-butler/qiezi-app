#!/bin/bash
set -e
read -p "请输入你的服务器公网IP: " SERVER_IP
read -p "请输入SSH用户名 (默认ubuntu): " SSH_USER
SSH_USER=${SSH_USER:-ubuntu}

echo "打包上传中..."
tar -czf eggplant.tar.gz backend frontend data
scp eggplant.tar.gz ${SSH_USER}@${SERVER_IP}:/home/ubuntu/
ssh ${SSH_USER}@${SERVER_IP} << 'ENDSSH'
  cd /home/ubuntu
  rm -rf eggplant-butler-final
  mkdir -p eggplant-butler-final
  tar -xzf eggplant.tar.gz -C eggplant-butler-final
  cd eggplant-butler-final/backend
  npm init -y
  npm install express cors
  pkill -f "node server" || true
  nohup node server.js > app.log 2>&1 &
  echo "部署完成！服务已启动"
ENDSSH
echo "✅ 茄子管家已上线！访问 http://${SERVER_IP}:3000 即可使用"
