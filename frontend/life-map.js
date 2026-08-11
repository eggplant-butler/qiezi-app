// life-map.js — 人生地图：可视化探索系统
// 依赖: dataCache, TODAY, openModal2, escapeHtml, openScene
// 加载: app.js 之后

var LIFE_MAP = {
  canvas: null, ctx: null, points: [], markers: [], w: 0, h: 0, cx: 0, cy: 0,

  // 8个生活领域（雷达式分布）
  DOMAINS: [
    { key:'spirit',   name:'精神',  icon:'🧠', angle:0,   mods:['think','diary'] },
    { key:'growth',   name:'成长',  icon:'🌱', angle:45,  mods:['growth','learn','photo'] },
    { key:'relation', name:'关系',  icon:'👥', angle:90,  mods:['relation'] },
    { key:'work',     name:'工作',  icon:'💼', angle:135, mods:['work','todo'] },
    { key:'finance',  name:'物质',  icon:'💰', angle:180, mods:['finance','inventory'] },
    { key:'life',     name:'生活',  icon:'🏠', angle:225, mods:['diet','sleep','exercise','home'] },
    { key:'body',     name:'身体',  icon:'❤️', angle:270, mods:['body','health'] },
    { key:'emotion',  name:'情绪',  icon:'😊', angle:315, mods:['emotion'] }
  ],

  // 从 dataCache 计算地图数据
  computeData: function(){
    this.points = [];
    this.markers = [];
    var self = this;
    var now = new Date(TODAY);
    this.DOMAINS.forEach(function(domain){
      var allRecs = [];
      domain.mods.forEach(function(mid){
        (dataCache[mid]||[]).forEach(function(r){ allRecs.push(Object.assign({_mod:mid}, r)); });
      });
      // 计算这个领域的探索度
      domain.explored = Math.min(1, allRecs.length / 20);
      domain.recCount = allRecs.length;
      // 最近30天的记录作为地图点
      allRecs.forEach(function(r){
        var d = r.date || (r.created||'').split('T')[0];
        if(!d) return;
        var daysAgo = Math.floor((now - new Date(d)) / 86400000);
        if(daysAgo < 0) daysAgo = 0;
        if(daysAgo > 365) return; // 只显示一年内
        // 计算位置：角度 + 距离（越久越远）
        var rad = (domain.angle - 90) * Math.PI / 180;
        var dist = 30 + (daysAgo / 365) * 180; // 30~210px
        var px = self.cx + Math.cos(rad) * dist;
        var py = self.cy + Math.sin(rad) * dist;
        // 情绪颜色
        var rating = parseFloat(r.rating) || 0;
        var mood = r.mood || '';
        var color = '#9CA3AF'; // 默认灰
        if(rating > 0){
          if(rating >= 4) color = '#10B981';
          else if(rating >= 3) color = '#F59E0B';
          else color = '#EF4444';
        } else if(mood){
          if(/开心|快乐|兴奋|幸福/.test(mood)) color = '#10B981';
          else if(/烦躁|焦虑|难过|低落|愤怒/.test(mood)) color = '#EF4444';
          else color = '#F59E0B';
        }
        // 标题
        var title = r.content || r.food || r.mood || r.topic || r.symptom || r.task || '(无标题)';
        self.points.push({ x:px, y:py, color:color, size:3, rec:r, mod:domain.key, domain:domain.name, daysAgo:daysAgo, title:String(title).substring(0,40) });
        // 危险标记
        if((rating > 0 && rating <= 2) || /崩溃|绝望|抑郁|想死|撑不住/.test(title)){
          self.markers.push({ x:px, y:py, type:'danger', title:'低落时刻：'+String(title).substring(0,30), rec:r });
        }
        // 成就标记
        if(rating >= 5 || /成就|突破|成功|完成|做到了/.test(title)){
          self.markers.push({ x:px, y:py, type:'achievement', title:'高光时刻：'+String(title).substring(0,30), rec:r });
        }
      });
      // 检查未探索
      if(allRecs.length === 0){
        var rad = (domain.angle - 90) * Math.PI / 180;
        self.markers.push({ x:self.cx + Math.cos(rad)*80, y:self.cy + Math.sin(rad)*80, type:'fog', title:'你从未探索过「'+domain.name+'」领域', domain:domain });
      }
    });
    // 循环模式标记（简化版：找重复关键词）
    var thinkRecs = (dataCache.think||[]).concat(dataCache.diary||[]);
    var keywordCount = {};
    thinkRecs.forEach(function(r){
      var words = (r.content||'').match(/[\u4e00-\u9fa5]{2,4}/g) || [];
      words.forEach(function(w){
        if(['焦虑','烦躁','开心','累','孤独','换工作','纠结','决定','放弃','坚持'].indexOf(w) !== -1){
          keywordCount[w] = (keywordCount[w]||0) + 1;
        }
      });
    });
    Object.keys(keywordCount).forEach(function(kw){
      if(keywordCount[kw] >= 3){
        self.markers.push({ x:self.cx + (Math.random()-0.5)*100, y:self.cy + (Math.random()-0.5)*100, type:'cycle', title:'「'+kw+'」出现'+keywordCount[kw]+'次——这是你的循环模式', keyword:kw });
      }
    });
  },

  // 天气预报（风险预警）
  getWeather: function(){
    var alerts = [];
    var emotion = dataCache.emotion || [];
    var sleep = dataCache.sleep || [];
    var exercise = dataCache.exercise || [];
    // 最近7天情绪趋势
    var recentEmotion = emotion.slice(-7);
    if(recentEmotion.length >= 3){
      var avg = recentEmotion.reduce(function(s,e){return s+(parseFloat(e.rating)||0);},0) / recentEmotion.length;
      if(avg <= 2.5){
        alerts.push({ level:'danger', icon:'⛈️', text:'最近情绪持续走低（均值'+avg.toFixed(1)+'），注意自我关怀' });
      } else if(avg >= 4){
        alerts.push({ level:'good', icon:'☀️', text:'最近状态不错（情绪均值'+avg.toFixed(1)+'），保持节奏' });
      }
    }
    // 睡眠不足预警
    var recentSleep = sleep.slice(-3);
    if(recentSleep.length >= 2){
      var lowSleep = recentSleep.filter(function(s){ return (parseFloat(s.hours)||0) < 6.5; }).length;
      if(lowSleep >= 2){
        alerts.push({ level:'warning', icon:'🌧️', text:'连续睡眠不足，今晚早点休息' });
      }
    }
    // 锻炼缺失
    var lastEx = exercise.length > 0 ? exercise[exercise.length-1] : null;
    if(lastEx){
      var lastDate = lastEx.date || (lastEx.created||'').split('T')[0];
      var days = Math.floor((new Date(TODAY) - new Date(lastDate)) / 86400000);
      if(days >= 5){
        alerts.push({ level:'warning', icon:'🌫️', text:'已'+days+'天未运动，身体节律在下降' });
      }
    }
    if(alerts.length === 0){
      alerts.push({ level:'good', icon:'🌤️', text:'暂无风险信号，继续探索你的地图' });
    }
    return alerts;
  },

  // 绘制地图
  draw: function(){
    var c = this.canvas, ctx = this.ctx;
    if(!c || !ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    // 背景渐变
    var bg = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, 250);
    bg.addColorStop(0, 'rgba(99,102,241,0.05)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);
    // 画领域扇形
    var self = this;
    this.DOMAINS.forEach(function(domain){
      var rad = (domain.angle - 90) * Math.PI / 180;
      // 领域标签
      var labelDist = 230;
      var lx = self.cx + Math.cos(rad) * labelDist;
      var ly = self.cy + Math.sin(rad) * labelDist;
      ctx.font = '13px sans-serif';
      ctx.fillStyle = domain.explored > 0.3 ? '#4B5563' : '#D1D5DB';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(domain.icon + ' ' + domain.name + ' (' + domain.recCount + ')', lx, ly);
      // 迷雾效果
      if(domain.explored < 0.15){
        ctx.beginPath();
        ctx.arc(self.cx + Math.cos(rad)*100, self.cy + Math.sin(rad)*100, 70, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(107,114,128,0.08)';
        ctx.fill();
      }
      // 领域引导线
      ctx.beginPath();
      ctx.moveTo(self.cx + Math.cos(rad)*25, self.cy + Math.sin(rad)*25);
      ctx.lineTo(self.cx + Math.cos(rad)*210, self.cy + Math.sin(rad)*210);
      ctx.strokeStyle = 'rgba(229,231,235,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    // 画时间环
    [60, 120, 180].forEach(function(r){
      ctx.beginPath();
      ctx.arc(self.cx, self.cy, r, 0, Math.PI*2);
      ctx.strokeStyle = 'rgba(229,231,235,0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3,3]);
      ctx.stroke();
      ctx.setLineDash([]);
    });
    // 时间环标签
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#9CA3AF';
    ctx.textAlign = 'left';
    ctx.fillText('30天', this.cx + 62, this.cy - 3);
    ctx.fillText('90天', this.cx + 122, this.cy - 3);
    ctx.fillText('1年', this.cx + 182, this.cy - 3);
    // 画记录点
    this.points.forEach(function(p){
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0.3, 1 - p.daysAgo/365);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    // 画标记
    this.markers.forEach(function(m){
      if(m.type === 'danger'){
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('⚠️', m.x, m.y - 8);
      } else if(m.type === 'achievement'){
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('⭐', m.x, m.y - 8);
      } else if(m.type === 'fog'){
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.globalAlpha = 0.4;
        ctx.fillText('🌫️', m.x, m.y);
        ctx.globalAlpha = 1;
      } else if(m.type === 'cycle'){
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🔄', m.x, m.y);
      }
    });
    // 画中心点（你）
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, 8, 0, Math.PI*2);
    var grad = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, 12);
    grad.addColorStop(0, '#6366F1');
    grad.addColorStop(1, 'rgba(99,102,241,0)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, 4, 0, Math.PI*2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#6366F1';
    ctx.fillText('你', this.cx, this.cy + 20);
  },

  // 处理点击
  handleClick: function(x, y){
    // 检查标记
    for(var i = this.markers.length - 1; i >= 0; i--){
      var m = this.markers[i];
      var dx = x - m.x, dy = y - m.y;
      if(dx*dx + dy*dy < 400){ // 20px半径
        if(m.rec){
          var title = m.rec.content || m.rec.food || m.rec.mood || '(无标题)';
          var date = m.rec.date || (m.rec.created||'').split('T')[0] || '';
          alert(date + '\n' + m.title + '\n\n' + String(title).substring(0, 100));
        } else if(m.domain){
          alert(m.title + '\n\n点击下方对应领域开始记录');
        } else if(m.keyword){
          alert(m.title);
        }
        return;
      }
    }
    // 检查记录点
    for(var i = this.points.length - 1; i >= 0; i--){
      var p = this.points[i];
      var dx = x - p.x, dy = y - p.y;
      if(dx*dx + dy*dy < 100){ // 10px半径
        var date = p.rec.date || (p.rec.created||'').split('T')[0] || '';
        var timeText = p.daysAgo === 0 ? '今天' : p.daysAgo + '天前';
        alert(p.domain + ' · ' + date + '（' + timeText + '）\n\n' + p.title);
        return;
      }
    }
  }
};

// 打开人生地图
function openLifeMap(){
  var html = '<div id="lifeMapContainer" style="position:relative">';
  // 天气预报
  var weather = LIFE_MAP.getWeather();
  html += '<div style="margin-bottom:10px">';
  weather.forEach(function(w){
    var bg = w.level === 'danger' ? '#FEF2F2' : w.level === 'warning' ? '#FFFBEB' : '#F0FDF4';
    var border = w.level === 'danger' ? '#EF4444' : w.level === 'warning' ? '#F59E0B' : '#10B981';
    html += '<div style="background:' + bg + ';border-left:3px solid ' + border + ';border-radius:8px;padding:8px 10px;margin-bottom:4px;font-size:12px;color:#374151">' + w.icon + ' ' + escapeHtml(w.text) + '</div>';
  });
  html += '</div>';
  // Canvas
  html += '<canvas id="lifeMapCanvas" width="500" height="500" style="width:100%;max-width:500px;display:block;margin:0 auto;background:var(--c-surface);border-radius:12px;touch-action:manipulation;cursor:pointer"></canvas>';
  // 图例
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;font-size:10px;color:var(--c-fg-3)">';
  html += '<span>🟢开心</span><span>🟡一般</span><span>🔴低落</span>';
  html += '<span>⚠️危险</span><span>⭐高光</span><span>🔄循环</span><span>🌫️未探索</span>';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--c-fg-3);margin-top:8px;text-align:center">点击地图上的点和标记查看详情 · 中心是你 · 越远越久远</div>';
  html += '</div>';
  openModal2('🗺️ 人生地图', html);
  // 初始化
  setTimeout(function(){
    var canvas = document.getElementById('lifeMapCanvas');
    if(!canvas) return;
    LIFE_MAP.canvas = canvas;
    LIFE_MAP.ctx = canvas.getContext('2d');
    LIFE_MAP.w = canvas.width;
    LIFE_MAP.h = canvas.height;
    LIFE_MAP.cx = canvas.width / 2;
    LIFE_MAP.cy = canvas.height / 2;
    LIFE_MAP.computeData();
    LIFE_MAP.draw();
    // 点击处理
    canvas.addEventListener('click', function(e){
      var rect = canvas.getBoundingClientRect();
      var scale = canvas.width / rect.width;
      var x = (e.clientX - rect.left) * scale;
      var y = (e.clientY - rect.top) * scale;
      LIFE_MAP.handleClick(x, y);
    });
    // 触摸支持
    canvas.addEventListener('touchend', function(e){
      if(e.changedTouches.length === 0) return;
      e.preventDefault();
      var touch = e.changedTouches[0];
      var rect = canvas.getBoundingClientRect();
      var scale = canvas.width / rect.width;
      var x = (touch.clientX - rect.left) * scale;
      var y = (touch.clientY - rect.top) * scale;
      LIFE_MAP.handleClick(x, y);
    });
  }, 100);
}

console.log('[life-map] 已加载：人生地图可视化系统');
