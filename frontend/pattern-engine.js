// pattern-engine.js — 模式发现引擎 + 跨时间对话引擎
// 依赖 app.js 全局: dataCache, TODAY, openModal2, escapeHtml, showToast, openScene
// 加载顺序: 必须在 app.js 之后加载

// ============================================================
// 引擎一：模式发现引擎
// 扫描所有数据，发现用户自己看不到的隐藏规律
// ============================================================

var PATTERN_ENGINE = {
  // 发现所有模式
  discover: function(){
    var patterns = [];
    patterns = patterns.concat(this.findTimePatterns());
    patterns = patterns.concat(this.findEmotionTriggers());
    patterns = patterns.concat(this.findBehaviorCycles());
    patterns = patterns.concat(this.findCorrelationPatterns());
    patterns = patterns.concat(this.findContradictionPatterns());
    // 按置信度排序
    patterns.sort(function(a,b){ return (b.confidence||0) - (a.confidence||0); });
    return patterns;
  },

  // 1. 时间规律：发现"每周X你都会Y"
  findTimePatterns: function(){
    var patterns = [];
    var dayNames = ['周日','周一','周二','周三','周四','周五','周六'];
    var dayBuckets = {}; // day -> { emotion: [], sleep: [], exercise: [] }

    (dataCache.emotion || []).forEach(function(e){
      var d = e.date || (e.created||'').split('T')[0];
      if(!d) return;
      var day = new Date(d).getDay();
      if(isNaN(day)) return;
      if(!dayBuckets[day]) dayBuckets[day] = { emotion: [], sleep: [], exercise: [] };
      dayBuckets[day].emotion.push(parseFloat(e.rating) || 0);
    });
    (dataCache.sleep || []).forEach(function(s){
      var d = s.date || (s.created||'').split('T')[0];
      if(!d) return;
      var day = new Date(d).getDay();
      if(isNaN(day)) return;
      if(!dayBuckets[day]) dayBuckets[day] = { emotion: [], sleep: [], exercise: [] };
      dayBuckets[day].sleep.push(parseFloat(s.hours) || 0);
    });

    // 找情绪明显偏低/偏高的星期
    Object.keys(dayBuckets).forEach(function(day){
      var b = dayBuckets[day];
      if(b.emotion.length >= 3){
        var avg = b.emotion.reduce(function(s,v){return s+v;},0) / b.emotion.length;
        if(avg <= 2.5){
          patterns.push({
            type: 'time_emotion_low',
            icon: '📉',
            title: '每逢' + dayNames[day] + '你情绪都偏低',
            detail: '最近 ' + b.emotion.length + ' 个' + dayNames[day] + '平均情绪 ' + avg.toFixed(1) + '/5，显著低于其他日子。这可能是周期性压力源。',
            action: "openScene('emotion')",
            confidence: b.emotion.length * 0.3
          });
        } else if(avg >= 4.2){
          patterns.push({
            type: 'time_emotion_high',
            icon: '📈',
            title: '每逢' + dayNames[day] + '你状态都不错',
            detail: '最近 ' + b.emotion.length + ' 个' + dayNames[day] + '平均情绪 ' + avg.toFixed(1) + '/5。' + dayNames[day] + '有什么让你期待的事吗？',
            action: "openScene('emotion')",
            confidence: b.emotion.length * 0.2
          });
        }
      }
      if(b.sleep.length >= 3){
        var avg = b.sleep.reduce(function(s,v){return s+v;},0) / b.sleep.length;
        if(avg < 6.5){
          patterns.push({
            type: 'time_sleep_low',
            icon: '😴',
            title: '每逢' + dayNames[day] + '前夜都睡不好',
            detail: '最近 ' + b.sleep.length + ' 个' + dayNames[day] + '前夜平均睡眠 ' + avg.toFixed(1) + ' 小时。是不是' + dayNames[day] + '有什么事让你焦虑？',
            action: "openScene('sleep')",
            confidence: b.sleep.length * 0.3
          });
        }
      }
    });
    return patterns;
  },

  // 2. 情绪触发器：发现"每次X之后你都会Y"
  findEmotionTriggers: function(){
    var patterns = [];
    var emotion = dataCache.emotion || [];
    var diet = dataCache.diet || [];
    var exercise = dataCache.exercise || [];

    // 锻炼日 vs 非锻炼日的情绪差异
    var exerciseDays = {};
    (exercise || []).forEach(function(x){
      var d = x.date || (x.created||'').split('T')[0];
      if(d) exerciseDays[d] = true;
    });
    var exEmotion = [], noExEmotion = [];
    (emotion || []).forEach(function(e){
      var d = e.date || (e.created||'').split('T')[0];
      if(exerciseDays[d] || exerciseDays[this.addDays(d,-1)]){
        exEmotion.push(parseFloat(e.rating)||0);
      } else {
        noExEmotion.push(parseFloat(e.rating)||0);
      }
    }.bind(this));

    if(exEmotion.length >= 3 && noExEmotion.length >= 3){
      var exAvg = exEmotion.reduce(function(s,v){return s+v;},0)/exEmotion.length;
      var noAvg = noExEmotion.reduce(function(s,v){return s+v;},0)/noExEmotion.length;
      if(exAvg - noAvg >= 0.8){
        patterns.push({
          type: 'exercise_mood_boost',
          icon: '🏃',
          title: '运动让你的情绪明显提升',
          detail: '锻炼日及次日平均情绪 ' + exAvg.toFixed(1) + '，不锻炼日 ' + noAvg.toFixed(1) + '。运动是你目前最有效的情绪调节器。',
          action: "openScene('exercise')",
          confidence: Math.min(exEmotion.length, noExEmotion.length) * 0.4
        });
      }
    }
    return patterns;
  },

  // 3. 行为周期：发现"你每隔N天会做X"
  findBehaviorCycles: function(){
    var patterns = [];
    var modules = ['diary', 'think', 'exercise', 'diet'];
    modules.forEach(function(mid){
      var recs = dataCache[mid] || [];
      if(recs.length < 5) return;
      // 计算记录间隔
      var dates = recs.map(function(r){ return r.date || (r.created||'').split('T')[0]; }).filter(Boolean).sort();
      var gaps = [];
      for(var i=1; i<dates.length; i++){
        var gap = this.daysBetween(dates[i-1], dates[i]);
        if(gap > 0 && gap < 30) gaps.push(gap);
      }
      if(gaps.length < 3) return;
      var avgGap = gaps.reduce(function(s,v){return s+v;},0)/gaps.length;
      var variance = gaps.reduce(function(s,v){return s + Math.pow(v-avgGap,2);},0)/gaps.length;
      var stdDev = Math.sqrt(variance);
      // 标准差小于平均间隔的30%，说明有规律
      if(stdDev < avgGap * 0.3 && avgGap > 1.5){
        var names = {diary:'写日记', think:'思考记录', exercise:'锻炼', diet:'记录饮食'};
        patterns.push({
          type: 'behavior_cycle',
          icon: '🔄',
          title: '你每 ' + Math.round(avgGap) + ' 天会' + (names[mid]||mid),
          detail: '最近 ' + gaps.length + 1 + ' 次记录的平均间隔 ' + avgGap.toFixed(1) + ' 天，节奏稳定。这是你的内在节律。',
          action: "openScene('" + mid + "')",
          confidence: gaps.length * 0.3
        });
      }
    }.bind(this));
    return patterns;
  },

  // 4. 关联模式：发现"X和Y同时出现"
  findCorrelationPatterns: function(){
    var patterns = [];
    var sleep = dataCache.sleep || [];
    var emotion = dataCache.emotion || [];

    // 睡眠不足与情绪低落
    var lowSleepDays = {};
    sleep.forEach(function(s){
      var d = s.date || (s.created||'').split('T')[0];
      var h = parseFloat(s.hours) || 0;
      if(d && h > 0 && h < 6.5) lowSleepDays[d] = true;
    });
    var lowSleepLowMood = 0, totalLowSleep = 0;
    Object.keys(lowSleepDays).forEach(function(d){
      totalLowSleep++;
      var e = emotion.find(function(x){ return (x.date||(x.created||'').split('T')[0]) === d; });
      if(e && parseFloat(e.rating) <= 2.5) lowSleepLowMood++;
    });
    if(totalLowSleep >= 3){
      var ratio = lowSleepLowMood / totalLowSleep;
      if(ratio >= 0.6){
        patterns.push({
          type: 'sleep_mood_corr',
          icon: '😴',
          title: '睡眠不足时，' + Math.round(ratio*100) + '% 的时间你情绪低落',
          detail: '最近有 ' + totalLowSleep + ' 天睡眠不足6.5小时，其中 ' + lowSleepLowMood + ' 天情绪低落。睡眠是你情绪的地基。',
          action: "openScene('sleep')",
          confidence: totalLowSleep * 0.5
        });
      }
    }
    return patterns;
  },

  // 5. 矛盾模式：发现"你说X但做Y"
  findContradictionPatterns: function(){
    var patterns = [];
    var think = dataCache.think || [];
    var diary = dataCache.diary || [];

    // 找到"决定"类记录，看后续是否执行
    think.forEach(function(t){
      var content = (t.content || '').toLowerCase();
      if(/决定|计划|开始|不再|坚持|一定要|必须/.test(content)){
        var tDate = t.date || (t.created||'').split('T')[0];
        var text30 = (t.content||'').substring(0, 40);
        // 检查后7天日记里有没有提到这件事
        var followed = diary.some(function(d){
          var dDate = d.date || (d.created||'').split('T')[0];
          var gap = this.daysBetween(tDate, dDate);
          if(gap < 0 || gap > 7) return false;
          var dc = (d.content || '').toLowerCase();
          // 简单关键词匹配
          var keywords = (t.content||'').split(/[\s,，。.、]+/).filter(function(w){ return w.length >= 2; }).slice(0, 3);
          return keywords.some(function(k){ return dc.indexOf(k.toLowerCase()) !== -1; });
        }.bind(this));
        if(!followed){
          patterns.push({
            type: 'contradiction',
            icon: '⚖️',
            title: '你说过要做，但7天内没再提及',
            detail: '「' + text30 + '...」——这个决定似乎没有落地。是放弃了，还是忘了？',
            action: "openScene('think')",
            confidence: 0.5
          });
        }
      }
    }.bind(this));
    return patterns.slice(0, 3); // 最多3条，避免太多
  },

  // 工具函数
  addDays: function(dateStr, n){
    var d = new Date(dateStr);
    if(isNaN(d)) return '';
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  },
  daysBetween: function(d1, d2){
    if(!d1 || !d2) return 0;
    var t1 = new Date(d1), t2 = new Date(d2);
    if(isNaN(t1) || isNaN(t2)) return 0;
    return Math.floor((t2 - t1) / 86400000);
  }
};

