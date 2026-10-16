const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const archiver = require("archiver");
const cookieParser = require("cookie-parser");
const selfsigned = require("selfsigned");

let sharp = null;
try {
  sharp = require("sharp");
} catch {
  console.warn("sharp 없음 — 썸네일 없이 진행합니다.");
}

const PORT = Number(process.env.PORT) || 3443;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3080;
const ROOT = __dirname;
const UPLOADS = path.join(ROOT, "uploads");
const THUMBS = path.join(UPLOADS, ".thumbs");
const DATA_DIR = path.join(ROOT, "data");
const META_FILE = path.join(DATA_DIR, "metadata.json");
const SHARES_FILE = path.join(DATA_DIR, "shares.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const CERTS_DIR = path.join(ROOT, "certs");
const COOKIE_NAME = "pu_session";
const SESSION_MS = 400 * 24 * 60 * 60 * 1000; // ~13개월, 등록 장치 유지

for (const dir of [UPLOADS, THUMBS, DATA_DIR, CERTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function loadMeta() {
  return loadJson(META_FILE, {});
}
function saveMeta(meta) {
  saveJson(META_FILE, meta);
}
function loadShares() {
  return loadJson(SHARES_FILE, {});
}
function saveShares(shares) {
  saveJson(SHARES_FILE, shares);
}

function loadConfig() {
  const cfg = loadJson(CONFIG_FILE, {});
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString("hex");
    saveJson(CONFIG_FILE, cfg);
  }
  // 환경변수로 비밀번호 부트스트랩
  if (process.env.PHOTO_PASSWORD && !cfg.passwordHash) {
    cfg.passwordHash = hashPassword(process.env.PHOTO_PASSWORD);
    saveJson(CONFIG_FILE, cfg);
  }
  return cfg;
}

function saveConfig(cfg) {
  saveJson(CONFIG_FILE, cfg);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const next = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(next, "hex"));
  } catch {
    return false;
  }
}

function authEnabled(cfg = loadConfig()) {
  return Boolean(cfg.passwordHash);
}

function loadDevices() {
  return loadJson(DEVICES_FILE, {});
}

function saveDevices(devices) {
  saveJson(DEVICES_FILE, devices);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function makeSessionToken(deviceId, cfg = loadConfig()) {
  const exp = Date.now() + SESSION_MS;
  const payload = `ok.${deviceId}.${exp}`;
  const sig = crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function parseSessionToken(token, cfg = loadConfig()) {
  if (!token) return null;
  const parts = String(token).split(".");
  // ok.deviceId.exp.sig  (deviceId has no dots — hex id)
  if (parts.length !== 4) {
    // 구버전 ok.exp.sig 호환 거부 (장치 등록 필요로 재로그인)
    return null;
  }
  const [kind, deviceId, exp, sig] = parts;
  const payload = `${kind}.${deviceId}.${exp}`;
  const expect = crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  if (kind !== "ok" || Number(exp) < Date.now()) return null;
  return { deviceId, exp: Number(exp) };
}

function verifySessionToken(token, cfg = loadConfig()) {
  const parsed = parseSessionToken(token, cfg);
  if (!parsed) return false;
  const devices = loadDevices();
  const dev = devices[parsed.deviceId];
  if (!dev || dev.revoked) return false;
  if (dev.tokenHash && dev.tokenHash !== hashToken(token)) return false;
  return true;
}

function getSessionFromReq(req) {
  return req.cookies?.[COOKIE_NAME] || req.headers["x-session"] || "";
}

function touchDevice(deviceId, token) {
  const devices = loadDevices();
  if (!devices[deviceId] || devices[deviceId].revoked) return;
  devices[deviceId].lastSeenAt = new Date().toISOString();
  if (token) devices[deviceId].tokenHash = hashToken(token);
  saveDevices(devices);
}

function registerDevice({ deviceId, deviceName, userAgent, token }) {
  const id = deviceId || crypto.randomBytes(16).toString("hex");
  const devices = loadDevices();
  const now = new Date().toISOString();
  devices[id] = {
    id,
    name: String(deviceName || "알 수 없는 장치").slice(0, 80),
    userAgent: String(userAgent || "").slice(0, 200),
    createdAt: devices[id]?.createdAt || now,
    lastSeenAt: now,
    revoked: false,
    tokenHash: hashToken(token),
  };
  saveDevices(devices);
  return id;
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: SESSION_MS,
  });
}

