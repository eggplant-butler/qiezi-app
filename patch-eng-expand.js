/* eslint-disable */
// ============================================================
// 内容扩展1：认知引擎 ENG 扩展（哲学/鬼谷子/心理学/经济学/复利/危机框架）
// 用法：cd /home/ubuntu/qiezi-app && node patch-eng-expand.js && pm2 restart eggplant
// 设计目标：让用户面对任何事件/问题，都能从多维度找到"不受影响且处理得当"的路径
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
if (!fs.existsSync(SERVER)) {
  console.error('❌ 找不到 server.js');
  process.exit(1);
}
let src = fs.readFileSync(SERVER, 'utf8');
const orig = src;
let changes = 0;

// ---------- 1. 在 ENG 对象末尾插入 6 个新方法 ----------
const ANCHOR_ENG = `        activeModulesLastWeek: Object.keys(modCountPrev).length
      }
    };
  }
};`;

const NEW_METHODS = `        activeModulesLastWeek: Object.keys(modCountPrev).length
      }
    };
  },

  // ===== 内容扩展：五重透镜 + 复利审计 + 危机框架 =====
  // 设计目标：对任意一条记录，可从哲学/鬼谷子/心理学/经济学/复利五个维度审视，
  // 加上危机应对框架，让用户在面对任何事件或问题时，都能找到"不受影响且处理得当"的路径。

  // 1. 哲学透镜：斯多葛控制二分 + 存在主义意义 + 东方无常
  philosophy(item, hist) {
    const c = (item?.data?.content || item?.content || item?.data?.note || '').toString();
    const text = c.trim() || '这件事';
    const lines = [];
    lines.push('【斯多葛·控制二分】');
    lines.push('把"' + text.slice(0,30) + (text.length>30?'…':'') + '"拆成两堆：你能控制的，你不能控制的。');
    lines.push('你能控制的——做到最好就够了。');
    lines.push('你不能控制的——盯着它只会消耗你能控制那堆的能量。');
    lines.push('区分这俩，是自由的起点。混在一起，是痛苦的源头。');
    lines.push('');
    lines.push('【存在主义·意义】');
    lines.push('这件事本身没有意义——意义是你赋予的。');
    lines.push('你赋予了它什么意义？这个意义让你更强，还是更弱？');
    lines.push('如果是后者，你可以重新赋予。这不是自欺，是人独有的自由。');
    lines.push('萨特：人被判定为自由——逃不掉"必须选择意义"这件事。');
    lines.push('');
    lines.push('【东方·无常与中道】');
    lines.push('三年后再看这件事，它还在吗？');
    lines.push('不在——它现在对你的折磨，是对"无常"的无视。');
    lines.push('在——那它值得认真对待，而不是焦虑。');
    lines.push('中道不是和稀泥，是不偏不倚地看见它本来的大小。');
    return lines.join('\\n');
  },

  // 2. 鬼谷子透镜：捭阖/反应/内揵/抵巇
  guiguzi(item, hist) {
    const c = (item?.data?.content || item?.content || item?.data?.note || '').toString();
    const lines = [];
    lines.push('【捭阖·开合之机】');
    lines.push('此刻该"开"（主动出击、表态、推进）还是"合"（静默、观察、后发）？');
    lines.push('鬼谷子：开必有所图，合必有所待。无图而开是泄，无待而合是僵。');
    lines.push('你图什么？你在等什么？答不上来，就先"合"。');
    lines.push('');
    lines.push('【反应·先听后说】');
    lines.push('你说了几分？听了几分？');
    lines.push('鬼谷子：言多必有数短之处。先听清对方"没说的"，再决定你"要说的"。');
    lines.push('沉默不是没话，是在攒一发能中的。');
    lines.push('');
    lines.push('【内揵·亲疏远近】');
    lines.push('对方与你是"亲"（可信可托）还是"疏"（需防需借）？');
    lines.push('亲者可托重任，疏者只可借势。亲疏用错，是大多数关系灾难的根源。');
    lines.push('判断亲疏不看远近，看"利益一致时他会不会替你扛"。');
    lines.push('');
    lines.push('【抵巇·见微知著】');
    lines.push('这件事里有没有一道"裂缝"——还没显现，但你隐约感到？');
    lines.push('鬼谷子：巇始起，可抵而塞；及其已深，不可救。');
    lines.push('裂缝还小时花一分力能堵住，等它大了，十分力也未必。');
    lines.push('此刻最该问的不是"怎么办"，而是"裂缝在哪"。');
    return lines.join('\\n');
  },

  // 3. 心理学透镜：认知偏差 + 防御机制 + 归因
  psychology(item, hist) {
    const c = (item?.data?.content || item?.content || item?.data?.note || '').toString();
    const lines = [];
    lines.push('【认知偏差检测】');
    const biases = [];
    if (/总是|从不|永远|每次|绝不|一律/.test(c)) biases.push('非黑即白（全或无思维）');
    if (/应该|必须|一定要|不能不/.test(c)) biases.push('"应该"暴政（绝对化要求）');
    if (/完了|糟透了|毁了|全完了|死定了/.test(c)) biases.push('灾难化（最坏结果预设）');
    if (/大家都|所有人都|没人|谁都/.test(c)) biases.push('过度概括');
    if (/(我.*我.*我)/.test(c.slice(0,80))) biases.push('个人化（外部归因到自己）');
    if (/他一定是|她肯定|就是因为我/.test(c)) biases.push('读心术/妄下定论');
    if (biases.length) {
      lines.push('检测到偏差：' + biases.join('、'));
      lines.push('这些偏差不是事实，是思维的惯性扭曲。');
      lines.push('破解三问：①证据支持吗？②反例存在吗？③朋友会这样想吗？');
    } else {
      lines.push('未检测到典型认知偏差——记录相对客观。');
      lines.push('但警惕：偏差常藏在"我没偏差"的自信里。');
    }
    lines.push('');
    lines.push('【心理防御机制】');
    lines.push('面对这件事，你在用哪种防御？');
    lines.push('• 压抑（装没事）→ 身体先买单');
    lines.push('• 合理化（找借口）→ 问题原地不动');
    lines.push('• 投射（怪别人）→ 关系破裂');
    lines.push('• 转移（迁怒弱者）→ 制造新伤');
    lines.push('• 升华（转化成行动）→ 唯一健康的');
    lines.push('你选的是哪种？能换成升华吗？');
    lines.push('');
    lines.push('【归因检查】');
    lines.push('你把这件事的"原因"放在哪？');
    lines.push('放在自己身上（内控）→ 有动力但易自责');
    lines.push('放在外界身上（外控）→ 少自责但无力');
    lines.push('健康姿势：可控部分归自己，不可控部分归运气，然后只盯可控的。');
    return lines.join('\\n');
  },

  // 4. 经济学透镜：机会成本 + 沉没成本 + 边际 + 激励相容
  economics(item, hist) {
    const c = (item?.data?.content || item?.content || item?.data?.note || '').toString();
    const amt = parseFloat(item?.data?.amount || item?.amount || 0);
    const lines = [];
    lines.push('【机会成本】');
    lines.push('你在这件事上花的时间/钱/心力，如果投到别处，能换回什么？');
    lines.push('那个"别处"的收益，就是这件事的真实成本——不是你付了多少，是你放弃了多少。');
    lines.push('人最常见的错：只算"花了多少"，不算"没赚到多少"。');
    lines.push('');
    lines.push('【沉没成本】');
    lines.push('你已经投入的，已经没了。');
    lines.push('继续还是放弃，只该看"未来"——未来继续投入的回报，是否大于未来继续投入的成本？');
    lines.push('已投入的部分不该进入决策。能真正做到这点的人，少之又少。');
    lines.push('若你犹豫时心想"都投入这么多了"——这就是沉没成本在操控你。');
    lines.push('');
    lines.push('【边际效用】');
    if (amt > 0) {
      lines.push('这笔' + amt + '元，第一份带来的满足感是多少？第十份呢？');
      lines.push('大多数消费的边际效用递减得比你想的快——但你记得的只有第一份的快感。');
    } else {
      lines.push('在这件事上，多投入一单位心力，能多换来多少？');
      lines.push('边际收益递减时，"再努力一点"的回报远低于"换个方向"。');
    }
    lines.push('');
    lines.push('【激励相容】');
    lines.push('这件事里，对方的"激励"是什么？你的"激励"是什么？');
    lines.push('不要看他说了什么，看他被什么驱动。');
    lines.push('激励错位时，再好的关系也会被结构性利益拉歪——不是人坏，是结构使然。');
    return lines.join('\\n');
  },

  // 5. 复利审计：识别正/负复利行为，预测10年分叉
  compounding(hist) {
    if (!hist) hist = this.buildHistory();
    const lines = [];
    const moduleCounts = {};
    hist.forEach(h => { moduleCounts[h.mid] = (moduleCounts[h.mid] || 0) + 1; });
    const positiveCompound = ['learn','exercise','sleep','finance','diary','think','mindfulness','principle','review'];
    const negativeSignals = {};
    try {
      const diet = hist.filter(x => x.mid === 'diet');
      negativeSignals.emotionalEat = diet.filter(x => x.data?.emotional && String(x.data.emotional) !== '否').length;
      const fin = hist.filter(x => x.mid === 'finance');
      negativeSignals.highSpend = fin.filter(x => parseFloat(x.data?.amount||0) >= 500).length;
      const sl = hist.filter(x => x.mid === 'sleep');
      negativeSignals.badSleep = sl.filter(x => parseFloat(x.data?.hours||99) < 6).length;
      const emo = hist.filter(x => x.mid === 'emotion');
      negativeSignals.lowMood = emo.filter(x => parseFloat(x.data?.rating||x.data?.level||5) <= 2).length;
    } catch(e) {}
    lines.push('【正复利·在积累什么】');
    const pos = positiveCompound.filter(m => moduleCounts[m]);
    if (pos.length) {
      lines.push('你在这些维度有记录：' + pos.map(m => m + '(' + moduleCounts[m] + ')').join('、'));
      lines.push('复利的秘密不在"单次多"，在"持续不断"。');
      lines.push('假设每天进步1%，一年后 ×37.78；每天退步1%，一年后 ×0.03。');
      lines.push('10年后，这两条路的差距是约 11900倍。');
    } else {
      lines.push('暂未检测到稳定的正复利行为。');
      lines.push('挑一件最小的事——哪怕每天1分钟——先建立"持续"本身。');
    }
    lines.push('');
    lines.push('【负复利·在透支什么】');
    const negList = [];
    if (negativeSignals.emotionalEat >= 3) negList.push('情绪性进食 ' + negativeSignals.emotionalEat + ' 次');
    if (negativeSignals.highSpend >= 3) negList.push('高额消费 ' + negativeSignals.highSpend + ' 次');
    if (negativeSignals.badSleep >= 3) negList.push('睡眠不足 ' + negativeSignals.badSleep + ' 次');
    if (negativeSignals.lowMood >= 3) negList.push('情绪低位 ' + negativeSignals.lowMood + ' 次');
    if (negList.length) {
      lines.push('检测到负复利信号：' + negList.join('、'));
      lines.push('负复利比正复利更隐蔽——它每次都很小，但它在"复利地"侵蚀你。');
      lines.push('10年后，这些小信号会变成你想不到的大问题。');
    } else {
      lines.push('暂无明显负复利信号。');
    }
    lines.push('');
    lines.push('【分叉点·10年后的两个你】');
    lines.push('如果保持当前路径：10年后的你，是怎样的？');
    lines.push('如果从今天起，正复利 +1、负复利 -1：10年后的你，又是怎样的？');
    lines.push('两个你之间的距离，就是你今天每一个选择的重量。');
    lines.push('爱因斯坦说复利是世界第八大奇迹——它对钱有效，对习惯更有效。');
    return lines.join('\\n');
  },

  // 6. 危机应对框架：当检测到危机信号时的通用应对路径
  crisisFramework(item, hist) {
    const c = (item?.data?.content || item?.content || item?.data?.note || '').toString();
    const lines = [];
    lines.push('【第一步·止血】');
    lines.push('先问：这件事会不会在24小时内变得更糟？');
    lines.push('会——先做那件能"止住恶化"的事，哪怕它不能解决问题。');
    lines.push('不会——你有时间，别用焦虑假装在处理。');
    lines.push('');
    lines.push('【第二步·区分】');
    lines.push('这是"可以解决"的问题，还是"必须承受"的现实？');
    lines.push('可解决的——分解成3个最小动作，今天做1个。');
    lines.push('必须承受的——停止"解决"，转向"共存"。痛苦来自想解决不可解的事。');
    lines.push('区分这俩，比解决本身更重要。');
    lines.push('');
    lines.push('【第三步·借力】');
    lines.push('一个人扛是最差解。');
    lines.push('谁经历过类似的事？谁能给你信息？谁能给你情绪支撑？');
    lines.push('区分三者——找对人，别找错。给信息的人要专业，给支撑的人要安全。');
    lines.push('开口求助不是软弱，是高效。');
    lines.push('');
    lines.push('【第四步·意义】');
    lines.push('危机本身没有意义，但你能从中提取意义。');
    lines.push('5年后回头看，这件事教会了你什么？');
    lines.push('如果你现在能说出那个"教会"——危机就已经在变成资产。');
    lines.push('尼采：知道为什么而活的人，能承受任何一种生活。');
    lines.push('');
    lines.push('【第五步·底线】');
    lines.push('最坏情况是什么？你承受得了吗？');
    lines.push('绝大多数恐惧，在"最坏情况被具体化"之后会缩水。');
    lines.push('模糊的恐惧比具体的灾难更可怕——把它写下来，它就变小了。');
    lines.push('记住：你比自己想象的更能扛。这是被反复验证过的事实。');
    return lines.join('\\n');
  },
};`;