// 打开模式发现面板
function openPatternEngine(){
  var html = '<div style="text-align:center;color:var(--c-fg-3);padding:20px;font-size:13px">🔍 正在扫描你的所有记录...</div>';
  openModal2('🔍 模式发现', html);
  setTimeout(function(){
    var patterns = PATTERN_ENGINE.discover();
    var el = document.getElementById('modal2Body');
    if(!el) return;
    if(patterns.length === 0){
      el.innerHTML = '<div style="text-align:center;padding:30px 20px;color:var(--c-fg-3);font-size:13px;line-height:1.6">' +
        '<div style="font-size:32px;margin-bottom:12px">🌱</div>' +
        '数据还不够发现模式。<br>继续记录，当数据积累到一定程度，<br>这里会自动浮现你自己看不见的规律。<br><br>' +
        '<span style="font-size:11px;color:var(--c-fg-3)">建议：至少记录 2 周以上</span></div>';
      return;
    }
    var html2 = '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">发现了 ' + patterns.length + ' 个模式。这些是你自己可能没意识到的规律——它们不一定都对，但值得审视。</div>';
    patterns.forEach(function(p){
      var bg = p.confidence >= 1 ? 'background:linear-gradient(135deg,#FEF3C7,#FDE68A);border-left:3px solid #F59E0B'
                                   : 'background:var(--c-surface);border-left:3px solid var(--c-primary)';
      html2 += '<div onclick="' + (p.action||'') + '" style="' + bg + ';border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer">' +
        '<div style="font-size:13px;font-weight:600;color:var(--c-fg);margin-bottom:4px">' + p.icon + ' ' + escapeHtml(p.title) + '</div>' +
        '<div style="font-size:12px;color:var(--c-fg-2);line-height:1.5">' + escapeHtml(p.detail) + '</div>' +
        '</div>';
    });
    el.innerHTML = html2;
  }, 100);
}