function makeShareAccessToken(shareToken, cfg = loadConfig()) {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const payload = `share.${shareToken}.${exp}`;
  const sig = crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyShareAccessToken(raw, shareToken, cfg = loadConfig()) {
  if (!raw) return false;
  const parts = String(raw).split(".");
  if (parts.length !== 4) return false;
  const [kind, tok, exp, sig] = parts;
  const payload = `${kind}.${tok}.${exp}`;
  const expect = crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  } catch {
    return false;
  }
  return kind === "share" && tok === shareToken && Number(exp) >= Date.now();
}

function safeRel(rel = "") {
  const cleaned = String(rel)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .join("/");
  const abs = path.resolve(UPLOADS, cleaned);
  const root = path.resolve(UPLOADS);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("잘못된 경로입니다.");
  }
  return { rel: cleaned, abs };
}

function thumbRelPath(rel) {
  return rel;
}

function thumbAbs(rel) {
  return path.join(THUMBS, thumbRelPath(rel));
}

function fileUrl(rel) {
  return `/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

function thumbUrl(rel) {
  return `/thumbs/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

async function ensureThumb(rel) {
  if (!sharp) return null;
  const src = safeRel(rel).abs;
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return null;
  const dest = thumbAbs(rel);
  if (fs.existsSync(dest)) return thumbUrl(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await sharp(src)
      .rotate()
      .resize(480, 480, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toFile(dest);
    return thumbUrl(rel);
  } catch (err) {
    console.warn("썸네일 실패", rel, err.message);
    return null;
  }
}

function listDir(rel = "") {
  const { abs, rel: safe } = safeRel(rel);
  if (!fs.existsSync(abs)) return { folders: [], photos: [] };

  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const meta = loadMeta();
  const folders = [];
  const photos = [];

  for (const e of entries) {
    if (e.name === ".thumbs") continue;
    const childRel = safe ? `${safe}/${e.name}` : e.name;
    if (e.isDirectory()) {
      folders.push({ name: e.name, path: childRel });
    } else if (/\.(jpe?g|png|webp|gif|heic)$/i.test(e.name)) {
      const st = fs.statSync(path.join(abs, e.name));
      const info = meta[childRel] || {};
      const tAbs = thumbAbs(childRel);
      photos.push({
        name: e.name,
        path: childRel,
        url: fileUrl(childRel),
        thumbUrl: fs.existsSync(tAbs) ? thumbUrl(childRel) : fileUrl(childRel),
        size: st.size,
        mtime: st.mtimeMs,
        lat: info.lat ?? null,
        lng: info.lng ?? null,
        accuracy: info.accuracy ?? null,
        takenAt: info.takenAt || st.mtime.toISOString(),
        folder: safe,
      });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  photos.sort((a, b) => b.mtime - a.mtime);
  return { path: safe, folders, photos };
}

function collectAllPhotos(rel = "", acc = []) {
  const listed = listDir(rel);
  acc.push(...listed.photos);
  for (const f of listed.folders) collectAllPhotos(f.path, acc);
  return acc;
}

function moveOneFile(fromRel, toFolderRel) {
  const { abs: fromAbs, rel: fromSafe } = safeRel(fromRel);
  if (!fromSafe || !fs.existsSync(fromAbs) || !fs.statSync(fromAbs).isFile()) {
    throw new Error(`사진을 찾을 수 없습니다: ${fromRel}`);
  }
  const { abs: toDirAbs, rel: toFolderSafe } = safeRel(toFolderRel || "");
  if (!fs.existsSync(toDirAbs)) fs.mkdirSync(toDirAbs, { recursive: true });

  const fileName = path.basename(fromAbs);
  let destName = fileName;
  let toAbs = path.join(toDirAbs, destName);
  let toRel = toFolderSafe ? `${toFolderSafe}/${destName}` : destName;

  if (path.resolve(fromAbs) === path.resolve(toAbs)) {
    return { skipped: true, path: fromSafe };
  }

  if (fs.existsSync(toAbs)) {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    destName = `${stem}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    toAbs = path.join(toDirAbs, destName);
    toRel = toFolderSafe ? `${toFolderSafe}/${destName}` : destName;
  }

  fs.renameSync(fromAbs, toAbs);
  const oldThumb = thumbAbs(fromSafe);
  if (fs.existsSync(oldThumb)) {
    try {
      fs.mkdirSync(path.dirname(thumbAbs(toRel)), { recursive: true });
      fs.renameSync(oldThumb, thumbAbs(toRel));
    } catch {
      try {
        fs.unlinkSync(oldThumb);
      } catch (_) {}
      ensureThumb(toRel);
    }
  } else {
    ensureThumb(toRel);
  }

  const meta = loadMeta();
  const prev = meta[fromSafe] || {};
  delete meta[fromSafe];
  meta[toRel] = { ...prev };
  saveMeta(meta);
  return { path: toRel, name: destName, from: fromSafe };
}

function resolveUnderShare(shareRoot, subPath = "") {
  const { rel: root } = safeRel(shareRoot || "");
  const { rel: sub } = safeRel(subPath || "");
  const full = root ? (sub ? `${root}/${sub}` : root) : sub;
  const { rel, abs } = safeRel(full);
  if (root && rel !== root && !rel.startsWith(`${root}/`)) {
    throw new Error("이 공유 링크로는 해당 폴더만 볼 수 있습니다.");
  }
  return { rel, abs, root, sub };
}

function shareAllowsPath(share, fileRel) {
  if (!share) return false;
  if (share.expiresAt && new Date(share.expiresAt).getTime() < Date.now()) return false;
  const root = safeRel(share.folder || "").rel;
  const rel = safeRel(fileRel).rel;
  if (!root) return true;
  return rel === root || rel.startsWith(`${root}/`);
}

function isShareExpired(share) {
  return Boolean(share?.expiresAt && new Date(share.expiresAt).getTime() < Date.now());
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const folder = req.body.folder || "";
      const { abs } = safeRel(folder);
      if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
      cb(null, abs);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const time = [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const rand = Math.random().toString(36).slice(2, 6);
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const folder = String(req.body.folder || "").replace(/\\/g, "/");
    const leaf = folder.split("/").filter(Boolean).pop() || "";
    const safeName = leaf
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 40);
    const base = safeName ? `${safeName}_${date}_${time}_${rand}` : `photo_${date}_${time}_${rand}`;
    cb(null, `${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/^image\//.test(file.mimetype) || /\.(jpe?g|png|webp|gif|heic)$/i.test(file.originalname || "")) {
      cb(null, true);
    } else {
      cb(new Error("이미지 파일만 업로드할 수 있습니다."));
    }
  },
});

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

function readSession(req) {
  const token = getSessionFromReq(req);
  if (!verifySessionToken(token)) return false;
  const parsed = parseSessionToken(token);
  if (parsed) touchDevice(parsed.deviceId, token);
  req.deviceId = parsed?.deviceId;
  req.sessionToken = token;
  return true;
}

function requireAuth(req, res, next) {
  const cfg = loadConfig();
  if (!authEnabled(cfg)) return next();
  if (readSession(req)) {
    // localStorage X-Session만 있어도 쿠키 갱신 → /files·/thumbs 이미지 요청에 사용
    if (!req.cookies?.[COOKIE_NAME] && req.sessionToken) {
      setSessionCookie(res, req.sessionToken);
    }
    return next();
  }
  return res.status(401).json({ error: "로그인이 필요합니다.", needAuth: true });
}

function requireFileAccess(req, res, next) {
  const cfg = loadConfig();
  if (!authEnabled(cfg)) return next();
  if (readSession(req)) return next();

  const shareTok = req.query.share;
  if (shareTok) {
    const share = loadShares()[shareTok];
    if (!share || isShareExpired(share)) {
      return res.status(403).json({ error: "공유가 만료되었거나 없습니다." });
    }
    const rel = decodeURIComponent(req.path.replace(/^\/+/, ""));
    if (!shareAllowsPath(share, rel)) {
      return res.status(403).json({ error: "이 공유로 볼 수 없는 파일입니다." });
    }
    if (share.passwordHash) {
      const access = req.cookies?.[`pu_share_${shareTok}`] || req.headers["x-share-access"];
      if (!verifyShareAccessToken(access, shareTok)) {
        return res.status(401).json({ error: "공유 비밀번호가 필요합니다.", needSharePassword: true });
      }
    }
    return next();
  }
  return res.status(401).json({ error: "로그인이 필요합니다.", needAuth: true });
}

// 공개 정적 (로그인 UI 등)
app.use(express.static(path.join(ROOT, "public")));

app.use("/files", requireFileAccess, express.static(UPLOADS, { fallthrough: false, maxAge: "1d" }));
app.use("/thumbs", requireFileAccess, express.static(THUMBS, { fallthrough: false, maxAge: "7d" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/auth/status", (req, res) => {
  const cfg = loadConfig();
  const enabled = authEnabled(cfg);
  const loggedIn = !enabled || readSession(req);
  res.json({
    authEnabled: enabled,
    loggedIn,
    canSetup: !cfg.passwordHash,
    deviceId: req.deviceId || null,
  });
});

function issueDeviceLogin(req, res, { isSetup = false } = {}) {
  const cfg = loadConfig();
  let deviceId = String(req.body.deviceId || "").replace(/[^a-f0-9]/gi, "").slice(0, 64);
  if (!deviceId || deviceId.length < 16) {
    deviceId = crypto.randomBytes(16).toString("hex");
  }
  const deviceName =
    req.body.deviceName ||
    (req.headers["user-agent"] || "장치").slice(0, 60);

  // 토큰 발급 후 장치에 등록
  const token = makeSessionToken(deviceId, cfg);
  registerDevice({
    deviceId,
    deviceName,
    userAgent: req.headers["user-agent"] || "",
    token,
  });
  setSessionCookie(res, token);
  return res.json({
    ok: true,
    token,
    deviceId,
    isSetup: Boolean(isSetup),
    message: "이 장치는 다시 로그인하지 않아도 됩니다.",
  });
}

// 최초 비밀번호 설정 + 이 장치 등록
app.post("/api/setup", (req, res) => {
  const cfg = loadConfig();
  if (cfg.passwordHash) {
    return res.status(400).json({ error: "이미 비밀번호가 설정되어 있습니다." });
  }
  const password = String(req.body.password || "");
  if (password.length < 4) {
    return res.status(400).json({ error: "비밀번호는 4자 이상이어야 합니다." });
  }
  cfg.passwordHash = hashPassword(password);
  saveConfig(cfg);
  return issueDeviceLogin(req, res, { isSetup: true });
});

app.post("/api/login", (req, res) => {
  const cfg = loadConfig();
  if (!authEnabled(cfg)) {
    return res.json({ ok: true, authEnabled: false });
  }
  if (!verifyPassword(req.body.password || "", cfg.passwordHash)) {
    return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
  }
  return issueDeviceLogin(req, res);
});

app.post("/api/logout", (req, res) => {
  const token = getSessionFromReq(req);
  const parsed = parseSessionToken(token);
  if (parsed) {
    const devices = loadDevices();
    if (devices[parsed.deviceId]) {
      devices[parsed.deviceId].revoked = true;
      devices[parsed.deviceId].revokedAt = new Date().toISOString();
      saveDevices(devices);
    }
  }
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/devices", requireAuth, (req, res) => {
  const devices = loadDevices();
  const list = Object.values(devices)
    .filter((d) => !d.revoked)
    .map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      current: d.id === req.deviceId,
    }))
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
  res.json({ devices: list, currentId: req.deviceId || null });
});

app.post("/api/devices/rename", requireAuth, (req, res) => {
  const id = String(req.body.id || "");
  const name = String(req.body.name || "").trim().slice(0, 80);
  if (!id || !name) return res.status(400).json({ error: "장치 정보가 올바르지 않습니다." });
  const devices = loadDevices();
  if (!devices[id] || devices[id].revoked) {
    return res.status(404).json({ error: "장치를 찾을 수 없습니다." });
  }
  devices[id].name = name;
  saveDevices(devices);
  res.json({ ok: true });
});

app.delete("/api/devices/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  const devices = loadDevices();
  if (!devices[id]) return res.status(404).json({ error: "장치를 찾을 수 없습니다." });
  devices[id].revoked = true;
  devices[id].revokedAt = new Date().toISOString();
  saveDevices(devices);
  res.json({ ok: true, current: id === req.deviceId });
});

