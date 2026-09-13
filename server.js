const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const usersFile = path.join(DATA, 'users.json');
const sessionsFile = path.join(DATA, 'sessions.json');

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function write(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function headers() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  };
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers() });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > 1e6) { req.destroy(); reject(new Error('Request too large')); }
    });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    gender: u.gender,
    bio: u.bio || '',
    createdAt: u.createdAt
  };
}
function auth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  const sessions = read(sessionsFile, {});
  const s = sessions[token];
  if (!s) return null;
  const users = read(usersFile, []);
  return users.find(u => u.id === s.userId) || null;
}
function validEmail(x) {
  return typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
}
function safePath(urlPath) {
  const pathname = decodeURIComponent(urlPath);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(ROOT, relative);
  return full.startsWith(ROOT + path.sep) || full === ROOT ? full : null;
}
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};
function staticFile(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const file = safePath(u.pathname);
  if (!file) return json(res, 403, { error: 'Forbidden' });
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers());
    return res.end();
  }
  try {
    if (req.url === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, service: 'Blizz API' });
    }
    if (req.url === '/api/signup' && req.method === 'POST') {
      const b = await body(req);
      const username = String(b.username || '').trim().toLowerCase();
      const displayName = String(b.displayName || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const gender = String(b.gender || '').trim();
      const dob = String(b.dob || '').trim();
      if (username.length < 3 || username.length > 20 || !/^[a-z0-9_.]+$/.test(username)) return json(res, 400, { error: 'Username must be 3–20 characters using letters, numbers, _ or .' });
      if (!displayName) return json(res, 400, { error: 'Display name is required' });
      if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email' });
      if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
      if (!gender) return json(res, 400, { error: 'Select a gender' });
      if (!dob) return json(res, 400, { error: 'Date of birth is required' });
      const users = read(usersFile, []);
      if (users.some(u => u.username === username)) return json(res, 409, { error: 'Username already exists' });
      if (users.some(u => u.email === email)) return json(res, 409, { error: 'Email already exists' });
      const id = crypto.randomUUID();
      const salt = crypto.randomBytes(16).toString('hex');
      const u = { id, username, displayName, email, gender, dob, passwordSalt: salt, passwordHash: hashPassword(password, salt), bio: '', createdAt: new Date().toISOString() };
      users.push(u);
      write(usersFile, users);
      const token = crypto.randomBytes(32).toString('hex');
      const sessions = read(sessionsFile, {});
      sessions[token] = { userId: id, createdAt: Date.now() };
      write(sessionsFile, sessions);
      return json(res, 201, { user: publicUser(u), token });
    }
    if (req.url === '/api/login' && req.method === 'POST') {
      const b = await body(req);
      const login = String(b.login || '').trim().toLowerCase();
      const password = String(b.password || '');
      const users = read(usersFile, []);
      const u = users.find(x => x.username === login || x.email === login);
      if (!u) return json(res, 401, { error: 'Invalid login details' });
      const check = hashPassword(password, u.passwordSalt);
      const a = Buffer.from(check, 'hex');
      const c = Buffer.from(u.passwordHash, 'hex');
      if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return json(res, 401, { error: 'Invalid login details' });
      const token = crypto.randomBytes(32).toString('hex');
      const sessions = read(sessionsFile, {});
      sessions[token] = { userId: u.id, createdAt: Date.now() };
      write(sessionsFile, sessions);
      return json(res, 200, { user: publicUser(u), token });
    }
    if (req.url === '/api/me' && req.method === 'GET') {
      const u = auth(req);
      if (!u) return json(res, 401, { error: 'Not signed in' });
      return json(res, 200, { user: publicUser(u) });
    }
    if (req.url === '/api/profile' && req.method === 'POST') {
      const u = auth(req);
      if (!u) return json(res, 401, { error: 'Not signed in' });
      const b = await body(req);
      const users = read(usersFile, []);
      const i = users.findIndex(x => x.id === u.id);
      if (i < 0) return json(res, 404, { error: 'User not found' });
      if (b.displayName !== undefined) users[i].displayName = String(b.displayName).trim().slice(0, 60);
      if (b.bio !== undefined) users[i].bio = String(b.bio).slice(0, 160);
      write(usersFile, users);
      return json(res, 200, { user: publicUser(users[i]) });
    }
    if (req.url === '/api/logout' && req.method === 'POST') {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : null;
      const sessions = read(sessionsFile, {});
      if (token) delete sessions[token];
      write(sessionsFile, sessions);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return staticFile(req, res);
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Blizz listening on port ${PORT}`));
