if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    // v6.4.5 紧急逃生：主动 fetch sw.js 检查版本，旧版本直接注销 + 清缓存 + 强刷
    fetch('/sw.js?_v=' + Date.now(), { cache: 'no-store' })
      .then(function(r) { return r.text(); })
      .then(function(txt) {
        var m = txt.match(/qiezi-v([\d.]+)/);
        var serverVer = m ? m[1] : '0';
        // 当前控制的 SW 版本
        return navigator.serviceWorker.getRegistration('/').then(function(reg) {
          if (!reg || !reg.active) return reg;
          // 拿当前 SW 的版本
          return navigator.serviceWorker.controller.scriptURL ? reg : reg;
        }).then(function(r) {
          // 主动触发更新（浏览器会重新拉取 sw.js，发现版本变化就触发 updatefound）
          if (r) r.update().catch(function(){});
          return r;
        });
      })
      .catch(function(){});

    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(function(reg) {
        console.log('[SW] 注册成功，scope:', reg.scope);
        // 检测到新版本时自动激活（配合 sw.js 的 skipWaiting）
        reg.addEventListener('updatefound', function() {
          var newWorker = reg.installing;
          newWorker.addEventListener('statechange', function() {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // 新版本已安装，强制激活
              newWorker.postMessage('SKIP_WAITING');
              console.log('[SW] 新版本已就绪，强制激活');
            }
          });
        });
        // 主动检查更新（启动时立即一次 + 每 10 分钟一次，不等浏览器默认 24h）
        function checkUpdate() {
          reg.update().catch(function(e) {
            console.warn('[SW] 更新检查失败:', e.message);
          });
        }
        checkUpdate();
        setInterval(checkUpdate, 10 * 60 * 1000);  // 10 分钟
        // 页面重新可见时也检查（用户切回 Tab）
        document.addEventListener('visibilitychange', function() {
          if (document.visibilityState === 'visible') checkUpdate();
        });
      })
      .catch(function(e) {
        console.warn('[SW] 注册失败:', e.message);
      });
    // 监听控制器变更，自动刷新页面加载新版本（已登录才立即刷，未登录延后）
    // v6.5.6 修复：使用统一 RefreshGuard，绝对禁止登录过程中刷新
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function() {
      if (refreshing) return;
      if (__shouldBlockRefresh('SW controllerchange')) {
        // 登录中/登录页：延后到登录成功后再刷新（监听正确的 TOKEN_KEY）
        console.log('[SW] controllerchange → 登录保护中，延后到登录成功后再检查');
        var checkAuth = setInterval(function() {
          if (__shouldBlockRefresh('SW controllerchange (poll)')) return;  // 仍在登录流程，继续等
          clearInterval(checkAuth);
          if (!refreshing) {
            refreshing = true;
            window.location.reload();
          }
        }, 3000);
        setTimeout(function(){ clearInterval(checkAuth); }, 60 * 60 * 1000);  // 最多等1小时
        return;
      }
      refreshing = true;
      window.location.reload();
    });
    // 监听 SW 主动通知（sw.js install/activate 时 broadcastUpdate 发送）
    navigator.serviceWorker.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'SW_UPDATED') {
        console.log('[SW] 收到新版本通知:', event.data.version);
        // v6.5.6 修复：不自动刷新，完全交给 controllerchange + RefreshGuard 控制
        // 避免 SW_UPDATED 消息在登录时触发延迟刷新
        console.log('[SW] 新版本通知 → 等待 controllerchange 自然触发（RefreshGuard 保护中）');
      }
    });
  });
}

// v6.4.5 紧急逃生舱：如果检测到当前页面缺少关键函数（说明被旧 SW 缓存了旧 HTML），
// 主动清掉所有 SW 缓存 + 注销 SW + 强制刷新，确保用户能拿到最新页面
// v6.5.2 增强：版本指纹自检（即使函数都在，版本号落后也刷新）
// v6.5.6 完全重写：使用统一 RefreshGuard，关键函数检查延后到 window.onload 后
(function versionSelfCheck() {
  function forceRefresh(reason) {
    // v6.5.6：统一使用 RefreshGuard，三层拦截（输密码/宽限期/登录页未登录）
    if (__shouldBlockRefresh(reason)) {
      console.warn('[VersionCheck] ' + reason + ' → 登录保护中，延后 30 分钟再检查');
      setTimeout(versionSelfCheck, 30 * 60 * 1000);
      return;
    }
    console.warn('[VersionCheck] ' + reason + '，清缓存并刷新');
    if ('caches' in window) {
      caches.keys().then(function(names) {
        names.forEach(function(n) { caches.delete(n); });
      });
    }
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistrations().then(function(regs) {
        regs.forEach(function(r) { r.unregister(); });
        setTimeout(function() { window.location.reload(true); }, 500);
      });
    } else {
      setTimeout(function() { window.location.reload(true); }, 500);
    }
  }
  // ------- v6.5.6 修复：关键函数缺失检查延后到 load 事件后 -------
  // 之前的问题：IIFE 执行时函数还没定义（JS 还没执行到后面）→ 误判 → 误触发刷新
  function runChecks() {
    // 1. 关键函数缺失 → 立即刷新（旧 HTML 缓存）
    if (typeof loadEngDashboard !== 'function' || typeof openMaintenance !== 'function') {
      forceRefresh('关键函数缺失，疑似旧 SW 缓存');
      return;
    }
    // 2. 版本指纹自检（不影响首屏渲染，给登录留时间）
    setTimeout(function() {
      var meta = document.querySelector('meta[name="app-version"]');
      if (!meta) {
        forceRefresh('未找到版本指纹');
        return;
      }
      var currentVersion = meta.getAttribute('content');
      fetch('/api/health', { cache: 'no-store' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var serverVersion = 'qiezi-v' + data.version;
          if (serverVersion !== currentVersion) {
            forceRefresh('版本落后（当前 ' + currentVersion + '，服务器 ' + serverVersion + '）');
          } else {
            console.log('[VersionCheck] 版本一致:', currentVersion);
          }
        })
        .catch(function() {});  // 网络失败静默
    }, 10000);  // v6.5.6：5s → 10s，给登录留更充足时间
  }
  if (document.readyState === 'complete') {
    runChecks();
  } else {
    window.addEventListener('load', runChecks);
  }
})();

// PWA 安装提示：捕获 beforeinstallprompt，延迟到用户点击时触发
var deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  console.log('[PWA] 可安装提示已捕获，待用户触发');
  // 在设置抽屉显示安装入口（仅当未安装时）
  document.querySelectorAll('#pwaInstallEntry, #pwaInstallEntry2').forEach(function(el){ el.style.display = 'flex'; });
});

async function triggerPwaInstall() {
  if (!deferredInstallPrompt) {
    alert('ℹ️ 当前环境不支持安装\niOS：用 Safari 分享按钮 → 添加到主屏幕\nAndroid Chrome：菜单 → 添加到主屏幕');
    return;
  }
  deferredInstallPrompt.prompt();
  var choice = await deferredInstallPrompt.userChoice;
  if (choice.outcome === 'accepted') {
    console.log('[PWA] 用户已安装');
    document.querySelectorAll('#pwaInstallEntry, #pwaInstallEntry2').forEach(function(el){ el.style.display = 'none'; });
  }
  deferredInstallPrompt = null;
}

// 已安装则隐藏入口
window.addEventListener('appinstalled', function() {
  document.querySelectorAll('#pwaInstallEntry, #pwaInstallEntry2').forEach(function(el){ el.style.display = 'none'; });
  console.log('[PWA] 应用已安装');
});
