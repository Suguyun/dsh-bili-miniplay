// B站浮窗插件 — Host 端
// 固化模式：webServer HTTP 路由（bundle 环境不依赖动态插件的 harness/host.call）
// 跨平台修复：原版依赖 Windows 的 curl.exe / powershell.exe / cwd C:\，macOS 不可用。
// 本版改用 Node 20+ 原生 fetch（Node 24 验证通过），不再调用任何外部子进程。
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// 持久化数据目录：~/.dsh/bili-data/
const DATA_DIR = path.join(homedir(), '.dsh', 'bili-data')
const FOLLOWS_FILE = path.join(DATA_DIR, 'follows.json')
const HISTORY_FILE = path.join(DATA_DIR, 'history.json')
const LOGIN_FILE = path.join(DATA_DIR, 'login.json')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'

function ensureDir() {
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch (e) { console.error('[bili] ensureDir error:', e.message) }
}
function loadJson(path, fb) {
  try { if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) } catch (e) {}
  return fb
}
function saveJson(path, data) {
  try { ensureDir(); writeFileSync(path, JSON.stringify(data), 'utf8') } catch (e) { console.error('[bili] saveJson error:', e.message) }
}

// 加载持久化数据
let follows = loadJson(FOLLOWS_FILE, {})  // { mid: { name, face, latest_bvid } }
let watchHistory = loadJson(HISTORY_FILE, [])  // [{ bvid, aid, title, pic, author, at }]

// 声明所需服务：本插件只需要 webServer（网络层已改为原生 fetch）
export const inject = ['webServer']

