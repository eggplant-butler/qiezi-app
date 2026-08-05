// ============================================================
// 茄子管家 Service Worker
// 策略：
//   - HTML 文档：network-first（保证版本更新即时生效，避免旧版本卡死）
//   - 静态资源（JS/CSS/图片/字体）：cache-first（命中即返回，后台更新）
//   - API 请求（/api/*）：network-only（数据绝不缓存，保证实时性）
//   - 离线兜底：HTML 缓存命中时返回离线页面
// 版本号变更会触发 activate 清理旧缓存
// ============================================================

const SW_VERSION = 'qiezi-v6.5.4';
const SW_CACHE_PREFIX = 'qiezi-sw-';
const SW_CACHE_CURRENT = SW_CACHE_PREFIX + SW_VERSION;

// 预缓存清单：仅核心 HTML（首屏必需）
const PRECACHE_URLS = [
  './',
  './index.html'
];

// ============ install：预缓存 + 立即激活 + 通知客户端刷新 ============
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SW_CACHE_CURRENT)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())  // 跳过等待，立即接管
      .then(() => broadcastUpdate())   // 通知所有客户端有新版本
  );
});

// ============ activate：清理旧版本缓存 + 立即接管 + 通知刷新 ============
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((key) => key.startsWith(SW_CACHE_PREFIX) && key !== SW_CACHE_CURRENT)
            .map((key) => caches.delete(key))  // 删除旧版本缓存
        );
      })
      .then(() => self.clients.claim())  // 立即接管所有客户端
      .then(() => broadcastUpdate())     // 再次通知（保险）
  );
});

// ============ 通知所有客户端：有新版本，请刷新 ============
async function broadcastUpdate() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => {
    client.postMessage({ type: 'SW_UPDATED', version: SW_VERSION });
  });
}

// ============ fetch：按请求类型路由 ============
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 仅处理 GET 请求（POST/PUT/DELETE 直接走网络）
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 同源检查：跨域请求直接放行
  if (url.origin !== self.location.origin) return;

  // 策略 1：API 请求 - network-only（数据绝不缓存）
  if (url.pathname.startsWith('/api/')) {
    return;  // 不调用 event.respondWith，走默认网络请求
  }

  // 策略 2：HTML 文档 - network-first（保证版本更新即时生效）
  const isHTML = req.destination === 'document' ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html');

  if (isHTML) {
    event.respondWith(networkFirst(req));
    return;
  }

  // 策略 3：其他静态资源 - cache-first（命中即返回，后台静默更新）
  event.respondWith(cacheFirst(req));
});

// ============ network-first：先请求网络，失败回退缓存 ============
async function networkFirst(req) {
  try {
    const networkResp = await fetch(req);
    // 网络成功：更新缓存后返回
    if (networkResp && networkResp.ok) {
      const cache = await caches.open(SW_CACHE_CURRENT);
      cache.put(req, networkResp.clone());
    }
    return networkResp;
  } catch (e) {
    // 网络失败：回退缓存（离线场景）
    const cached = await caches.match(req);
    if (cached) return cached;
    // 缓存也 miss：返回根页面缓存作为兜底
    const rootCache = await caches.match('./index.html');
    if (rootCache) return rootCache;
    // 彻底没有：返回简单离线提示
    return new Response(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">' +
      '<h1>🍆</h1><p>当前离线，请检查网络后重试</p></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// ============ cache-first：先查缓存，命中即返回，后台静默更新 ============
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    // 后台静默更新缓存（不阻塞响应）
    fetch(req).then((resp) => {
      if (resp && resp.ok) {
        caches.open(SW_CACHE_CURRENT).then((cache) => cache.put(req, resp));
      }
    }).catch(() => {});
    return cached;
  }
  // 缓存 miss：走网络
  try {
    const networkResp = await fetch(req);
    if (networkResp && networkResp.ok) {
      const cache = await caches.open(SW_CACHE_CURRENT);
      cache.put(req, networkResp.clone());
    }
    return networkResp;
  } catch (e) {
    // 彻底失败
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// ============ 消息通信：前端可触发立即更新 ============
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
