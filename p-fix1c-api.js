'use strict';
// FIX1c: 新增 wisdom-lens + compounding API端点（在认知仪表盘路由之前）
const fs=require('fs');let s=fs.readFileSync('server.js','utf8');
if(s.includes('/api/eng/wisdom-lens')){console.log('SKIP API已存在');process.exit(0);}
const OLD="// ---------- 7. 认知仪表盘（一次聚合所有深度分析，减少前端请求） ----------";
if(!s.includes(OLD)){console.error('未匹配到认知仪表盘锚点');process.exit(1);}
const NEW=`// ---------- 6.5 五重透镜 + 复利审计 ----------
app.post('/api/eng/wisdom-lens', (req, res) => {
  try {
    const { lens, content, module, recordId } = req.body || {};
    const validLens = ['philosophy','guiguzi','psychology','economics','crisisFramework'];
    if (!lens || !validLens.includes(lens)) return res.status(400).json({ success: false, message: 'lens非法' });
    let item = { data: { content: '' } };
    if (content && typeof content === 'string') { item = { data: { content } }; }
    else if (module && recordId) {
      if (!isModuleAllowed(module)) return res.status(400).json({ success: false, message: 'module非法' });
      const list = readData(module); const found = list.find(x => String(x.id) === String(recordId));
      if (!found) return res.status(404).json({ success: false, message: '记录不存在' }); item = found;
    } else {
      const hist = ENG.buildHistory(); const latest = hist.find(x => ['think','diary','relation','work'].includes(x.mid));
      if (latest) item = latest;
    }
    const hist = ENG.buildHistory();
    const reflection = ENG[lens](item, hist);
    auditLog('wisdom_lens', req.ip, { lens, module: module || null }, true);
    res.json({ success: true, lens, reflection, generatedAt: new Date().toISOString() });
  } catch (e) { console.error('[wisdom-lens]', e.message); res.status(500).json({ success: false, message: '分析失败: ' + e.message }); }
});
app.get('/api/eng/compounding', (req, res) => {
  try { const hist = ENG.buildHistory(); const r = ENG.compounding(hist); res.json({ success: true, reflection: r, sampleSize: hist.length, generatedAt: new Date().toISOString() }); }
  catch (e) { console.error('[compounding]', e.message); res.status(500).json({ success: false, message: '失败: ' + e.message }); }
});

${OLD}`;
s=s.replace(OLD,NEW);fs.writeFileSync('server.js',s);console.log('OK API endpoints added');