if (src.indexOf(ANCHOR_ENG) === -1) {
  console.error('❌ 未匹配到 ENG 末尾锚点（activeModulesLastWeek）');
  process.exit(1);
}
src = src.replace(ANCHOR_ENG, NEW_METHODS);
changes++;
console.log('✅ ENG 已新增 6 个透镜方法（哲学/鬼谷子/心理学/经济学/复利/危机框架）');

// ---------- 2. 在 Phase 5 API 区插入 3 个新端点 ----------
const ANCHOR_API = `// ---------- 7. 认知仪表盘（一次聚合所有深度分析，减少前端请求） ----------`;

const NEW_API = `// ---------- 6.5 五重透镜（哲学/鬼谷子/心理学/经济学）+ 危机框架 ----------
// 对任意一条记录，从多个深度视角审视；content 可直接传入，或用 recordId+module 取已存记录
app.post('/api/eng/wisdom-lens', (req, res) => {
  try {
    const { lens, content, module, recordId } = req.body || {};
    const validLens = ['philosophy','guiguzi','psychology','economics','crisisFramework'];
    if (!lens || !validLens.includes(lens)) {
      return res.status(400).json({ success: false, message: 'lens 非法，可选: ' + validLens.join(', ') });
    }
    let item = { data: { content: '' } };
    if (content && typeof content === 'string') {
      item = { data: { content } };
    } else if (module && recordId) {
      if (!isModuleAllowed(module)) return res.status(400).json({ success: false, message: 'module 非法' });
      const list = readData(module);
      const found = list.find(x => String(x.id) === String(recordId));
      if (!found) return res.status(404).json({ success: false, message: '记录不存在' });
      item = found;
    } else {
      // 兜底：取最近一条 think/diary 记录作为分析对象
      const hist = ENG.buildHistory();
      const latest = hist.find(x => ['think','diary','relation','work'].includes(x.mid));
      if (latest) item = latest; else item = { data: { content: '当前生活' } };
    }
    const hist = ENG.buildHistory();
    const reflection = ENG[lens](item, hist);
    auditLog('wisdom_lens', req.ip, { lens, module: module || null, hasContent: !!(content || item?.data?.content) }, true);
    res.json({ success: true, lens, reflection, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[wisdom-lens]', e.message);
    res.status(500).json({ success: false, message: '分析失败: ' + e.message });
  }
});

// 复利审计：基于全局历史，无需输入
app.get('/api/eng/compounding', (req, res) => {
  try {
    const hist = ENG.buildHistory();
    const result = ENG.compounding(hist);
    res.json({ success: true, reflection: result, sampleSize: hist.length, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[compounding]', e.message);
    res.status(500).json({ success: false, message: '复利审计失败: ' + e.message });
  }
});

`;

