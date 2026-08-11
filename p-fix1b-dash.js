'use strict';
// FIX1b: compounding并入dashboard（在sections.antifragile块之前）
const fs=require('fs');let s=fs.readFileSync('server.js','utf8');
const O1="    // 反脆弱\n    try {\n      const _afLogs = readData('antifragile_logs');";
const O2="\n      const _latestAf = _afLogs.length ? _afLogs.sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1))[0] : null;\n      result.sections.antifragile = _latestAf ? ENG.antifragile(_latestAf) : null;\n    } catch (e) { result.sections.antifragile = null; }";
const OLD=O1+O2;
if(!s.includes(OLD)){console.error('未匹配到反脆弱锚点');process.exit(1);}
if(s.includes('sections.compounding')){console.log('SKIP compounding已在dashboard');process.exit(0);}
const N1="    // 复利审计\n    try { result.sections.compounding = ENG.compounding(hist); } catch (e) { result.sections.compounding = null; }\n    // 反脆弱\n    try {\n      const _afLogs = readData('antifragile_logs');";
s=s.replace(OLD,N1+O2);fs.writeFileSync('server.js',s);console.log('OK compounding in dashboard');