// ============================================================
// 引擎二：跨时间对话引擎
// "去年的今天""N天前的你""你曾经想过X"
// ============================================================

var TIME_DIALOGUE = {
  // 获取N天前的记录
  getRecordsNDaysAgo: function(days){
    var targetDate = this.addDays(TODAY, -days);
    var results = [];
    Object.keys(dataCache).forEach(function(mid){
      var recs = dataCache[mid] || [];
      recs.forEach(function(r){
        var d = r.date || (r.created||'').split('T')[0];
        if(d === targetDate){
          results.push({ mid: mid, rec: r });
        }
      });
    });
    return { date: targetDate, records: results };
  },

  // 获取一年前的今天（含前后3天）
  getRecordsYearAgo: function(){
    var lastYear = new Date();
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    var targetStart = this.addDays(lastYear.toISOString().split('T')[0], -3);
    var targetEnd = this.addDays(lastYear.toISOString().split('T')[0], 3);
    var results = [];
    Object.keys(dataCache).forEach(function(mid){
      var recs = dataCache[mid] || [];
      recs.forEach(function(r){
        var d = r.date || (r.created||'').split('T')[0];
        if(d >= targetStart && d <= targetEnd){
          results.push({ mid: mid, rec: r, daysDiff: this.daysBetween(d, TODAY) });
        }
      }.bind(this));
    }.bind(this));
    return { date: lastYear.toISOString().split('T')[0], records: results };
  },

  // 找"你曾经想过X"——关键词回溯
  findPastThoughts: function(keyword){
    if(!keyword || keyword.length < 2) return [];
    var results = [];
    var mods = ['think', 'diary', 'emotion'];
    mods.forEach(function(mid){
      var recs = dataCache[mid] || [];
      recs.forEach(function(r){
        var text = JSON.stringify(r).toLowerCase();
        if(text.indexOf(keyword.toLowerCase()) !== -1){
          results.push({ mid: mid, rec: r, daysAgo: this.daysBetween(r.date||(r.created||'').split('T')[0], TODAY) });
        }
      }.bind(this));
    }.bind(this));
    results.sort(function(a,b){ return b.daysAgo - a.daysAgo; });
    return results;
  },

  addDays: function(dateStr, n){
    var d = new Date(dateStr);
    if(isNaN(d)) return '';
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  },
  daysBetween: function(d1, d2){
    if(!d1 || !d2) return 0;
    var t1 = new Date(d1), t2 = new Date(d2);
    if(isNaN(t1) || isNaN(t2)) return 0;
    return Math.floor((t2 - t1) / 86400000);
  }
};