app.post("/api/password", requireAuth, (req, res) => {
  const cfg = loadConfig();
  const { currentPassword, newPassword } = req.body || {};
  if (authEnabled(cfg) && !verifyPassword(currentPassword || "", cfg.passwordHash)) {
    return res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
  }
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "새 비밀번호는 4자 이상이어야 합니다." });
  }
  cfg.passwordHash = hashPassword(newPassword);
  saveConfig(cfg);
  res.json({ ok: true });
});

app.get("/api/browse", requireAuth, (req, res) => {
  try {
    res.json(listDir(req.query.path || ""));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/search", requireAuth, (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const folder = req.query.folder || "";
    let photos = folder ? listDir(folder).photos : collectAllPhotos("");
    if (q) {
      photos = photos.filter((p) => {
        const name = (p.name || "").toLowerCase();
        const taken = (p.takenAt || "").toLowerCase();
        const pathStr = (p.path || "").toLowerCase();
        return name.includes(q) || taken.includes(q) || pathStr.includes(q);
      });
    }
    res.json({ photos: photos.slice(0, 500), total: photos.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/folders", requireAuth, (req, res) => {
  try {
    const parent = req.body.parent || "";
    const name = String(req.body.name || "").trim();
    if (!name || /[\\/:*?"<>|]/.test(name)) {
      return res.status(400).json({ error: "폴더 이름이 올바르지 않습니다." });
    }
    const { abs } = safeRel(parent ? `${parent}/${name}` : name);
    if (fs.existsSync(abs)) {
      return res.status(409).json({ error: "이미 같은 이름의 폴더가 있습니다." });
    }
    fs.mkdirSync(abs, { recursive: true });
    const rel = parent ? `${safeRel(parent).rel}/${name}` : name;
    res.json({ ok: true, path: rel.replace(/\\/g, "/") });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/folders/rename", requireAuth, (req, res) => {
  try {
    const from = req.body.from || "";
    const newName = String(req.body.name || "").trim();
    if (!from) return res.status(400).json({ error: "폴더 경로가 필요합니다." });
    if (!newName || /[\\/:*?"<>|]/.test(newName)) {
      return res.status(400).json({ error: "폴더 이름이 올바르지 않습니다." });
    }
    const { abs: fromAbs, rel: fromRel } = safeRel(from);
    if (!fs.existsSync(fromAbs) || !fs.statSync(fromAbs).isDirectory()) {
      return res.status(404).json({ error: "폴더를 찾을 수 없습니다." });
    }
    const parent = fromRel.includes("/") ? fromRel.split("/").slice(0, -1).join("/") : "";
    const toRel = parent ? `${parent}/${newName}` : newName;
    const { abs: toAbs } = safeRel(toRel);
    if (fs.existsSync(toAbs)) {
      return res.status(409).json({ error: "같은 이름의 폴더가 이미 있습니다." });
    }
    fs.renameSync(fromAbs, toAbs);
    const tFrom = path.join(THUMBS, fromRel);
    const tTo = path.join(THUMBS, toRel);
    if (fs.existsSync(tFrom)) {
      fs.mkdirSync(path.dirname(tTo), { recursive: true });
      try {
        fs.renameSync(tFrom, tTo);
      } catch (_) {}
    }
    const meta = loadMeta();
    const next = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k === fromRel || k.startsWith(fromRel + "/")) {
        next[toRel + k.slice(fromRel.length)] = v;
      } else {
        next[k] = v;
      }
    }
    saveMeta(next);
    const shares = loadShares();
    for (const t of Object.keys(shares)) {
      if (shares[t].folder === fromRel) {
        shares[t].folder = toRel;
        shares[t].label = newName;
      } else if (shares[t].folder?.startsWith(fromRel + "/")) {
        shares[t].folder = toRel + shares[t].folder.slice(fromRel.length);
      }
    }
    saveShares(shares);
    res.json({ ok: true, path: toRel });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/folders", requireAuth, (req, res) => {
  try {
    const folder = req.body.path || "";
    if (!folder) return res.status(400).json({ error: "루트는 삭제할 수 없습니다." });
    const { abs, rel } = safeRel(folder);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return res.status(404).json({ error: "폴더를 찾을 수 없습니다." });
    }
    fs.rmSync(abs, { recursive: true, force: true });
    const tAbs = path.join(THUMBS, rel);
    if (fs.existsSync(tAbs)) fs.rmSync(tAbs, { recursive: true, force: true });
    const meta = loadMeta();
    for (const k of Object.keys(meta)) {
      if (k === rel || k.startsWith(rel + "/")) delete meta[k];
    }
    saveMeta(meta);
    const shares = loadShares();
    for (const t of Object.keys(shares)) {
      if (shares[t].folder === rel || shares[t].folder?.startsWith(rel + "/")) {
        delete shares[t];
      }
    }
    saveShares(shares);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/upload", requireAuth, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "파일이 없습니다." });
    const folder = req.body.folder || "";
    const { rel: folderRel } = safeRel(folder);
    const rel = folderRel ? `${folderRel}/${req.file.filename}` : req.file.filename;
    const lat = req.body.lat !== undefined && req.body.lat !== "" ? Number(req.body.lat) : null;
    const lng = req.body.lng !== undefined && req.body.lng !== "" ? Number(req.body.lng) : null;
    const accuracy =
      req.body.accuracy !== undefined && req.body.accuracy !== "" ? Number(req.body.accuracy) : null;

    const meta = loadMeta();
    meta[rel] = {
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      takenAt: req.body.takenAt || new Date().toISOString(),
      originalName: req.file.originalname || null,
    };
    saveMeta(meta);
    const thumb = await ensureThumb(rel);

    res.json({
      ok: true,
      photo: {
        name: req.file.filename,
        path: rel,
        url: fileUrl(rel),
        thumbUrl: thumb || fileUrl(rel),
        lat: meta[rel].lat,
        lng: meta[rel].lng,
        accuracy: meta[rel].accuracy,
        takenAt: meta[rel].takenAt,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/photos", requireAuth, (req, res) => {
  try {
    const { abs, rel } = safeRel(req.body.path || "");
    if (!rel || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ error: "사진을 찾을 수 없습니다." });
    }
    fs.unlinkSync(abs);
    const t = thumbAbs(rel);
    if (fs.existsSync(t)) fs.unlinkSync(t);
    const meta = loadMeta();
    delete meta[rel];
    saveMeta(meta);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/photos/delete-batch", requireAuth, (req, res) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    if (!paths.length) return res.status(400).json({ error: "삭제할 사진이 없습니다." });
    const meta = loadMeta();
    let count = 0;
    for (const p of paths) {
      try {
        const { abs, rel } = safeRel(p);
        if (!rel || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        fs.unlinkSync(abs);
        const t = thumbAbs(rel);
        if (fs.existsSync(t)) fs.unlinkSync(t);
        delete meta[rel];
        count++;
      } catch (_) {}
    }
    saveMeta(meta);
    res.json({ ok: true, count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/photos/move", requireAuth, (req, res) => {
  try {
    const moved = moveOneFile(req.body.from || req.body.path || "", req.body.toFolder || "");
    if (moved.skipped) return res.status(400).json({ error: "이미 같은 폴더에 있습니다." });
    const { abs, rel } = safeRel(moved.path);
    const st = fs.statSync(abs);
    const info = loadMeta()[rel] || {};
    res.json({
      ok: true,
      photo: {
        name: moved.name,
        path: rel,
        url: fileUrl(rel),
        thumbUrl: fs.existsSync(thumbAbs(rel)) ? thumbUrl(rel) : fileUrl(rel),
        size: st.size,
        mtime: st.mtimeMs,
        lat: info.lat ?? null,
        lng: info.lng ?? null,
        accuracy: info.accuracy ?? null,
        takenAt: info.takenAt || st.mtime.toISOString(),
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/photos/move-batch", requireAuth, (req, res) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    const toFolder = req.body.toFolder || "";
    if (!paths.length) return res.status(400).json({ error: "이동할 사진이 없습니다." });
    const results = paths.map((p) => moveOneFile(p, toFolder));
    res.json({ ok: true, count: results.filter((r) => !r.skipped).length, results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/download-zip", requireAuth, (req, res) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    if (!paths.length) return res.status(400).json({ error: "다운로드할 사진이 없습니다." });
    const files = [];
    for (const p of paths) {
      const { abs, rel } = safeRel(p);
      if (!rel || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      files.push({ abs, name: path.basename(abs) });
    }
    if (!files.length) return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="photos_${Date.now()}.zip"`);
    const archive = archiver("zip", { zlib: { level: 5 } });
    archive.on("error", (err) => console.error(err));
    archive.pipe(res);
    const used = new Set();
    for (const f of files) {
      let name = f.name;
      if (used.has(name)) name = `${used.size}_${name}`;
      used.add(name);
      archive.file(f.abs, { name });
    }
    archive.finalize();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/backup", requireAuth, (req, res) => {
  try {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="photo-backup_${new Date().toISOString().slice(0, 10)}.zip"`
    );
    const archive = archiver("zip", { zlib: { level: 3 } });
    archive.on("error", (err) => console.error(err));
    archive.pipe(res);
    archive.directory(UPLOADS, "uploads");
    if (fs.existsSync(META_FILE)) archive.file(META_FILE, { name: "data/metadata.json" });
    if (fs.existsSync(SHARES_FILE)) archive.file(SHARES_FILE, { name: "data/shares.json" });
    archive.finalize();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/shares", requireAuth, (req, res) => {
  try {
    const folder = req.body.folder !== undefined ? req.body.folder : "";
    const { rel } = safeRel(folder);
    const { abs } = safeRel(rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return res.status(404).json({ error: "폴더를 찾을 수 없습니다." });
    }

    const password = req.body.password ? String(req.body.password) : "";
    const expiresInDays = req.body.expiresInDays != null ? Number(req.body.expiresInDays) : null;

    const shares = loadShares();
    let token = Object.keys(shares).find((t) => shares[t].folder === rel);
    if (!token) token = crypto.randomBytes(16).toString("hex");

    const share = {
      folder: rel,
      createdAt: shares[token]?.createdAt || new Date().toISOString(),
      label: rel ? rel.split("/").pop() : "루트",
    };
    if (password) share.passwordHash = hashPassword(password);
    else if (req.body.clearPassword) delete share.passwordHash;
    else if (shares[token]?.passwordHash) share.passwordHash = shares[token].passwordHash;

    if (expiresInDays && expiresInDays > 0) {
      share.expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
    } else if (req.body.expiresAt) {
      share.expiresAt = req.body.expiresAt;
    } else if (req.body.clearExpiry) {
      delete share.expiresAt;
    } else if (shares[token]?.expiresAt) {
      share.expiresAt = shares[token].expiresAt;
    }

    shares[token] = share;
    saveShares(shares);
    res.json({
      ok: true,
      token,
      folder: rel,
      path: `/s/${token}`,
      hasPassword: Boolean(share.passwordHash),
      expiresAt: share.expiresAt || null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/shares/:token", (req, res) => {
  const share = loadShares()[req.params.token];
  if (!share) return res.status(404).json({ error: "공유 링크가 없거나 만료되었습니다." });
  if (isShareExpired(share)) return res.status(410).json({ error: "공유 링크가 만료되었습니다." });
  res.json({
    ok: true,
    folder: share.folder,
    label: share.label || share.folder || "공유 폴더",
    createdAt: share.createdAt,
    hasPassword: Boolean(share.passwordHash),
    expiresAt: share.expiresAt || null,
  });
});

app.delete("/api/shares/:token", requireAuth, (req, res) => {
  const shares = loadShares();
  if (!shares[req.params.token]) return res.status(404).json({ error: "공유 링크가 없습니다." });
  delete shares[req.params.token];
  saveShares(shares);
  res.clearCookie(`pu_share_${req.params.token}`);
  res.json({ ok: true });
});

app.post("/api/share/:token/auth", (req, res) => {
  const token = req.params.token;
  const share = loadShares()[token];
  if (!share) return res.status(404).json({ error: "공유 링크가 없거나 만료되었습니다." });
  if (isShareExpired(share)) return res.status(410).json({ error: "공유 링크가 만료되었습니다." });
  if (!share.passwordHash) {
    return res.json({ ok: true, needPassword: false });
  }
  if (!verifyPassword(req.body.password || "", share.passwordHash)) {
    return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
  }
  const access = makeShareAccessToken(token);
  res.cookie(`pu_share_${token}`, access, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ ok: true, accessToken: access });
});

function requireShareAccess(req, res, next) {
  const token = req.params.token;
  const share = loadShares()[token];
  if (!share) return res.status(404).json({ error: "공유 링크가 없거나 만료되었습니다." });
  if (isShareExpired(share)) return res.status(410).json({ error: "공유 링크가 만료되었습니다." });
  if (share.passwordHash) {
    const access = req.cookies?.[`pu_share_${token}`] || req.headers["x-share-access"];
    if (!verifyShareAccessToken(access, token)) {
      return res.status(401).json({ error: "공유 비밀번호가 필요합니다.", needSharePassword: true });
    }
  }
  req.share = share;
  next();
}

app.get("/api/share/:token/browse", requireShareAccess, (req, res) => {
  try {
    const share = req.share;
    const sub = req.query.path || "";
    const { rel, root } = resolveUnderShare(share.folder, sub);
    const listed = listDir(rel);
    const relToShare = root ? (rel === root ? "" : rel.slice(root.length + 1)) : rel;
    const label = share.label || (root ? root.split("/").pop() : "공유 폴더");
    const q = req.params.token;
    res.json({
      ok: true,
      label,
      shareRoot: root,
      path: relToShare,
      pathDisplay: relToShare ? `/${label}/${relToShare}` : `/${label}`,
      folders: listed.folders.map((f) => ({
        name: f.name,
        path: root ? (f.path === root ? "" : f.path.slice(root.length + 1)) : f.path,
      })),
      photos: listed.photos.map((p) => ({
        ...p,
        url: `${p.url}?share=${encodeURIComponent(q)}`,
        thumbUrl: `${p.thumbUrl || p.url}?share=${encodeURIComponent(q)}`,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/share/:token/download-zip", requireShareAccess, (req, res) => {
  try {
    const share = req.share;
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    const files = [];
    for (const p of paths) {
      if (!shareAllowsPath(share, p)) continue;
      const { abs, rel } = safeRel(p);
      if (!rel || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      files.push({ abs, name: path.basename(abs) });
    }
    if (!files.length) return res.status(404).json({ error: "다운로드할 파일이 없습니다." });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="share_${Date.now()}.zip"`);
    const archive = archiver("zip", { zlib: { level: 5 } });
    archive.on("error", (err) => console.error(err));
    archive.pipe(res);
    const used = new Set();
    for (const f of files) {
      let name = f.name;
      if (used.has(name)) name = `${used.size}_${name}`;
      used.add(name);
      archive.file(f.abs, { name });
    }
    archive.finalize();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/s/:token", (req, res) => {
  const share = loadShares()[req.params.token];
  if (!share) return res.status(404).send("공유 링크가 없거나 만료되었습니다.");
  if (isShareExpired(share)) return res.status(410).send("공유 링크가 만료되었습니다.");
  res.sendFile(path.join(ROOT, "public", "share.html"));
});

app.get("/api/info", requireAuth, (_req, res) => {
  res.json({
    lanUrls: getLanUrls(),
    httpsPort: PORT,
    httpPort: HTTP_PORT,
    thumbs: Boolean(sharp),
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "요청 처리 중 오류가 발생했습니다." });
});

function getLanUrls() {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) urls.push(`https://${n.address}:${PORT}`);
    }
  }
  return urls;
}

function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    }
  }
  return ips;
}

function getCert() {
  const envKey = process.env.SSL_KEY;
  const envCert = process.env.SSL_CERT;
  if (envKey && envCert && fs.existsSync(envKey) && fs.existsSync(envCert)) {
    return { key: fs.readFileSync(envKey), cert: fs.readFileSync(envCert), kind: "env" };
  }
  const keyPath = path.join(CERTS_DIR, "key.pem");
  const certPath = path.join(CERTS_DIR, "cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), kind: "local" };
  }
  const pems = selfsigned.generate([{ name: "commonName", value: "photo-upload.local" }], {
    days: 3650,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
          ...getLanIps().map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert, kind: "selfsigned" };
}

const certs = getCert();
https.createServer({ key: certs.key, cert: certs.cert }, app).listen(PORT, "0.0.0.0", () => {
  const cfg = loadConfig();
  console.log("");
  console.log("══════════════════════════════════════════════");
  console.log("  사진 업로드 서버가 실행 중입니다");
  console.log("══════════════════════════════════════════════");
  console.log(`  PC   : https://localhost:${PORT}`);
  for (const url of getLanUrls()) console.log(`  폰   : ${url}`);
  console.log(`  인증서: ${certs.kind}`);
  console.log(`  썸네일: ${sharp ? "ON" : "OFF"}`);
  console.log(`  비밀번호: ${authEnabled(cfg) ? "설정됨" : "미설정 (첫 접속 시 설정)"}`);
  console.log("══════════════════════════════════════════════");
  console.log("");
});

http
  .createServer((req, res) => {
    const host = (req.headers.host || "").split(":")[0] || "localhost";
    res.writeHead(302, { Location: `https://${host}:${PORT}${req.url || "/"}` });
    res.end();
  })
  .listen(HTTP_PORT, "0.0.0.0");
