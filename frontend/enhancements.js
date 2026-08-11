// enhancements.js — 体验增强三件套（独立文件，不碰 app.js）
// 功能：1.快捷输入模板 2.今日情景触发 3.记录间引用
// 依赖 app.js 全局: openModal, openModal2, openAdd, saveRecord, escapeHtml, showToast,
//                  dataCache, curScene, TODAY, genId, apiSave, authHeaders, openScene
// 加载顺序: 必须在 app.js 之后加载

// ============================================================
// 一、快捷输入模板
// ============================================================
var QUICK_TEMPLATES = {
  diet: [
    { label: '🍳 早餐', fields: { meal: '早餐', food: '', amount: '', calories: '' } },
    { label: '🍱 午餐', fields: { meal: '午餐', food: '', amount: '', calories: '' } },
    { label: '🍲 晚餐', fields: { meal: '晚餐', food: '', amount: '', calories: '' } },
    { label: '🍎 加餐', fields: { meal: '加餐', food: '', amount: '', calories: '' } }
  ],
  exercise: [
    { label: '🏃 跑步', fields: { type: '跑步', duration: '30', intensity: '中等' } },
    { label: '💪 力量', fields: { type: '力量训练', duration: '45', intensity: '中等' } },
    { label: '🧘 瑜伽', fields: { type: '瑜伽', duration: '30', intensity: '低' } },
    { label: '🚶 散步', fields: { type: '散步', duration: '20', intensity: '低' } }
  ],
  sleep: [
    { label: '😴 早睡', fields: { bedtime: '23:00', wakeTime: '07:00', quality: '好' } },
    { label: '🌙 熬夜', fields: { bedtime: '01:30', wakeTime: '08:00', quality: '差' } },
    { label: '💤 午休', fields: { bedtime: '13:00', wakeTime: '13:30', quality: '好' } }
  ],
  emotion: [
    { label: '😊 开心', fields: { mood: '开心', rating: '5', trigger: '' } },
    { label: '😐 平静', fields: { mood: '平静', rating: '3', trigger: '' } },
    { label: '😤 烦躁', fields: { mood: '烦躁', rating: '2', trigger: '' } },
    { label: '😔 低落', fields: { mood: '低落', rating: '1', trigger: '' } }
  ],
  diary: [
    { label: '☀️ 今日亮点', fields: { highlight: '', lowlight: '', gratitude: '' } },
    { label: '📝 复盘', fields: { content: '今日复盘：', dialogue: '', tomorrow: '' } }
  ],
  think: [
    { label: '🤔 决策', fields: { content: '决策：', options: '', conclusion: '' } },
    { label: '💡 灵感', fields: { content: '灵感：', tags: '灵感' } }
  ]
};