function openTimeDialogue(){
  var html = '';
  html += '<div style="background:var(--c-accent);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#4B5563;line-height:1.6">和过去的自己对话。看看一年前、一个月前、一周前的今天，你在想什么、经历什么。</div>';

  // 一年前的今天
  var yearAgo = TIME_DIALOGUE.getRecordsYearAgo();
  html += '<div style="margin-bottom:16px">';
  html += '<div style="font-size:13px;font-weight:600;color:var(--c-fg);margin-bottom:8px">📅 一年前的今天（' + yearAgo.date + ' 前后）</div>';
  if(yearAgo.records.length === 0){
    html += '<div style="font-size:12px;color:var(--c-fg-3);padding:8px 0">还没有一年前的数据。明年今日，这里会出现今天的你。</div>';
  } else {
    yearAgo.records.slice(0, 5).forEach(function(item){
      var title = item.rec.content || item.rec.food || item.rec.mood || item.rec.topic || '(无标题)';
      var names = {think:'思考', diary:'日记', emotion:'情绪', diet:'饮食', exercise:'锻炼', sleep:'睡眠'};
      html += '<div style="background:var(--c-surface);border-radius:8px;padding:10px;margin-bottom:6px;border-left:3px solid var(--c-primary)">' +
        '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:2px">' + (names[item.mid]||item.mid) + '</div>' +
        '<div style="font-size:12px;color:var(--c-fg);line-height:1.5">' + escapeHtml(String(title).substring(0, 80)) + '</div>' +
        '</div>';
    });
  }
  html += '</div>';

  // 30天前
  var monthAgo = TIME_DIALOGUE.getRecordsNDaysAgo(30);
  html += '<div style="margin-bottom:16px">';
  html += '<div style="font-size:13px;font-weight:600;color:var(--c-fg);margin-bottom:8px">📅 一个月前（' + monthAgo.date + '）</div>';
  if(monthAgo.records.length === 0){
    html += '<div style="font-size:12px;color:var(--c-fg-3);padding:8px 0">这一天没有记录。</div>';
  } else {
    monthAgo.records.slice(0, 5).forEach(function(item){
      var title = item.rec.content || item.rec.food || item.rec.mood || item.rec.topic || '(无标题)';
      var names = {think:'思考', diary:'日记', emotion:'情绪', diet:'饮食', exercise:'锻炼', sleep:'睡眠'};
      html += '<div style="background:var(--c-surface);border-radius:8px;padding:10px;margin-bottom:6px;border-left:3px solid var(--c-primary)">' +
        '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:2px">' + (names[item.mid]||item.mid) + '</div>' +
        '<div style="font-size:12px;color:var(--c-fg);line-height:1.5">' + escapeHtml(String(title).substring(0, 80)) + '</div>' +
        '</div>';
    });
  }
  html += '</div>';

  // 7天前
  var weekAgo = TIME_DIALOGUE.getRecordsNDaysAgo(7);
  html += '<div style="margin-bottom:16px">';
  html += '<div style="font-size:13px;font-weight:600;color:var(--c-fg);margin-bottom:8px">📅 一周前（' + weekAgo.date + '）</div>';
  if(weekAgo.records.length === 0){
    html += '<div style="font-size:12px;color:var(--c-fg-3);padding:8px 0">这一天没有记录。</div>';
  } else {
    weekAgo.records.slice(0, 5).forEach(function(item){
      var title = item.rec.content || item.rec.food || item.rec.mood || item.rec.topic || '(无标题)';
      var names = {think:'思考', diary:'日记', emotion:'情绪', diet:'饮食', exercise:'锻炼', sleep:'睡眠'};
      html += '<div style="background:var(--c-surface);border-radius:8px;padding:10px;margin-bottom:6px;border-left:3px solid var(--c-primary)">' +
        '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:2px">' + (names[item.mid]||item.mid) + '</div>' +
        '<div style="font-size:12px;color:var(--c-fg);line-height:1.5">' + escapeHtml(String(title).substring(0, 80)) + '</div>' +
        '</div>';
    });
  }
  html += '</div>';

  // 关键词回溯
  html += '<div style="margin-top:16px;padding-top:12px;border-top:1px dashed var(--c-border,#E5E7EB)">';
  html += '<div style="font-size:13px;font-weight:600;color:var(--c-fg);margin-bottom:8px">🔎 你曾经想过...</div>';
  html += '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">';
  var keywords = ['焦虑', '换工作', '孤独', '开心', '决定', '放弃', '喜欢', '累'];
  keywords.forEach(function(k){
    html += '<button onclick="searchPastThoughts(\'' + k + '\')" style="padding:5px 10px;border:1px solid var(--c-input-border,#F5F7FA);border-radius:6px;background:var(--c-surface);color:var(--c-fg-2);font-size:11px;cursor:pointer;font-family:inherit">' + k + '</button>';
  });
  html += '</div>';
  html += '<div id="pastThoughtsResult"></div>';
  html += '</div>';

  openModal2('⏳ 跨时间对话', html);
}

