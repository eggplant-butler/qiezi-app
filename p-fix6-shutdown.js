'use strict';
// FIX6: 删除重复的 let isShuttingDown 声明（保留前置的 var）
const fs=require('fs');let s=fs.readFileSync('server.js','utf8');
const OLD='  let isShuttingDown = false;\n    // gracefulShutdown 已在上方定义（P0-1 修复）';
const NEW='  // gracefulShutdown 已在上方定义（P0-1 修复）；isShuttingDown 已在前置 var 声明，勿重复';
if(!s.includes(OLD)){console.error('未匹配到 isShuttingDown 重复声明');process.exit(1);}
s=s.replace(OLD,NEW);fs.writeFileSync('server.js',s);console.log('OK isShuttingDown 重复声明已删除');
