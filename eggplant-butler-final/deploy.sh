#!/bin/bash
# 茄子管家 一键部署脚本
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
  
  echo "配置Nginx反代..."
  sudo tee /etc/nginx/sites-available/eggplant > /dev/null << EOF
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
    }
}
EOF
  sudo ln -sf /etc/nginx/sites-available/eggplant /etc/nginx/sites-enabled/
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl restart nginx
  
  echo "部署完成！访问 http://${SERVER_IP} 即可使用"
ENDSSH

echo "✅ 茄子管家已上线！"