function apply(ctx) {
  const webServer = ctx.webServer
  if (webServer === undefined) return

  let buv = ''
  let cookieHeader = ''
  const picCache = new Map()
  const fetchCache = new Map()

  let cookieReady = false
  let cookiePromise = null

  // 从 bilibili.com 首页 set-cookie 里拿 buvid3 / b_nut 等，提升接口耐受度
  async function refreshBuvid() {
    try {
      const r = await fetch('https://www.bilibili.com', {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      })
      const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [])
        .map(function (c) { return c.split(';')[0] })
        .filter(Boolean)
        .join('; ')
      if (cookies) {
        cookieHeader = cookies
        const m = cookies.match(/buvid3=([^;]+)/)
        if (m) { buv = m[1]; console.log('[bili] buvid3:', buv.slice(0, 8) + '...') }
      }
    } catch (e) { console.error('[bili] refreshBuvid error:', e && e.message || e) }
    cookieReady = true
  }
  cookiePromise = refreshBuvid()

  // ===== 可选登录状态（走 DSH credentials 安全存储，缺失时退回本地文件）=====
  // 登录态存 ~/.dsh/bili-data/ 或 DSH credentials 记录，两者都在 git 仓库之外。
  const cred = ctx.get('credentials')          // 可选服务，不存在则用本地文件
  const LOGIN_CRED_KEY = '@dsh-external/dsh-bili-miniplay/bilibili'  // <scope>/<id>
  let loginCookie = ''                          // SESSDATA=..; bili_jct=..; DedeUserID=..
  let loginQrKey = ''

  // 从 poll 的 Set-Cookie 里提取登录相关 cookie
  function cookieToCookieStr(setCookies) {
    const keep = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']
    const parts = []
    for (const c of setCookies) {
      const m = String(c).match(/^\s*([A-Za-z0-9_]+)=([^;]*)/)
      if (m && keep.indexOf(m[1]) >= 0 && m[2]) parts.push(m[1] + '=' + m[2])
    }
    return parts.join('; ')
  }
  async function loadLogin() {
    if (cred) {
      try {
        const rec = await cred.readRecord(LOGIN_CRED_KEY)
        if (rec && rec.kind === 'grant' && rec.payload && rec.payload.cookie) loginCookie = rec.payload.cookie
        return
      } catch (e) { console.error('[bili] readRecord error:', e && e.message || e) }
    }
    try { if (existsSync(LOGIN_FILE)) { const x = JSON.parse(readFileSync(LOGIN_FILE, 'utf8')); if (x && x.cookie) loginCookie = x.cookie } } catch (e) {}
  }
  async function saveLogin(cookie) {
    loginCookie = cookie || ''
    if (cred) {
      try { await cred.modifyRecord(LOGIN_CRED_KEY, async function () { return { kind: 'grant', payload: { cookie: cookie || '' } } }); return } catch (e) { console.error('[bili] modifyRecord error:', e && e.message || e) }
    }
    try { ensureDir(); writeFileSync(LOGIN_FILE, JSON.stringify({ cookie: cookie || '' }), 'utf8') } catch (e) { console.error('[bili] saveLogin error:', e && e.message || e) }
  }
  async function clearLogin() {
    loginCookie = ''
    if (cred) { try { await cred.deleteRecord(LOGIN_CRED_KEY); return } catch (e) { console.error('[bili] deleteRecord error:', e && e.message || e) } }
    try { if (existsSync(LOGIN_FILE)) unlinkSync(LOGIN_FILE) } catch (e) {}
  }
  loadLogin()

  function norm(v) {
    return {
      bvid: v.bvid || '',
      aid: v.aid || 0,
      title: String(v.title || '').replace(/<[^>]+>/g, ''),
      pic: v.pic || '',
      duration: v.duration != null ? v.duration : 0,
      author: (v.owner && v.owner.name) || v.author || '',
      mid: (v.owner && v.owner.mid) || v.mid || 0,
      face: (v.owner && v.owner.face) || v.face || '',
      play: (v.stat && v.stat.view != null) ? v.stat.view : (v.play || 0),
      danmaku: (v.stat && v.stat.danmaku != null) ? v.stat.danmaku : (v.video_review || 0),
      pubdate: v.pubdate != null ? v.pubdate : 0,
    }
  }

  // 用原生 fetch 拉取 B 站接口文本，携带浏览器头与 buvid cookie
  async function httpGet(url) {
    if (!cookieReady && cookiePromise) await cookiePromise
    const headers = {
      'User-Agent': UA,
      'Referer': 'https://search.bilibili.com/all',
      'Origin': 'https://www.bilibili.com/',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    let cookieVal = cookieHeader || ''
    if (loginCookie) cookieVal = cookieVal ? cookieVal + '; ' + loginCookie : loginCookie
    if (cookieVal) headers['Cookie'] = cookieVal
    try {
      const r = await fetch(url.replace(/^http:\/\//, 'https://'), {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      })
      const text = await r.text()
      if (!text) console.error('[bili] httpGet empty:', url, 'status:', r.status)
      return text
    } catch (e) {
      console.error('[bili] httpGet error:', e && e.message || e)
      return ''
    }
  }

  async function fetchJson(url) {
    const now = Date.now()
    const hit = fetchCache.get(url)
    if (hit && (now - hit.ts) < 120000) return hit.data
    for (let i = 0; i < 2; i++) {
      const text = await httpGet(url)
      try {
        const obj = JSON.parse(text)
        if (obj && obj.code === 0) {
          fetchCache.set(url, { ts: Date.now(), data: obj })
          if (fetchCache.size > 60) fetchCache.delete(fetchCache.keys().next().value)
          return obj
        }
      } catch (e) {
        console.error('[bili] fetchJson error:', e && e.message || e)
      }
      buv = randomUUID()
    }
    return null
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(''))
    })
  }

  function sendJson(res, status, data) {
    const text = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  }

  function mimeOf(url) {
    const m = url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i)
    const map = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
    return map[(m && m[1].toLowerCase()) || 'jpeg'] || 'image/jpeg'
  }

  // 用原生 fetch 拉取图片并转 base64（替代原 powershell.exe 方案）
  async function downloadPicB64(url) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(15000),
      })
      if (!r.ok) return ''
      const buf = Buffer.from(await r.arrayBuffer())
      return buf.toString('base64')
    } catch (e) {
      console.error('[bili] downloadPic error:', e && e.message || e)
      return ''
    }
  }

  // ===== 原有 API =====
  webServer.register({
    kind: 'bili2-fetch',
    path: '/api/bili2/fetch',
    handler: async (req, res) => {
      try {
        const q = new URL(req.url, 'http://localhost').searchParams
        const kind = q.get('kind')
        let api = ''
        if (kind === 'hot') api = 'http://api.bilibili.com/x/web-interface/popular?ps=20&pn=' + (q.get('pn') || 1)
        else if (kind === 'rank') api = 'http://api.bilibili.com/x/web-interface/ranking/v2?rid=' + (q.get('rid') || 0) + '&type=all'
        else if (kind === 'search') api = 'http://api.bilibili.com/x/web-interface/search/type?search_type=' + encodeURIComponent(q.get('search_type') || 'video') + '&page=' + (q.get('page') || 1) + '&keyword=' + encodeURIComponent(q.get('keyword') || '')
        else if (kind === 'follow-videos') api = 'http://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(q.get('name') || q.get('mid') || '') + '&userid=' + encodeURIComponent(q.get('mid') || '') + '&page=' + (q.get('pn') || 1)
        else if (kind === 'upper-videos') api = 'http://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(q.get('name') || '') + '&userid=' + encodeURIComponent(q.get('mid') || '') + '&page=' + (q.get('pn') || 1) + '&order=pubdate'
        else return sendJson(res, 400, { error: 'bad kind' })
        const obj = await fetchJson(api)
        if (!obj || !obj.data) return sendJson(res, 502, { error: 'bilibili api failed' })
        const raw = (kind === 'search' || kind === 'upper-videos' || kind === 'follow-videos') ? (obj.data.result || []) : (obj.data.list || [])
        sendJson(res, 200, { list: raw.map(norm) })
      } catch (e) {
        sendJson(res, 500, { error: String(e && e.message || e) })
      }
    },
  })

  webServer.register({
    kind: 'bili2-pic',
    path: '/api/bili2/pic',
    handler: async (req, res) => {
      try {
        const q = new URL(req.url, 'http://localhost').searchParams
        const pic = q.get('url')
        if (!pic) return sendJson(res, 400, { error: 'no url' })
        if (!/^https?:\/\/[^'"]+\.(jpg|jpeg|png|gif|webp)/i.test(pic)) return sendJson(res, 400, { error: 'invalid url' })
        if (picCache.has(pic)) return sendJson(res, 200, { data: picCache.get(pic) })
        const b64 = await downloadPicB64(pic)
        if (!b64) return sendJson(res, 502, { error: 'pic download failed' })
        const data = 'data:' + mimeOf(pic) + ';base64,' + b64
        picCache.set(pic, data)
        sendJson(res, 200, { data })
      } catch (e) {
        sendJson(res, 500, { error: String(e && e.message || e) })
      }
    },
  })

  // ===== 可选扫码登录 API =====
  async function qrImageB64(qrUrl) {
    try {
      const r = await fetch('https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=' + encodeURIComponent(qrUrl), { signal: AbortSignal.timeout(12000) })
      if (!r.ok) return ''
      const buf = Buffer.from(await r.arrayBuffer())
      return 'data:image/png;base64,' + buf.toString('base64')
    } catch (e) { console.error('[bili] qrImage error:', e && e.message || e); return '' }
  }

  webServer.register({
    kind: 'bili2-login-qr',
    path: '/api/bili2/login/qr',
    handler: async (req, res) => {
      try {
        const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
          headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com/' },
          signal: AbortSignal.timeout(15000),
        })
        const j = await r.json()
        if (!j || j.code !== 0 || !j.data || !j.data.qrcode_key) return sendJson(res, 502, { error: 'qr generate failed' })
        loginQrKey = j.data.qrcode_key
        const img = await qrImageB64(j.data.url)
        sendJson(res, 200, { qrcode_key: j.data.qrcode_key, img: img || '' })
      } catch (e) { sendJson(res, 500, { error: String(e && e.message || e) }) }
    },
  })

  webServer.register({
    kind: 'bili2-login-poll',
    path: '/api/bili2/login/poll',
    handler: async (req, res) => {
      try {
        const q = new URL(req.url, 'http://localhost').searchParams
        const key = q.get('key') || loginQrKey
        if (!key) return sendJson(res, 400, { error: 'no key' })
        const headers = { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com/' }
        if (cookieHeader) headers['Cookie'] = cookieHeader
        const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key), { headers, signal: AbortSignal.timeout(15000) })
        const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : []
        const j = await r.json()
        const inner = (j && j.data) || {}
        const code = inner.code
        if (code === 0) {
          const cookieStr = cookieToCookieStr(setCookies)
          if (cookieStr) await saveLogin(cookieStr)
          return sendJson(res, 200, { status: 'success', loggedIn: !!loginCookie })
        }
        if (code === 86090) return sendJson(res, 200, { status: 'scanned' })
        if (code === 86038) return sendJson(res, 200, { status: 'expired' })
        return sendJson(res, 200, { status: 'pending' })
      } catch (e) { sendJson(res, 500, { error: String(e && e.message || e) }) }
    },
  })

  webServer.register({
    kind: 'bili2-login-status',
    path: '/api/bili2/login/status',
    handler: async (req, res) => { return sendJson(res, 200, { loggedIn: !!loginCookie }) },
  })

  webServer.register({
    kind: 'bili2-login-logout',
    path: '/api/bili2/login/logout',
    handler: async (req, res) => { await clearLogin(); return sendJson(res, 200, { ok: true }) },
  })

  // ===== 关注列表持久化 API =====
  // GET /api/bili2/follows — 获取关注列表
  webServer.register({
    kind: 'bili2-follows',
    path: '/api/bili2/follows',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        return sendJson(res, 200, { follows: Object.values(follows) })
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        try {
          const item = JSON.parse(body)
          if (!item || !item.mid || !item.name) return sendJson(res, 400, { error: 'missing mid or name' })
          follows[item.mid] = { mid: item.mid, name: item.name, face: item.face || '', latest_bvid: item.latest_bvid || '' }
          saveJson(FOLLOWS_FILE, follows)
          return sendJson(res, 200, { ok: true })
        } catch (e) {
          return sendJson(res, 400, { error: 'bad json' })
        }
      }
      if (req.method === 'DELETE') {
        const q = new URL(req.url, 'http://localhost').searchParams
        const mid = q.get('mid')
        if (!mid || !follows[mid]) return sendJson(res, 404, { error: 'not found' })
        delete follows[mid]
        saveJson(FOLLOWS_FILE, follows)
        return sendJson(res, 200, { ok: true })
      }
      sendJson(res, 405, { error: 'method not allowed' })
    },
  })

  // GET /api/bili2/history — 获取持久化观看历史
  webServer.register({
    kind: 'bili2-history',
    path: '/api/bili2/history',
    handler: async (req, res) => {
      if (req.method === 'POST') {
        const body = await readBody(req)
        try {
          const item = JSON.parse(body)
          if (!item || !item.bvid) return sendJson(res, 400, { error: 'missing bvid' })
          const entry = {
            bvid: item.bvid || '',
            aid: item.aid || 0,
            title: item.title || '',
            pic: item.pic || '',
            author: item.author || '',
            at: Date.now(),
          }
          watchHistory = watchHistory.filter(function (h) { return h.bvid !== entry.bvid })
          watchHistory.unshift(entry)
          if (watchHistory.length > 200) watchHistory = watchHistory.slice(0, 200)
          saveJson(HISTORY_FILE, watchHistory)
          return sendJson(res, 200, { ok: true })
        } catch (e) {
          return sendJson(res, 400, { error: 'bad json' })
        }
      }
      return sendJson(res, 200, { history: watchHistory })
    },
  })
}

export { apply }
