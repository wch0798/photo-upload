const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const selfsigned = require("selfsigned");

const PORT = Number(process.env.PORT) || 3443;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3080;
const ROOT = __dirname;
const UPLOADS = path.join(ROOT, "uploads");
const DATA_DIR = path.join(ROOT, "data");
const META_FILE = path.join(DATA_DIR, "metadata.json");
const CERTS_DIR = path.join(ROOT, "certs");

for (const dir of [UPLOADS, DATA_DIR, CERTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");
}

function safeRel(rel = "") {
  const cleaned = String(rel)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .join("/");
  const abs = path.resolve(UPLOADS, cleaned);
  if (!abs.startsWith(path.resolve(UPLOADS))) {
    throw new Error("잘못된 경로입니다.");
  }
  return { rel: cleaned, abs };
}

function listDir(rel = "") {
  const { abs, rel: safe } = safeRel(rel);
  if (!fs.existsSync(abs)) return { folders: [], photos: [] };

  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const meta = loadMeta();
  const folders = [];
  const photos = [];

  for (const e of entries) {
    const childRel = safe ? `${safe}/${e.name}` : e.name;
    if (e.isDirectory()) {
      folders.push({ name: e.name, path: childRel });
    } else if (/\.(jpe?g|png|webp|gif|heic)$/i.test(e.name)) {
      const st = fs.statSync(path.join(abs, e.name));
      const info = meta[childRel] || {};
      photos.push({
        name: e.name,
        path: childRel,
        url: `/files/${childRel.split("/").map(encodeURIComponent).join("/")}`,
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
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
    const rand = Math.random().toString(36).slice(2, 8);
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    cb(null, `photo_${stamp}_${rand}${ext}`);
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
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/files", express.static(UPLOADS, { fallthrough: false, maxAge: "1d" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/browse", (req, res) => {
  try {
    res.json(listDir(req.query.path || ""));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/folders", (req, res) => {
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

app.post("/api/upload", upload.single("photo"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "파일이 없습니다." });

    const folder = req.body.folder || "";
    const { rel: folderRel } = safeRel(folder);
    const rel = folderRel ? `${folderRel}/${req.file.filename}` : req.file.filename;

    const lat = req.body.lat !== undefined && req.body.lat !== "" ? Number(req.body.lat) : null;
    const lng = req.body.lng !== undefined && req.body.lng !== "" ? Number(req.body.lng) : null;
    const accuracy =
      req.body.accuracy !== undefined && req.body.accuracy !== ""
        ? Number(req.body.accuracy)
        : null;

    const meta = loadMeta();
    meta[rel] = {
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      takenAt: req.body.takenAt || new Date().toISOString(),
      originalName: req.file.originalname || null,
    };
    saveMeta(meta);

    res.json({
      ok: true,
      photo: {
        name: req.file.filename,
        path: rel,
        url: `/files/${rel.split("/").map(encodeURIComponent).join("/")}`,
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

app.delete("/api/photos", (req, res) => {
  try {
    const { abs, rel } = safeRel(req.body.path || "");
    if (!rel || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ error: "사진을 찾을 수 없습니다." });
    }
    fs.unlinkSync(abs);
    const meta = loadMeta();
    delete meta[rel];
    saveMeta(meta);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/info", (_req, res) => {
  res.json({
    lanUrls: getLanUrls(),
    httpsPort: PORT,
    httpPort: HTTP_PORT,
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
      if (n.family === "IPv4" && !n.internal) {
        urls.push(`https://${n.address}:${PORT}`);
      }
    }
  }
  return urls;
}

function getCert() {
  const keyPath = path.join(CERTS_DIR, "key.pem");
  const certPath = path.join(CERTS_DIR, "cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  }

  const attrs = [{ name: "commonName", value: "photo-upload.local" }];
  const pems = selfsigned.generate(attrs, {
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
  return { key: pems.private, cert: pems.cert };
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

const certs = getCert();

https.createServer(certs, app).listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("══════════════════════════════════════════════");
  console.log("  사진 업로드 서버가 실행 중입니다");
  console.log("══════════════════════════════════════════════");
  console.log(`  PC   : https://localhost:${PORT}`);
  for (const url of getLanUrls()) {
    console.log(`  폰   : ${url}`);
  }
  console.log("");
  console.log("  ※ 스마트폰은 같은 Wi‑Fi에 연결하세요.");
  console.log("  ※ 처음 접속 시 인증서 경고 → 고급 → 계속 진행");
  console.log("  ※ 카메라/위치는 HTTPS에서만 동작합니다.");
  console.log("══════════════════════════════════════════════");
  console.log("");
});

http.createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0] || "localhost";
  res.writeHead(302, { Location: `https://${host}:${PORT}${req.url || "/"}` });
  res.end();
}).listen(HTTP_PORT, "0.0.0.0");
