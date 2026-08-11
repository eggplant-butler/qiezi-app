'use strict';
// FIX7: CORS 改为"不在白名单时不返回 CORS 头但放行请求"（避免触发 UNCAUGHT）
const fs=require('fs');let s=fs.readFileSync('server.js','utf8');
const OLD=`    // v6.9.22 P0-5: 修复 CORS 白名单失效——白名单外的浏览器请求一律拒绝
    // origin 缺失（非浏览器请求如 curl/nginx 健康检查）仍放行
    cb(new Error('CORS: origin not allowed'));`;
const NEW=`    // v6.9.22 P0-5: 白名单外的浏览器请求不返回 CORS 头（浏览器会拦截跨域读取）
    // 但不抛错，避免污染日志/触发 UNCAUGHT。同源请求不受影响。
    cb(null, false);`;
if(!s.includes(OLD)){console.error('未匹配到 CORS 拒绝行');process.exit(1);}
s=s.replace(OLD,NEW);fs.writeFileSync('server.js',s);console.log('OK CORS 已改为静默拒绝');