// 在添加记录弹窗顶部插入快捷模板按钮
function injectQuickTemplates(sceneId){
  var tplList = QUICK_TEMPLATES[sceneId];
  if(!tplList || tplList.length === 0) return;
  var modalBody = document.getElementById('modalBody');
  if(!modalBody) return;
  // 避免重复注入
  if(document.getElementById('quickTplBar')) return;
  var bar = document.createElement('div');
  bar.id = 'quickTplBar';
  bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;padding-bottom:10px;border-bottom:1px dashed var(--c-border,#E5E7EB)';
  bar.innerHTML = '<span style="font-size:11px;color:var(--c-fg-3);width:100%;margin-bottom:4px">⚡ 快捷模板</span>';
  tplList.forEach(function(t, idx){
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = t.label;
    btn.style.cssText = 'padding:6px 10px;border:1px solid var(--c-input-border,#F5F7FA);border-radius:8px;background:var(--c-surface);color:var(--c-fg-2);font-size:12px;cursor:pointer;font-family:inherit';
    btn.onclick = function(){ applyTemplate(sceneId, t.fields); };
    bar.appendChild(btn);
  });
  modalBody.insertBefore(bar, modalBody.firstChild);
}

// 应用模板：填充表单字段
function applyTemplate(sceneId, fields){
  Object.keys(fields).forEach(function(key){
    var el = document.getElementById('f_' + key);
    if(el && fields[key]){
      el.value = fields[key];
      // 触发 change 事件，让表单逻辑感知
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
    }
  });
  showToast('已套用模板，请补充细节', 'ok', 1500);
}

// ============================================================
// 二、今日情景触发（首页主动提醒）
// ============================================================
function renderDailyNudge(){
  var container = document.getElementById('dailyNudge');
  if(!container) return;
  var nudges = generateNudges();
  if(nudges.length === 0){
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  container.innerHTML = nudges.map(function(n){
    var bg = n.urgent ? 'background:linear-gradient(135deg,#FEF3C7,#FDE68A);border-left:3px solid #F59E0B'
                       : 'background:var(--c-accent);border-left:3px solid var(--c-primary)';
    return '<div style="' + bg + ';border-radius:10px;padding:10px 12px;margin-bottom:6px;font-size:12px;color:var(--c-fg-2);line-height:1.5;cursor:pointer" onclick="' + (n.action || '') + '">' +
           '<span style="font-size:14px;margin-right:4px">' + n.icon + '</span>' +
           '<strong style="color:var(--c-fg)">' + escapeHtml(n.title) + '</strong> ' +
           escapeHtml(n.detail) +
           '</div>';
  }).join('');
}

function generateNudges(){
  var nudges = [];
  var now = new Date();
  var hour = now.getHours();
  var today = TODAY;

  // 1. 锻炼提醒：3天没记录就提醒
  var ex = dataCache.exercise || [];
  var lastEx = ex.length > 0 ? ex[ex.length - 1] : null;
  if(lastEx){
    var lastDate = lastEx.date || (lastEx.created || '').split('T')[0];
    var days = daysBetween(lastDate, today);
    if(days >= 3){
      nudges.push({ icon: '🏃', title: '该动一动了', detail: '上次锻炼是 ' + days + ' 天前，哪怕走 20 分钟也好', action: "openScene('exercise')", urgent: days >= 5 });
    }
  } else if(ex.length === 0){
    nudges.push({ icon: '🏃', title: '开始记录锻炼', detail: '记录第一次运动，建立身体节律', action: "openScene('exercise')", urgent: false });
  }

  // 2. 睡眠提醒：昨晚没记录
  var sleep = dataCache.sleep || [];
  var lastSleep = sleep.length > 0 ? sleep[sleep.length - 1] : null;
  if(!lastSleep || (lastSleep.date || (lastSleep.created || '').split('T')[0]) !== today){
    if(hour >= 7 && hour <= 11){
      nudges.push({ icon: '😴', title: '记录昨晚睡眠', detail: '补记睡眠时长和质量，让洞察更准', action: "openScene('sleep')", urgent: false });
    }
  }

  // 3. 情绪提醒：今天还没记录情绪
  var emotion = dataCache.emotion || [];
  var hasTodayEmotion = emotion.some(function(e){ return (e.date || (e.created || '').split('T')[0]) === today; });
  if(!hasTodayEmotion && hour >= 12){
    nudges.push({ icon: '😊', title: '今天心情如何？', detail: '花 10 秒记一笔，追踪情绪周期', action: "openScene('emotion')", urgent: false });
  }

  // 4. 日记提醒：晚上提醒写日记
  var diary = dataCache.diary || [];
  var hasTodayDiary = diary.some(function(d){ return (d.date || (d.created || '').split('T')[0]) === today; });
  if(!hasTodayDiary && hour >= 20){
    nudges.push({ icon: '📖', title: '今天的故事', detail: '睡前写几句，留住今天', action: "openScene('diary')", urgent: hour >= 22 });
  }

  // 5. 饮食提醒：午晚餐时段
  var diet = dataCache.diet || [];
  var hasTodayDiet = diet.some(function(d){ return (d.date || (d.created || '').split('T')[0]) === today; });
  if(!hasTodayDiet && (hour >= 12 && hour <= 13 || hour >= 18 && hour <= 19)){
    nudges.push({ icon: '🥗', title: '记一笔饮食', detail: '快速记录这顿饭，追踪营养节律', action: "openScene('diet')", urgent: false });
  }

  return nudges;
}

function daysBetween(d1, d2){
  if(!d1 || !d2) return 0;
  var t1 = new Date(d1), t2 = new Date(d2);
  if(isNaN(t1) || isNaN(t2)) return 0;
  return Math.floor((t2 - t1) / 86400000);
}

// ============================================================
// 三、记录间引用
// ============================================================
// 在添加记录弹窗中插入「关联记录」选择器
function injectReferencePicker(sceneId){
  var modalBody = document.getElementById('modalBody');
  if(!modalBody) return;
  if(document.getElementById('refPicker')) return;
  var box = document.createElement('div');
  box.id = 'refPicker';
  box.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px dashed var(--c-border,#E5E7EB)';
  box.innerHTML = '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:6px">🔗 关联记录（可选）</div>' +
    '<select id="refModule" style="width:45%;padding:6px 8px;border:1px solid var(--c-input-border,#F5F7FA);border-radius:6px;background:var(--c-surface);color:var(--c-fg);font-size:12px;margin-right:4%" onchange="updateRefList()">' +
    buildRefModuleOptions() + '</select>' +
    '<select id="refRecord" style="width:49%;padding:6px 8px;border:1px solid var(--c-input-border,#F5F7FA);border-radius:6px;background:var(--c-surface);color:var(--c-fg);font-size:12px">' +
    '<option value="">不关联</option></select>' +
    '<div id="refPreview" style="font-size:11px;color:var(--c-fg-3);margin-top:4px"></div>';
  modalBody.appendChild(box);
  updateRefList();
}

function buildRefModuleOptions(){
  var mods = ['diary', 'think', 'diet', 'exercise', 'sleep', 'emotion', 'work', 'relation', 'finance'];
  var names = { diary: '日记', think: '思考', diet: '饮食', exercise: '锻炼', sleep: '睡眠', emotion: '情绪', work: '工作', relation: '关系', finance: '财务' };
  return mods.map(function(m){ return '<option value="' + m + '">' + names[m] + '</option>'; }).join('');
}

function updateRefList(){
  var modSel = document.getElementById('refModule');
  var recSel = document.getElementById('refRecord');
  var prev = document.getElementById('refPreview');
  if(!modSel || !recSel) return;
  var mod = modSel.value;
  var recs = dataCache[mod] || [];
  recSel.innerHTML = '<option value="">不关联</option>' +
    recs.slice(-20).reverse().map(function(r){
      var title = r.content || r.food || r.mood || r.topic || r.symptom || r.task || '(无标题)';
      var date = r.date || (r.created || '').split('T')[0] || '';
      return '<option value="' + r.id + '">' + date + ' · ' + escapeHtml(String(title).substring(0, 30)) + '</option>';
    }).join('');
  if(prev) prev.textContent = '';
  recSel.onchange = function(){
    if(prev){
      var id = recSel.value;
      var rec = recs.find(function(r){ return String(r.id) === String(id); });
      if(rec){
        var title = rec.content || rec.food || rec.mood || '(无标题)';
        prev.textContent = '→ ' + String(title).substring(0, 50);
      } else {
        prev.textContent = '';
      }
    }
  };
}

// 读取引用信息，附加到表单数据
function getReferenceData(){
  var modSel = document.getElementById('refModule');
  var recSel = document.getElementById('refRecord');
  if(!modSel || !recSel) return null;
  if(!recSel.value) return null;
  return { refModule: modSel.value, refId: recSel.value };
}

// ============================================================
// 入口：拦截 openAdd/editRec，注入模板和引用选择器
// ============================================================
var _origOpenAdd = window.openAdd;
if(typeof _origOpenAdd === 'function'){
  window.openAdd = function(){
    _origOpenAdd.apply(this, arguments);
    setTimeout(function(){
      injectQuickTemplates(curScene);
      injectReferencePicker(curScene);
    }, 50);
  };
}

var _origEditRec = window.editRec;
if(typeof _origEditRec === 'function'){
  window.editRec = function(sceneId, id){
    _origEditRec.apply(this, arguments);
    setTimeout(function(){
      injectQuickTemplates(sceneId);
      injectReferencePicker(sceneId);
    }, 50);
  };
}

// 拦截 saveRecord，把引用信息以可读文本附加到 note 字段（不改后端，零风险）
var _origSaveRecord = window.saveRecord;
if(typeof _origSaveRecord === 'function'){
  window.saveRecord = function(){
    try {
      var modSel = document.getElementById('refModule');
      var recSel = document.getElementById('refRecord');
      if(modSel && recSel && recSel.value){
        var mod = modSel.value;
        var recs = dataCache[mod] || [];
        var rec = recs.find(function(r){ return String(r.id) === String(recSel.value); });
        if(rec){
          var names = { diary: '日记', think: '思考', diet: '饮食', exercise: '锻炼', sleep: '睡眠', emotion: '情绪', work: '工作', relation: '关系', finance: '财务' };
          var title = rec.content || rec.food || rec.mood || rec.topic || '(无标题)';
          var date = rec.date || (rec.created || '').split('T')[0] || '';
          var refText = '\n🔗 关联' + (names[mod] || mod) + '：' + date + ' ' + String(title).substring(0, 40);
          var noteEl = document.getElementById('f_note') || document.getElementById('f_n');
          if(noteEl){
            noteEl.value = (noteEl.value || '') + refText;
          }
        }
      }
    } catch(e) { console.warn('[enhancements] 引用附加失败:', e.message); }
    return _origSaveRecord.apply(this, arguments);
  };
}

// 在首页插入「今日提醒」容器
var _origRenderHome = window.renderHome;
if(typeof _origRenderHome === 'function'){
  window.renderHome = function(){
    _origRenderHome.apply(this, arguments);
    // 确保 dailyNudge 容器存在
    var homeContent = document.getElementById('homeContent');
    if(homeContent && !document.getElementById('dailyNudge')){
      var nudge = document.createElement('div');
      nudge.id = 'dailyNudge';
      nudge.style.cssText = 'margin-bottom:16px';
      // 插入到「今日概览」之前
      var overview = homeContent.querySelector('.section-label');
      if(overview){
        homeContent.insertBefore(nudge, overview);
      } else {
        homeContent.insertBefore(nudge, homeContent.firstChild);
      }
    }
    renderDailyNudge();
  };
}

console.log('[enhancements] 已加载：快捷模板 + 今日提醒 + 记录引用');
