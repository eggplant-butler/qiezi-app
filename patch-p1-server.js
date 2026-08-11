const fs = require('fs');
let changed = 0, skipped = 0;
const file = 'server.js';
if (!fs.existsSync(file)) { console.log('NO FILE'); process.exit(1); }
let c = fs.readFileSync(file, 'utf8');

// ========== P1-6: genId 碰撞修复 ==========
{
  const OLD = "function genId() {\n  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);\n}";
  const NEW = "function genId() {\n  return Date.now().toString(36) + crypto.randomBytes(8).toString('hex');\n}";
  if (c.includes("crypto.randomBytes(8).toString('hex')")) { console.log('SKIP(already): P1-6 genId'); skipped++; }
  else if (c.includes(OLD)) { c = c.replace(OLD, NEW); console.log('OK P1-6: genId -> crypto.randomBytes'); changed++; }
  else { console.log('SKIP P1-6: anchor mismatch'); skipped++; }
}

// ========== P1-7: VALID_MODULES 补 snake_case ==========
{
  const OLD = "'life_milestone','habits','quickNote','dailyQuestion','principles','decisions','fiveWhy',\n  'interview','skill','work_mode','reading','bills','contacts','housework','mindfulness',\n  'belief','character','selfImage','entropy','fragility','northstar','crisis','dyingTest',\n  'annualNarrative','captainManifest','energy','reflection','rootCause','gameTheory',\n  'discipline','review','habit_checkin','plan','growth_stage','journey','wisdom','reminder'";
  const NEW = "'life_milestone','habits','quickNote','quick_notes','dailyQuestion','daily_questions','principles','decisions','fiveWhy','five_whys',\n  'interview','skill','work_mode','reading','bills','contacts','housework','mindfulness',\n  'belief','beliefs','character','selfImage','self_portrait','entropy','entropy_logs','fragility','antifragile_logs','northstar','north_star','crisis','crisis_plan','dyingTest','death_test',\n  'annualNarrative','narrative','captainManifest','manifesto','energy','reflection','rootCause','root_cause','gameTheory',\n  'discipline','review','reviews','habit_checkin','plan','growth_stage','journey','wisdom','reminder',\n  'interpersonal','values','antifragile','second_order','meta_questions'";
  if (c.includes("'quick_notes','dailyQuestion'")) { console.log('SKIP(already): P1-7 VALID_MODULES'); skipped++; }
  else if (c.includes(OLD)) { c = c.replace(OLD, NEW); console.log('OK P1-7: VALID_MODULES add snake_case'); changed++; }
  else { console.log('SKIP P1-7: anchor mismatch'); skipped++; }
}

// ========== P1-10: buildHistory 接受预读参数 ==========
{
  const OLD = "  buildHistory() {\n    // 合并后：learn 数据会镜像到 growth；body/medical 会镜像到 health\n    // 保留旧 mid 兜底，但用 id 去重避免同一条记录被统计两次\n    const mods =";
  const NEW = "  buildHistory(prefetched) {\n    // 合并后：learn 数据会镜像到 growth；body/medical 会镜像到 health\n    // 保留旧 mid 兜底，但用 id 去重避免同一条记录被统计两次\n    const mods =";
  if (c.includes('buildHistory(prefetched)')) { console.log('SKIP(already): P1-10a buildHistory sig'); skipped++; }
  else if (c.includes(OLD)) { c = c.replace(OLD, NEW); console.log('OK P1-10a: buildHistory sig + prefetched'); changed++; }
  else { console.log('SKIP P1-10a: anchor mismatch'); skipped++; }
}
{
  const OLD = "    mods.forEach(m => {\n      const records = readData(m);";
  const NEW = "    mods.forEach(m => {\n      const records = prefetched ? (prefetched[m] || readData(m)) : readData(m);";
  if (c.includes('prefetched ? (prefetched[m]')) { console.log('SKIP(already): P1-10b buildHistory body'); skipped++; }
  else if (c.includes(OLD)) { c = c.replace(OLD, NEW); console.log('OK P1-10b: buildHistory reuse prefetched'); changed++; }
  else { console.log('SKIP P1-10b: anchor mismatch'); skipped++; }
}
{
  const OLD = "    const hist = ENG.buildHistory();\n    const engCorr = ENG.correlate(hist);\n    const engRisks = ENG.risks(hist);";
  const NEW = "    const hist = ENG.buildHistory(all);\n    const engCorr = ENG.correlate(hist);\n    const engRisks = ENG.risks(hist);";
  if (c.includes('ENG.buildHistory(all)')) { console.log('SKIP(already): P1-10c insights'); skipped++; }
  else if (c.includes(OLD)) { c = c.replace(OLD, NEW); console.log('OK P1-10c: /api/insights reuse all'); changed++; }
  else { console.log('SKIP P1-10c: anchor mismatch'); skipped++; }
}
{
  const OLD = "      const hist = ENG.buildHistory();\n      const engCorr = ENG.correlate(hist);";
  const NEW = "      const hist = ENG.buildHistory(all);\n      const engCorr = ENG.correlate(hist);";
  if (c.includes(OLD)) { c = c.replace(OLD, NEW); console.log('OK P1-10d: insights-plus 1st buildHistory'); changed++; }
  else { console.log('SKIP P1-10d: anchor mismatch'); skipped++; }
}
{
  const OLD = "      const hist = ENG.buildHistory();\n      dashboard = { sections: {";
  const NEW = "      const hist = ENG.buildHistory(all);\n      dashboard = { sections: {";
  if (c.includes(OLD)) { c = c.replace(OLD, NEW); console.log('OK P1-10e: insights-plus 2nd buildHistory'); changed++; }
  else { console.log('SKIP P1-10e: anchor mismatch'); skipped++; }
}

// ========== P1-11: 静态资源缓存策略 ==========
{
  const OLD = "app.use(express.static('frontend', {\n    etag: false,\n    lastModified: false,\n    maxAge: 0,\n    setHeaders: (res, filePath) => {\n      // v6.9.20: 全部 no-store，强制浏览器每次都重新请求，消除任何缓存残留\n      // 包括 .html/.js/.css/.svg，手机端任何缓存都会导致致命问题\n      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');\n      res.setHeader('Pragma', 'no-cache');\n      res.setHeader('Expires', '0');\n      res.setHeader('Strict-Transport-Security', 'max-age=0; includeSubDomains; preload');\n    }\n  }));";
  const NEW = "app.use(express.static('frontend', {\n    etag: true,\n    lastModified: true,\n    maxAge: 0,\n    setHeaders: (res, filePath) => {\n      if (filePath.endsWith('index.html')) {\n        res.setHeader('Cache-Control', 'no-cache, must-revalidate');\n      } else {\n        res.setHeader('Cache-Control', 'public, max-age=300');\n      }\n    }\n  }));";
  if (c.includes("'public, max-age=300'")) { console.log('SKIP(already): P1-11 static cache'); skipped++; }
  else if (c.includes(OLD)) { c = c.replace(OLD, NEW); console.log('OK P1-11: static cache index.html=no-cache, others=max-age=300'); changed++; }
  else { console.log('SKIP P1-11: anchor mismatch'); skipped++; }
}

// ========== 写回 ==========
fs.writeFileSync(file, c, 'utf8');
console.log('\n==== server.js summary ====');
console.log('changed: ' + changed + ', skipped: ' + skipped);
console.log('verify: node -c server.js && echo OK');
