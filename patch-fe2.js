const fs = require('fs');
let changed = 0, skipped = 0;
function patch(file, oldStr, newStr, label, checkStr) {
  if (!fs.existsSync(file)) { console.log('  SKIP(no file):', file); skipped++; return; }
  let c = fs.readFileSync(file, 'utf8');
  var marker = checkStr || newStr.substring(newStr.length - 30);
  if (c.includes(marker)) { console.log('  SKIP(already):', label); skipped++; return; }
  if (!c.includes(oldStr)) { console.log('  SKIP(no anchor):', label); skipped++; return; }
  c = c.replace(oldStr, newStr);
  fs.writeFileSync(file, c, 'utf8');
  console.log('  OK:', label);
  changed++;
}
function patchAll(file, oldStr, newStr, label) {
  if (!fs.existsSync(file)) { console.log('  SKIP(no file):', file); skipped++; return; }
  let c = fs.readFileSync(file, 'utf8');
  if (!c.includes(oldStr)) { console.log('  SKIP(no anchor):', label); skipped++; return; }
  if (oldStr !== newStr && c.includes(newStr)) { console.log('  SKIP(already):', label); skipped++; return; }
  c = c.split(oldStr).join(newStr);
  fs.writeFileSync(file, c, 'utf8');
  console.log('  OK:', label);
  changed++;
}

// === 1. 今日之问标题：合并闪念 (use simple anchor) ===
patch('frontend/index.html',
  '\u4eca\u65e5\u4e4b\u95ee</span>',
  '\u4eca\u65e5\u4e4b\u95ee \u00b7 \u95ea\u5ff5</span>',
  'title: \u4eca\u65e5\u4e4b\u95ee \u00b7 \u95ea\u5ff5', '\u4eca\u65e5\u4e4b\u95ee \u00b7 \u95ea\u5ff5</span>');

// === 2. 今日之问文本：清空"加载中..." ===
patch('frontend/index.html',
  '<div id="dailyQuestionText" style="font-size:15px;color:var(--c-fg);font-weight:500;margin-bottom:8px;">\u52a0\u8f7d\u4e2d...</div>',
  '<div id="dailyQuestionText" style="font-size:15px;color:var(--c-fg);font-weight:500;margin-bottom:8px;"></div>',
  'dailyQuestionText: clear loading', '8px;"></div>\n  <div style');

// === 3. 输入框 placeholder 合并 ===
patch('frontend/index.html',
  '<input type="text" id="dailyQuestionInput" placeholder="\u5199\u4e0b\u4f60\u7684\u56de\u7b54..."',
  '<input type="text" id="dailyQuestionInput" placeholder="\u5199\u4e0b\u4f60\u7684\u60f3\u6cd5\u2014\u2014\u56de\u7b54\u4eca\u65e5\u4e4b\u95ee\uff0c\u6216\u968f\u4fbf\u8bb0\u4e00\u7b14..."',
  'placeholder: merge', '\u6216\u968f\u4fbf\u8bb0\u4e00\u7b14');

// === 4. 按钮文字：回答→记录 ===
patch('frontend/index.html',
  'cursor:pointer;\">\u56de\u7b54</button>',
  'cursor:pointer;\">\u8bb0\u5f55</button>',
  'button: \u56de\u7b54\u2192\u8bb0\u5f55');

// === 5. 删除独立闪念区域 (MUST run before #6 to avoid checkStr conflict) ===
(function() {
  if (!fs.existsSync('frontend/index.html')) { skipped++; return; }
  let c = fs.readFileSync('frontend/index.html', 'utf8');
  var flashStart = c.indexOf('<!-- Section: \u95ea\u5ff5 -->');
  if (flashStart === -1) { console.log('  SKIP(no flash section): remove flash'); skipped++; return; }
  var homeEnd = c.indexOf('</div><!-- end homeContent -->', flashStart);
  if (homeEnd === -1) { console.log('  SKIP(no homeContent end): remove flash'); skipped++; return; }
  c = c.substring(0, flashStart) + c.substring(homeEnd);
  fs.writeFileSync('frontend/index.html', c, 'utf8');
  console.log('  OK: remove standalone flash section');
  changed++;
})();

// === 6. 添加 quickNoteFeedback div (after flash section removed) ===
patch('frontend/index.html',
  '<div id="dailyAnswerDisplay" style="margin-top:8px;font-size:13px;color:var(--c-fg-2);display:none;"></div>\n</div>\n\n<!-- Section: \u6982\u89c8 -->',
  '<div id="dailyAnswerDisplay" style="margin-top:8px;font-size:13px;color:var(--c-fg-2);display:none;"></div>\n  <div id="quickNoteFeedback" style="margin-top:6px;font-size:12px;color:var(--c-fg-2);"></div>\n</div>\n\n<!-- Section: \u6982\u89c8 -->',
  'add quickNoteFeedback div', 'id="quickNoteFeedback"');

// === 7. 船长宣言 → 人生宪法 ===
patchAll('frontend/index.html', '\u8239\u957f\u5ba3\u8a00', '\u4eba\u751f\u5baa\u6cd5', 'manifesto label');

console.log('\n=== index.html patch done: ' + changed + ' changed, ' + skipped + ' skipped ===');