if (src.indexOf(ANCHOR_API) === -1) {
  console.error('❌ 未匹配到 API 插入锚点（认知仪表盘注释）');
  process.exit(1);
}
src = src.replace(ANCHOR_API, NEW_API + ANCHOR_API);
changes++;
console.log('✅ 已新增 /api/eng/wisdom-lens + /api/eng/compounding 端点');

// ---------- 3. 把 compounding 加入 dashboard 聚合 ----------
const ANCHOR_DASH = `    try { result.sections.dataCompare = ENG.dataCompare(hist); } catch (e) { result.sections.dataCompare = null; }
  } catch (e) {
    console.error('[eng/dashboard]', e.message);`;
const NEW_DASH = `    try { result.sections.dataCompare = ENG.dataCompare(hist); } catch (e) { result.sections.dataCompare = null; }
    // 内容扩展：复利审计加入仪表盘（无输入，纯历史分析）
    try { result.sections.compounding = ENG.compounding(hist); } catch (e) { result.sections.compounding = null; }
  } catch (e) {
    console.error('[eng/dashboard]', e.message);`;

if (src.indexOf(ANCHOR_DASH) === -1) {
  console.warn('⚠️  未匹配到 dashboard 聚合锚点（dataCompare），跳过 dashboard 集成');
} else {
  src = src.replace(ANCHOR_DASH, NEW_DASH);
  changes++;
  console.log('✅ compounding 已加入 dashboard 聚合');
}

// ---------- 4. 写回 ----------
if (changes === 0) {
  console.log('ℹ️  无变更（可能已打过补丁）');
  process.exit(0);
}
fs.writeFileSync(SERVER, src);
console.log('✅ server.js 已更新（共 ' + changes + ' 处变更）');