function searchPastThoughts(keyword){
  var results = TIME_DIALOGUE.findPastThoughts(keyword);
  var el = document.getElementById('pastThoughtsResult');
  if(!el) return;
  if(results.length === 0){
    el.innerHTML = '<div style="font-size:12px;color:var(--c-fg-3);padding:8px 0">没有找到包含「' + escapeHtml(keyword) + '」的记录。</div>';
    return;
  }
  var html = '<div style="font-size:11px;color:var(--c-fg-3);margin-bottom:6px">找到 ' + results.length + ' 条：</div>';
  results.slice(0, 10).forEach(function(item){
    var title = item.rec.content || item.rec.mood || '(无标题)';
    var names = {think:'思考', diary:'日记', emotion:'情绪'};
    var date = item.rec.date || (item.rec.created||'').split('T')[0] || '';
    var timeText = item.daysAgo > 0 ? item.daysAgo + '天前' : '今天';
    html += '<div style="background:var(--c-surface);border-radius:6px;padding:8px 10px;margin-bottom:4px">' +
      '<div style="font-size:10px;color:var(--c-fg-3)">' + date + ' · ' + timeText + ' · ' + (names[item.mid]||item.mid) + '</div>' +
      '<div style="font-size:12px;color:var(--c-fg);line-height:1.4;margin-top:2px">' + escapeHtml(String(title).substring(0, 80)) + '</div>' +
      '</div>';
  });
  el.innerHTML = html;
}

console.log('[engines] 已加载：模式发现 + 跨时间对话');
