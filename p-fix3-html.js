'use strict';
// FIX3: index.html 智慧透镜入口（在船长Tab注释之前插入）
const fs=require('fs');let s=fs.readFileSync('frontend/index.html','utf8');
if(s.includes('openWisdomLens()')){console.log('SKIP HTML入口已存在');process.exit(0);}
const OLD='<!-- ====== 船长Tab: 船长工具 ====== -->';
if(!s.includes(OLD)){console.error('未匹配到船长Tab锚点');process.exit(1);}
const NEW=`<div class="tool-section">
<div class="ts-title">🧭 智慧透镜 <span class="ts-sub">哲学·鬼谷子·心理·经济·复利·危机</span></div>
<div class="tool-grid">
<div class="tool-item primary" onclick="openWisdomLens()"><div class="t-ic">🔮</div><div class="t-nm">五重透镜</div><div class="t-cnt">新</div></div>
<div class="tool-item primary" onclick="openCompoundingAudit()"><div class="t-ic">📈</div><div class="t-nm">复利审计</div><div class="t-cnt">新</div></div>
<div class="tool-item" onclick="openCrisisFramework()"><div class="t-ic">🛟</div><div class="t-nm">危机框架</div><div class="t-cnt">新</div></div>
</div>
</div>

${OLD}`;
s=s.replace(OLD,NEW);fs.writeFileSync('frontend/index.html',s);console.log('OK HTML入口已注入');
