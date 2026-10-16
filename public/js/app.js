(() => {
  "use strict";

  const FLASH_MODES = ["off", "auto", "on", "torch"];
  const FLASH_LABELS = { off: "끔", auto: "자동", on: "촬영", torch: "상시" };
  const STORAGE_KEY = "photo-upload-settings";

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveSettings(partial) {
    const next = { ...loadSettings(), ...partial };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  const saved = loadSettings();

  const state = {
    currentPath: "",
    folders: [],
    photos: [],
    allFolderOptions: [""],
    stream: null,
    facingMode: saved.facingMode || "environment",
    resolution: saved.resolution || "max",
    flashMode: saved.flashMode || "off",
    torchSupported: false,
    flashSupported: false,
    geo: { lat: null, lng: null, accuracy: null },
    selectedPhoto: null,
    uploading: false,
    zoom: { scale: 1, x: 0, y: 0, min: 1, max: 5 },
    startingCamera: false,
    pendingCapture: null, // { blob, url }
    lastSavedPhoto: null,
    galleryPhotos: [],
    galleryMode: "grid", // grid | map
    galleryMap: null,
    galleryMarkers: null,
    selected: new Set(),
    shareToken: null,
    dragPaths: [],
    navHistory: [],
    browseShown: 0,
    galleryShown: 0,
    browseObserver: null,
    galleryObserver: null,
    folderDialog: null, // { mode: 'create'|'rename', from?: string }
  };

  const PAGE_SIZE = 48;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const els = {
    app: $(".app"),
    breadcrumb: $("#breadcrumb"),
    btnBack: $("#btnBack"),
    folderList: $("#folderList"),
    browsePhotos: $("#browsePhotos"),
    browseEmpty: $("#browseEmpty"),
    browseCount: $("#browseCount"),
    browseSentinel: $("#browseSentinel"),
    galleryGrid: $("#galleryGrid"),
    galleryEmpty: $("#galleryEmpty"),
    gallerySentinel: $("#gallerySentinel"),
    galleryMapWrap: $("#galleryMapWrap"),
    galleryMap: $("#galleryMap"),
    galleryMapEmpty: $("#galleryMapEmpty"),
    galleryLocSummary: $("#galleryLocSummary"),
    saveFolder: $("#saveFolder"),
    galleryFolder: $("#galleryFolder"),
    resolutionSelect: $("#resolutionSelect"),
    autoSave: $("#autoSave"),
    btnFlash: $("#btnFlash"),
    flashLabel: $("#flashLabel"),
    folderChipLabel: $("#folderChipLabel"),
    btnFolderChip: $("#btnFolderChip"),
    btnCamSettings: $("#btnCamSettings"),
    camSettingsSheet: $("#camSettingsSheet"),
    btnCloseSettings: $("#btnCloseSettings"),
    btnLastThumb: $("#btnLastThumb"),
    lastThumbImg: $("#lastThumbImg"),
    shutterFlash: $("#shutterFlash"),
    camHud: $("#camHud"),
    video: $("#video"),
    canvas: $("#canvas"),
    camStatus: $("#camStatus"),
    geoStatus: $("#geoStatus"),
    reviewOverlay: $("#reviewOverlay"),
    reviewImg: $("#reviewImg"),
    toast: $("#toast"),
    photoModal: $("#photoModal"),
    moveModal: $("#moveModal"),
    moveFolderSelect: $("#moveFolderSelect"),
    movePhotoName: $("#movePhotoName"),
    shareModal: $("#shareModal"),
    shareUrlInput: $("#shareUrlInput"),
    shareFolderLabel: $("#shareFolderLabel"),
    selCount: $("#selCount"),
    btnMoveSelected: $("#btnMoveSelected"),
    btnDownloadSelected: $("#btnDownloadSelected"),
    folderModal: $("#folderModal"),
    zoomStage: $("#zoomStage"),
    modalImg: $("#modalImg"),
    modalName: $("#modalName"),
    modalTime: $("#modalTime"),
    modalSize: $("#modalSize"),
    modalLoc: $("#modalLoc"),
    modalLocBtn: $("#modalLocBtn"),
    mapFrame: $("#mapFrame"),
    modalDownload: $("#modalDownload"),
    modalMaps: $("#modalMaps"),
  };

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove("show"), 2400);
  }

  const SESSION_LS = "photo-upload-session";
  const DEVICE_LS = "photo-upload-device-id";

  function getSavedSession() {
    try {
      return localStorage.getItem(SESSION_LS) || "";
    } catch {
      return "";
    }
  }

  function getDeviceId() {
    try {
      let id = localStorage.getItem(DEVICE_LS) || "";
      if (!id || id.length < 16) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        localStorage.setItem(DEVICE_LS, id);
      }
      return id;
    } catch {
      return "";
    }
  }

  function saveSession(token, deviceId) {
    try {
      if (token) localStorage.setItem(SESSION_LS, token);
      if (deviceId) localStorage.setItem(DEVICE_LS, deviceId);
    } catch (_) {}
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_LS);
    } catch (_) {}
  }

  function authHeaders(extra = {}) {
    const token = getSavedSession();
    const headers = { ...extra };
    if (token) headers["X-Session"] = token;
    return headers;
  }

  function guessDeviceName() {
    const ua = navigator.userAgent || "";
    if (/iPhone/i.test(ua)) return "iPhone";
    if (/iPad/i.test(ua)) return "iPad";
    if (/Android/i.test(ua)) return "Android 폰";
    if (/Windows/i.test(ua)) return "Windows PC";
    if (/Mac/i.test(ua)) return "Mac";
    return "회사 장치";
  }

  async function api(url, options = {}) {
    const opts = { ...options };
    opts.headers = authHeaders(opts.headers || {});
    // FormData면 Content-Type 자동
    if (opts.body && !(opts.body instanceof FormData) && !opts.headers["Content-Type"]) {
      // json already set by callers
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.needAuth) {
      clearSession();
      await showAuthGate();
      throw new Error(data.error || "로그인이 필요합니다");
    }
    if (!res.ok) throw new Error(data.error || "요청 실패");
    return data;
  }

  async function fetchAuthStatus() {
    return fetch("/api/auth/status", { headers: authHeaders() }).then((r) => r.json());
  }

  async function showAuthGate() {
    const gate = $("#authGate");
    const status = await fetchAuthStatus().catch(() => ({}));
    const setup = Boolean(status.canSetup);
    if (status.loggedIn && !setup) {
      gate?.classList.add("hidden");
      $("#btnLogout")?.classList.toggle("hidden", !status.authEnabled);
      $("#btnDevices")?.classList.toggle("hidden", !status.authEnabled);
      return true;
    }
    gate?.classList.remove("hidden");
    $("#authTitle").textContent = setup ? "처음 설정" : "장치 로그인";
    $("#authDesc").textContent = setup
      ? "관리자 비밀번호를 만들고, 이 장치를 등록하세요. 이후에는 이 장치에서 자동 로그인됩니다."
      : "이 장치를 등록합니다. 한 번만 로그인하면 다음부터는 비밀번호 없이 사용할 수 있습니다.";
    $("#authSubmit").textContent = setup ? "설정하고 이 장치 등록" : "이 장치로 로그인";
    $("#authError").classList.add("hidden");
    $("#authPassword").value = "";
    const nameInput = $("#authDeviceName");
    if (nameInput && !nameInput.value) nameInput.value = guessDeviceName();
    setTimeout(() => $("#authPassword")?.focus(), 50);

    return new Promise((resolve) => {
      const form = $("#authForm");
      const onSubmit = async (e) => {
        e.preventDefault();
        const password = $("#authPassword").value;
        const deviceName = $("#authDeviceName")?.value || guessDeviceName();
        try {
          const endpoint = setup ? "/api/setup" : "/api/login";
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              password,
              deviceId: getDeviceId(),
              deviceName,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "실패");
          saveSession(data.token, data.deviceId);
          form.removeEventListener("submit", onSubmit);
          gate.classList.add("hidden");
          $("#btnLogout")?.classList.remove("hidden");
          $("#btnDevices")?.classList.remove("hidden");
          toast("이 장치가 등록되었습니다");
          resolve(true);
        } catch (err) {
          const errEl = $("#authError");
          errEl.textContent = err.message;
          errEl.classList.remove("hidden");
        }
      };
      form.addEventListener("submit", onSubmit);
    });
  }

  async function openDevicesModal() {
    const data = await api("/api/devices");
    const box = $("#devicesList");
    box.innerHTML = "";
    if (!data.devices?.length) {
      box.innerHTML = `<p class="sheet-note">등록된 장치가 없습니다.</p>`;
    } else {
      for (const d of data.devices) {
        const row = document.createElement("div");
        row.className = "device-row" + (d.current ? " current" : "");
        row.innerHTML = `
          <div class="meta">
            <strong>${escapeHtml(d.name)}${d.current ? " (지금 이 장치)" : ""}</strong>
            <small>최근 접속: ${escapeHtml(formatTime(d.lastSeenAt))}</small>
          </div>
        `;
        const ren = document.createElement("button");
        ren.type = "button";
        ren.className = "btn sm ghost";
        ren.textContent = "이름";
        ren.addEventListener("click", async () => {
          const name = prompt("장치 이름", d.name);
          if (!name || name === d.name) return;
          try {
            await api("/api/devices/rename", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: d.id, name }),
            });
            openDevicesModal();
          } catch (e) {
            toast(e.message);
          }
        });
        const rev = document.createElement("button");
        rev.type = "button";
        rev.className = "btn sm danger";
        rev.textContent = d.current ? "해제" : "해제";
        rev.addEventListener("click", async () => {
          if (!confirm(`${d.name} 등록을 해제할까요?`)) return;
          try {
            const result = await api(`/api/devices/${encodeURIComponent(d.id)}`, {
              method: "DELETE",
            });
            if (result.current) {
              clearSession();
              toast("이 장치 등록이 해제되었습니다. 다시 로그인하세요.");
              location.reload();
              return;
            }
            toast("장치를 해제했습니다");
            openDevicesModal();
          } catch (e) {
            toast(e.message);
          }
        });
        row.appendChild(ren);
        row.appendChild(rev);
        box.appendChild(row);
      }
    }
    const modal = $("#devicesModal");
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", "");
  }

  function formatTime(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function pathLabel(p) {
    return p ? `/루트/${p}` : "/루트";
  }

  function navigateTo(path, { pushHistory = true } = {}) {
    const next = path || "";
    if (pushHistory && next !== state.currentPath) {
      state.navHistory.push(state.currentPath);
    }
    state.currentPath = next;
    if (els.saveFolder) {
      els.saveFolder.value = next;
      updateFolderChip();
    }
    clearSelection();
    return loadBrowse();
  }

  function goBack() {
    if (!state.navHistory.length) return;
    const prev = state.navHistory.pop();
    state.currentPath = prev || "";
    if (els.saveFolder) {
      els.saveFolder.value = state.currentPath;
      updateFolderChip();
    }
    clearSelection();
    loadBrowse().catch((e) => toast(e.message));
  }

  function renderBreadcrumb() {
    if (!els.breadcrumb) return;
    els.breadcrumb.innerHTML = "";

    const parts = state.currentPath ? state.currentPath.split("/") : [];
    const items = [{ label: "루트", path: "" }, ...parts.map((name, i) => ({
      label: name,
      path: parts.slice(0, i + 1).join("/"),
    }))];

    items.forEach((item, idx) => {
      if (idx > 0) {
        const sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = "/";
        els.breadcrumb.appendChild(sep);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "crumb" + (idx === items.length - 1 ? " current" : "");
      btn.textContent = item.label;
      btn.title = item.path ? `/${item.path}` : "/루트";
      if (idx !== items.length - 1) {
        btn.addEventListener("click", () => {
          navigateTo(item.path).catch((e) => toast(e.message));
        });
      }
      els.breadcrumb.appendChild(btn);
    });
  }

  function setView(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    els.app.classList.toggle("camera-mode", name === "camera");
    if (name !== "camera") {
      clearPendingCapture();
      closeCamSettings();
      stopCamera();
    } else {
      updateFolderChip();
      startCamera();
    }
    if (name === "gallery") {
      loadGallery()
        .then(() => {
          if (state.galleryMode === "map" && state.galleryMap) {
            setTimeout(() => state.galleryMap.invalidateSize(), 120);
          }
        })
        .catch((e) => toast(e.message));
    }
  }

  function updateFolderChip() {
    const folder = els.saveFolder.value || "";
    els.folderChipLabel.textContent = folder ? `/${folder}` : "/ 루트";
  }

  function openCamSettings() {
    els.camSettingsSheet.classList.remove("hidden");
  }

  function closeCamSettings() {
    els.camSettingsSheet.classList.add("hidden");
  }

  function setLastThumb(photo) {
    state.lastSavedPhoto = photo;
    if (!photo?.url) {
      els.lastThumbImg.removeAttribute("src");
      els.btnLastThumb.disabled = true;
      return;
    }
    els.lastThumbImg.src = photo.url;
    els.btnLastThumb.disabled = false;
  }

  async function collectFolders(base = "", acc = [""]) {
    const data = await api(`/api/browse?path=${encodeURIComponent(base)}`);
    for (const f of data.folders) {
      acc.push(f.path);
      await collectFolders(f.path, acc);
    }
    return acc;
  }

  function fillFolderSelects() {
    const options = state.allFolderOptions
      .slice()
      .sort((a, b) => a.localeCompare(b, "ko"))
      .map((p) => {
        const label = p ? `/${p}` : "/ (루트)";
        return `<option value="${escapeAttr(p)}">${escapeHtml(label)}</option>`;
      })
      .join("");

    const prevSave = els.saveFolder.value;
    const prevGal = els.galleryFolder.value;
    els.saveFolder.innerHTML = options;
    els.galleryFolder.innerHTML = `<option value="__all__">전체</option>${options}`;

    if (state.allFolderOptions.includes(prevSave)) els.saveFolder.value = prevSave;
    else if (state.currentPath) els.saveFolder.value = state.currentPath;
    updateFolderChip();

    if (prevGal === "__all__" || state.allFolderOptions.includes(prevGal)) {
      els.galleryFolder.value = prevGal || "__all__";
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function updateSelectionUi() {
    const n = state.selected.size;
    const bar = $("#selActions");
    if (els.selCount) els.selCount.textContent = n ? `${n}장` : "";
    if (els.btnMoveSelected) {
      els.btnMoveSelected.disabled = n === 0;
      els.btnMoveSelected.classList.toggle("hidden", n === 0);
    }
    if (els.btnDownloadSelected) {
      els.btnDownloadSelected.disabled = n === 0;
      els.btnDownloadSelected.classList.toggle("hidden", n === 0);
    }
    const delBtn = $("#btnDeleteSelected");
    if (delBtn) {
      delBtn.disabled = n === 0;
      delBtn.classList.toggle("hidden", n === 0);
    }
    const clearBtn = $("#btnClearSel");
    if (clearBtn) clearBtn.classList.toggle("hidden", n === 0);
    if (bar) bar.classList.toggle("has-selection", n > 0);
  }

  function clearSelection() {
    state.selected.clear();
    $$(".photo-card.selected").forEach((el) => {
      el.classList.remove("selected");
      const cb = el.querySelector("input[type=checkbox]");
      if (cb) cb.checked = false;
    });
    updateSelectionUi();
  }

  function photoCard(photo, opts = {}) {
    const hasLoc = photo.lat != null && photo.lng != null;
    const selectable = Boolean(opts.selectable);
    const wrap = document.createElement(selectable ? "div" : "button");
    if (!selectable) wrap.type = "button";
    wrap.className = `photo-card${selectable ? " selectable" : ""}`;
    wrap.dataset.path = photo.path;

    if (selectable) {
      wrap.draggable = true;
      const imgSrc = photo.thumbUrl || photo.url;
      wrap.innerHTML = `
        <label class="sel-check"><input type="checkbox" /></label>
        <img src="${escapeAttr(imgSrc)}" alt="${escapeAttr(photo.name)}" loading="lazy" draggable="false" />
        ${hasLoc ? '<span class="badge">위치</span>' : ""}
      `;
      const cb = wrap.querySelector("input");
      cb.checked = state.selected.has(photo.path);
      if (cb.checked) wrap.classList.add("selected");

      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) state.selected.add(photo.path);
        else state.selected.delete(photo.path);
        wrap.classList.toggle("selected", cb.checked);
        updateSelectionUi();
      });

      wrap.querySelector("img").addEventListener("click", () => openPhoto(photo));

      wrap.addEventListener("dragstart", (e) => {
        const paths = state.selected.has(photo.path)
          ? [...state.selected]
          : [photo.path];
        state.dragPaths = paths;
        e.dataTransfer.setData("text/plain", JSON.stringify(paths));
        e.dataTransfer.effectAllowed = "move";
        wrap.classList.add("dragging");
      });
      wrap.addEventListener("dragend", () => {
        wrap.classList.remove("dragging");
        state.dragPaths = [];
      });
    } else {
      const imgSrc = photo.thumbUrl || photo.url;
      wrap.innerHTML = `
        <img src="${escapeAttr(imgSrc)}" alt="${escapeAttr(photo.name)}" loading="lazy" />
        ${hasLoc ? '<span class="badge">위치</span>' : ""}
      `;
      wrap.addEventListener("click", () => openPhoto(photo));
    }
    return wrap;
  }

  function setupFolderDrop(el, targetFolder) {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drag-over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drag-over");
      let paths = state.dragPaths;
      try {
        const raw = e.dataTransfer.getData("text/plain");
        if (raw) paths = JSON.parse(raw);
      } catch (_) {}
      if (!paths?.length) return;
      try {
        await api("/api/photos/move-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths, toFolder: targetFolder }),
        });
        clearSelection();
        toast(`${paths.length}장 이동 완료`);
        await loadBrowse();
        if ($("#view-gallery").classList.contains("active")) await loadGallery();
      } catch (err) {
        toast(err.message);
      }
    });
  }

  async function loadBrowse() {
    const data = await api(`/api/browse?path=${encodeURIComponent(state.currentPath)}`);
    state.folders = data.folders;
    state.photos = data.photos;
    // 현재 폴더에 없는 선택 제거
    const alive = new Set((data.photos || []).map((p) => p.path));
    [...state.selected].forEach((p) => {
      if (!alive.has(p)) state.selected.delete(p);
    });
    updateSelectionUi();

    renderBreadcrumb();
    if (els.btnBack) els.btnBack.disabled = state.navHistory.length === 0;
    const inFolder = Boolean(state.currentPath);
    const ren = $("#btnRenameFolder");
    const delF = $("#btnDeleteFolder");
    if (ren) ren.disabled = !inFolder;
    if (delF) delF.disabled = !inFolder;

    els.folderList.innerHTML = "";
    for (const f of data.folders) {
      const row = document.createElement("div");
      row.className = "folder-item";
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "folder-open";
      openBtn.innerHTML = `
        <span class="folder-icon" aria-hidden="true"></span>
        <strong>${escapeHtml(f.name)}</strong>
        <span class="folder-meta">폴더</span>
      `;
      openBtn.addEventListener("click", () => {
        navigateTo(f.path).catch((e) => toast(e.message));
      });
      const renBtn = document.createElement("button");
      renBtn.type = "button";
      renBtn.className = "folder-rename";
      renBtn.textContent = "이름";
      renBtn.title = "이름 변경";
      renBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openFolderDialog({ mode: "rename", from: f.path, name: f.name });
      });
      row.appendChild(openBtn);
      row.appendChild(renBtn);
      setupFolderDrop(row, f.path);
      els.folderList.appendChild(row);
    }

    state.browseShown = 0;
    els.browsePhotos.innerHTML = "";
    appendBrowseChunk();
    setupBrowseObserver();

    const empty = data.folders.length === 0 && data.photos.length === 0;
    els.browseEmpty.classList.toggle("hidden", !empty);

    state.allFolderOptions = await collectFolders();
    fillFolderSelects();
  }

  function updateBrowseCount() {
    if (!els.browseCount) return;
    const total = (state.photos || []).length;
    const folders = (state.folders || []).length;
    if (!total && !folders) {
      els.browseCount.textContent = "";
      return;
    }
    const shown = Math.min(state.browseShown, total);
    els.browseCount.textContent = total
      ? `사진 ${shown}/${total}장${folders ? ` · 폴더 ${folders}` : ""}`
      : `폴더 ${folders}`;
  }

  function appendBrowseChunk() {
    const list = state.photos || [];
    const next = list.slice(state.browseShown, state.browseShown + PAGE_SIZE);
    for (const p of next) {
      els.browsePhotos.appendChild(photoCard(p, { selectable: true }));
    }
    state.browseShown += next.length;
    updateBrowseCount();

    const done = state.browseShown >= list.length;
    if (els.browseSentinel) {
      els.browseSentinel.classList.toggle("hidden", list.length === 0);
      els.browseSentinel.classList.toggle("done", done && list.length > 0);
      if (done) els.browseSentinel.classList.remove("hidden");
      if (list.length === 0) els.browseSentinel.classList.add("hidden");
    }
  }

  function setupBrowseObserver() {
    if (!els.browseSentinel) return;
    if (state.browseObserver) state.browseObserver.disconnect();
    state.browseObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (state.browseShown >= (state.photos || []).length) return;
        appendBrowseChunk();
      },
      { root: null, rootMargin: "240px", threshold: 0 }
    );
    state.browseObserver.observe(els.browseSentinel);
  }

  async function downloadSelectedZip() {
    const paths = [...state.selected];
    if (!paths.length) return;
    toast("ZIP 준비 중…");
    const res = await fetch("/api/download-zip", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "다운로드 실패");
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `photos_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast("다운로드 시작");
  }

  async function openShareDialog() {
    const folder = state.currentPath;
    els.shareFolderLabel.textContent = `폴더: ${folder ? `/${folder}` : "/ (루트)"}`;
    els.shareUrlInput.value = "";
    $("#sharePasswordInput").value = "";
    $("#shareMeta").textContent = "아래 옵션을 정한 뒤 「링크 만들기」를 누르세요.";
    state.shareToken = null;
    if (typeof els.shareModal.showModal === "function") els.shareModal.showModal();
    else els.shareModal.setAttribute("open", "");
  }

  async function createShareLink() {
    const folder = state.currentPath;
    const password = $("#sharePasswordInput").value;
    const expiresInDays = $("#shareExpirySelect").value;
    const body = { folder };
    if (password) body.password = password;
    else body.clearPassword = true;
    if (expiresInDays) body.expiresInDays = Number(expiresInDays);
    else body.clearExpiry = true;

    const data = await api("/api/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.shareToken = data.token;
    els.shareUrlInput.value = `${location.origin}${data.path}`;
    const bits = [];
    if (data.hasPassword) bits.push("비밀번호 있음");
    if (data.expiresAt) bits.push(`만료 ${new Date(data.expiresAt).toLocaleString("ko-KR")}`);
    else bits.push("만료 없음");
    $("#shareMeta").textContent = bits.join(" · ");
    toast("공유 링크가 만들어졌습니다");
  }

  async function deleteSelectedPhotos() {
    const paths = [...state.selected];
    if (!paths.length) return;
    if (!confirm(`선택한 ${paths.length}장을 삭제할까요?`)) return;
    await api("/api/photos/delete-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    clearSelection();
    toast("삭제되었습니다");
    await loadBrowse();
    if ($("#view-gallery").classList.contains("active")) await loadGallery();
  }

  let searchTimer = null;
  async function runSearch(q) {
    q = String(q || "").trim();
    if (!q) {
      await loadBrowse();
      return;
    }
    const data = await api(
      `/api/search?q=${encodeURIComponent(q)}&folder=${encodeURIComponent(state.currentPath)}`
    );
    state.photos = data.photos || [];
    state.folders = [];
    state.browseShown = 0;
    els.folderList.innerHTML = "";
    els.browsePhotos.innerHTML = "";
    appendBrowseChunk();
    setupBrowseObserver();
    els.browseEmpty.classList.toggle("hidden", state.photos.length > 0);
    if (els.browseCount) {
      els.browseCount.textContent = `검색 결과 ${Math.min(state.browseShown, state.photos.length)}/${data.total || state.photos.length}장`;
    }
  }

  function photosWithLocation(photos) {
    return (photos || []).filter((p) => p.lat != null && p.lng != null && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  }

  function setGalleryMode(mode) {
    state.galleryMode = mode === "map" ? "map" : "grid";
    $$(".mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.galleryMode === state.galleryMode);
    });
    const isMap = state.galleryMode === "map";
    els.galleryGrid.classList.toggle("hidden", isMap);
    els.galleryMapWrap.classList.toggle("hidden", !isMap);
    if (isMap) {
      if (els.gallerySentinel) els.gallerySentinel.classList.add("hidden");
      renderGalleryMap(state.galleryPhotos);
    } else {
      if (!els.galleryGrid.children.length && state.galleryPhotos.length) {
        state.galleryShown = 0;
        appendGalleryChunk();
        setupGalleryObserver();
      } else if (els.gallerySentinel) {
        const done = state.galleryShown >= state.galleryPhotos.length;
        els.gallerySentinel.classList.toggle("hidden", !state.galleryPhotos.length);
        els.gallerySentinel.classList.toggle("done", done && state.galleryPhotos.length > 0);
      }
    }
  }

  function ensureGalleryMap() {
    if (state.galleryMap || typeof L === "undefined") return state.galleryMap;
    state.galleryMap = L.map(els.galleryMap, {
      zoomControl: true,
      attributionControl: true,
    }).setView([36.5, 127.8], 7);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(state.galleryMap);

    state.galleryMarkers = L.layerGroup().addTo(state.galleryMap);
    return state.galleryMap;
  }

  function renderGalleryMap(photos) {
    const located = photosWithLocation(photos);
    if (!photos.length) {
      els.galleryMapEmpty.textContent = "저장된 사진이 없습니다.";
    } else if (!located.length) {
      els.galleryMapEmpty.textContent =
        "위치에 찍힌 사진이 없습니다. 촬영 시 위치 권한을 허용해 주세요.";
    }
    els.galleryMapEmpty.classList.toggle("hidden", located.length > 0);

    if (typeof L === "undefined") {
      els.galleryLocSummary.textContent = "지도를 불러오지 못했습니다. 네트워크를 확인해 주세요.";
      return;
    }

    const map = ensureGalleryMap();
    state.galleryMarkers.clearLayers();

    if (!located.length) {
      map.setView([36.5, 127.8], 7);
      setTimeout(() => map.invalidateSize(), 50);
      return;
    }

    const bounds = [];
    for (const photo of located) {
      const marker = L.marker([photo.lat, photo.lng]);
      const time = formatTime(photo.takenAt);
      const pop = document.createElement("div");
      pop.className = "map-pop";
      pop.innerHTML = `
        <img src="${escapeAttr(photo.url)}" alt="${escapeAttr(photo.name)}" />
        <strong>${escapeHtml(photo.name)}</strong>
        <small>${escapeHtml(time)}</small>
        <small>${photo.lat.toFixed(5)}, ${photo.lng.toFixed(5)}</small>
      `;
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "사진 보기";
      openBtn.addEventListener("click", () => openPhoto(photo));
      pop.appendChild(openBtn);
      marker.bindPopup(pop);
      marker.on("click", () => marker.openPopup());
      state.galleryMarkers.addLayer(marker);
      bounds.push([photo.lat, photo.lng]);
    }

    if (bounds.length === 1) {
      map.setView(bounds[0], 15);
    } else {
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
    }
    setTimeout(() => map.invalidateSize(), 80);
  }

  function updateGallerySummary(photos) {
    const located = photosWithLocation(photos);
    if (!photos.length) {
      els.galleryLocSummary.textContent = "";
      return;
    }
    els.galleryLocSummary.textContent = `전체 ${photos.length}장 · 위치 있음 ${located.length}장${
      located.length ? " · 지도 탭에서 위치 확인" : ""
    }`;
  }

  async function loadGallery() {
    const filter = els.galleryFolder.value;
    const data = await api(`/api/browse?path=${encodeURIComponent(filter === "__all__" ? "" : filter)}`);

    let photos = data.photos || [];
    if (filter === "__all__") {
      photos = await collectAllPhotos();
    }

    state.galleryPhotos = photos;
    state.galleryShown = 0;
    els.galleryGrid.innerHTML = "";
    updateGallerySummary(photos);

    state.allFolderOptions = await collectFolders();
    fillFolderSelects();

    if (state.galleryMode === "map") {
      if (els.gallerySentinel) els.gallerySentinel.classList.add("hidden");
      renderGalleryMap(photos);
      els.galleryEmpty.classList.add("hidden");
    } else {
      appendGalleryChunk();
      setupGalleryObserver();
      els.galleryEmpty.classList.toggle("hidden", photos.length > 0);
    }
  }

  function appendGalleryChunk() {
    const list = state.galleryPhotos || [];
    const next = list.slice(state.galleryShown, state.galleryShown + PAGE_SIZE);
    for (const p of next) els.galleryGrid.appendChild(photoCard(p));
    state.galleryShown += next.length;

    const located = photosWithLocation(list).length;
    const shown = Math.min(state.galleryShown, list.length);
    if (list.length) {
      els.galleryLocSummary.textContent = `표시 ${shown}/${list.length}장 · 위치 있음 ${located}장`;
    }

    const done = state.galleryShown >= list.length;
    if (els.gallerySentinel) {
      els.gallerySentinel.classList.toggle("hidden", list.length === 0 || state.galleryMode === "map");
      els.gallerySentinel.classList.toggle("done", done && list.length > 0);
    }
  }

  function setupGalleryObserver() {
    if (!els.gallerySentinel) return;
    if (state.galleryObserver) state.galleryObserver.disconnect();
    state.galleryObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (state.galleryMode === "map") return;
        if (state.galleryShown >= (state.galleryPhotos || []).length) return;
        appendGalleryChunk();
      },
      { root: null, rootMargin: "240px", threshold: 0 }
    );
    state.galleryObserver.observe(els.gallerySentinel);
  }

  async function collectAllPhotos(base = "", acc = []) {
    const data = await api(`/api/browse?path=${encodeURIComponent(base)}`);
    acc.push(...data.photos);
    for (const f of data.folders) await collectAllPhotos(f.path, acc);
    acc.sort((a, b) => b.mtime - a.mtime);
    return acc;
  }

  function applyZoomTransform() {
    const { scale, x, y } = state.zoom;
    els.modalImg.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${scale})`;
  }

  function resetZoom() {
    state.zoom = { scale: 1, x: 0, y: 0, min: 1, max: 5 };
    const img = els.modalImg;
    const stage = els.zoomStage;
    if (!img.naturalWidth || !stage) return;

    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const fit = Math.min(sw / img.naturalWidth, sh / img.naturalHeight);
    img.style.width = `${img.naturalWidth * fit}px`;
    img.style.height = `${img.naturalHeight * fit}px`;
    applyZoomTransform();
  }

  function clampPan() {
    const stage = els.zoomStage;
    const img = els.modalImg;
    if (!stage || !img) return;
    const scaledW = img.clientWidth * state.zoom.scale;
    const scaledH = img.clientHeight * state.zoom.scale;
    const maxX = Math.max(0, (scaledW - stage.clientWidth) / 2);
    const maxY = Math.max(0, (scaledH - stage.clientHeight) / 2);
    state.zoom.x = Math.min(maxX, Math.max(-maxX, state.zoom.x));
    state.zoom.y = Math.min(maxY, Math.max(-maxY, state.zoom.y));
  }

  function setupZoomGestures() {
    const stage = els.zoomStage;
    if (!stage || stage._zoomReady) return;
    stage._zoomReady = true;

    let pointers = new Map();
    let lastDist = 0;
    let lastMid = null;
    let lastTap = 0;

    function midPoint(a, b) {
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    function dist(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    stage.addEventListener("pointerdown", (e) => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        lastDist = dist(pts[0], pts[1]);
        lastMid = midPoint(pts[0], pts[1]);
      }
    });

    stage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1 && state.zoom.scale > 1.01) {
        state.zoom.x += e.clientX - prev.x;
        state.zoom.y += e.clientY - prev.y;
        clampPan();
        applyZoomTransform();
      } else if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const d = dist(pts[0], pts[1]);
        const mid = midPoint(pts[0], pts[1]);
        if (lastDist > 0) {
          const next = Math.min(state.zoom.max, Math.max(state.zoom.min, state.zoom.scale * (d / lastDist)));
          state.zoom.scale = next;
          if (lastMid) {
            state.zoom.x += mid.x - lastMid.x;
            state.zoom.y += mid.y - lastMid.y;
          }
          clampPan();
          applyZoomTransform();
        }
        lastDist = d;
        lastMid = mid;
      }
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        lastDist = 0;
        lastMid = null;
      }
    }

    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);

    stage.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (state.zoom.scale > 1.2) {
        state.zoom.scale = 1;
        state.zoom.x = 0;
        state.zoom.y = 0;
      } else {
        state.zoom.scale = 2.5;
      }
      clampPan();
      applyZoomTransform();
    });

    stage.addEventListener("click", (e) => {
      const now = Date.now();
      if (now - lastTap < 280) {
        e.preventDefault();
        if (state.zoom.scale > 1.2) {
          state.zoom.scale = 1;
          state.zoom.x = 0;
          state.zoom.y = 0;
        } else {
          state.zoom.scale = 2.5;
        }
        clampPan();
        applyZoomTransform();
      }
      lastTap = now;
    });

    stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        state.zoom.scale = Math.min(state.zoom.max, Math.max(state.zoom.min, state.zoom.scale * factor));
        clampPan();
        applyZoomTransform();
      },
      { passive: false }
    );
  }

  function hidePhotoMap() {
    els.modalLoc.classList.add("hidden");
    els.modalLoc.textContent = "";
    els.mapFrame.classList.add("hidden");
    els.mapFrame.innerHTML = "";
    els.modalMaps.classList.add("hidden");
    if (els.modalLocBtn) {
      els.modalLocBtn.classList.remove("hidden");
      els.modalLocBtn.disabled = false;
    }
  }

  function showPhotoMap(photo) {
    const hasLoc = photo?.lat != null && photo?.lng != null;
    if (!hasLoc) {
      toast("이 사진에는 위치 정보가 없습니다");
      return;
    }
    const acc = photo.accuracy != null ? ` (±${Math.round(photo.accuracy)}m)` : "";
    els.modalLoc.textContent = `위치: ${photo.lat.toFixed(6)}, ${photo.lng.toFixed(6)}${acc}`;
    els.modalLoc.classList.remove("hidden");
    els.modalMaps.href = `https://www.openstreetmap.org/?mlat=${photo.lat}&mlon=${photo.lng}#map=17/${photo.lat}/${photo.lng}`;
    els.modalMaps.classList.remove("hidden");
    els.modalLocBtn.classList.add("hidden");
    els.mapFrame.classList.remove("hidden");
    els.mapFrame.innerHTML = `<iframe
      title="지도"
      loading="lazy"
      referrerpolicy="no-referrer-when-downgrade"
      src="https://www.openstreetmap.org/export/embed.html?bbox=${photo.lng - 0.01}%2C${photo.lat - 0.008}%2C${photo.lng + 0.01}%2C${photo.lat + 0.008}&layer=mapnik&marker=${photo.lat}%2C${photo.lng}"
    ></iframe>`;
  }

  function openPhoto(photo) {
    state.selectedPhoto = photo;
    hidePhotoMap();
    els.modalImg.onload = () => {
      resetZoom();
      const w = els.modalImg.naturalWidth;
      const h = els.modalImg.naturalHeight;
      const kb = photo.size ? ` · ${(photo.size / 1024).toFixed(0)} KB` : "";
      els.modalSize.textContent = w && h ? `해상도: ${w}×${h}${kb}` : "";
    };
    els.modalImg.src = photo.url;
    els.modalName.textContent = photo.name;
    els.modalTime.textContent = `촬영/저장: ${formatTime(photo.takenAt)}`;
    els.modalSize.textContent = "해상도 확인 중…";
    els.modalDownload.href = photo.url;
    els.modalDownload.setAttribute("download", photo.name);
    setupZoomGestures();
    resetZoom();

    const hasLoc = photo.lat != null && photo.lng != null;
    if (els.modalLocBtn) {
      els.modalLocBtn.disabled = !hasLoc;
      els.modalLocBtn.title = hasLoc ? "지도로 위치 보기" : "위치 정보 없음";
      if (!hasLoc) els.modalLocBtn.classList.add("is-disabled");
      else els.modalLocBtn.classList.remove("is-disabled");
    }

    if (typeof els.photoModal.showModal === "function") els.photoModal.showModal();
    else els.photoModal.setAttribute("open", "");
  }

  function closePhotoModal() {
    if (els.photoModal.open) els.photoModal.close();
    hidePhotoMap();
    state.selectedPhoto = null;
    resetZoom();
  }

  async function createFolder(name) {
    await api("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: state.currentPath, name }),
    });
    toast("폴더가 만들어졌습니다");
    await loadBrowse();
  }

  function openFolderDialog({ mode, from = "", name = "" } = {}) {
    state.folderDialog = { mode: mode || "create", from };
    const title = $("#folderModalTitle");
    const submit = $("#folderSubmit");
    const input = $("#folderName");
    if (mode === "rename") {
      if (title) title.textContent = "폴더 이름 변경";
      if (submit) submit.textContent = "변경";
      if (input) input.value = name || String(from).split("/").pop() || "";
    } else {
      if (title) title.textContent = "새 폴더";
      if (submit) submit.textContent = "만들기";
      if (input) input.value = "";
    }
    if (typeof els.folderModal.showModal === "function") els.folderModal.showModal();
    else els.folderModal.setAttribute("open", "");
    setTimeout(() => {
      input?.focus();
      input?.select();
    }, 50);
  }

  async function renameFolder(from, name) {
    const curName = String(from).split("/").pop();
    if (!from || !name || name === curName) return null;
    const data = await api("/api/folders/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, name }),
    });
    const oldPath = from;
    const newPath = data.path;
    state.navHistory = state.navHistory.map((p) =>
      p === oldPath || p.startsWith(oldPath + "/")
        ? newPath + p.slice(oldPath.length)
        : p
    );
    if (state.currentPath === oldPath || state.currentPath.startsWith(oldPath + "/")) {
      state.currentPath = newPath + state.currentPath.slice(oldPath.length);
    }
    if (els.saveFolder?.value === oldPath || els.saveFolder?.value?.startsWith(oldPath + "/")) {
      els.saveFolder.value = newPath + (els.saveFolder.value.slice(oldPath.length) || "");
      saveSettings({ saveFolder: els.saveFolder.value });
      updateFolderChip();
    }
    toast("폴더 이름을 바꿨습니다");
    await loadBrowse();
    return newPath;
  }

  async function deletePhoto() {
    const photo = state.selectedPhoto;
    if (!photo) return;
    if (!confirm(`삭제할까요?\n${photo.name}`)) return;
    await api("/api/photos", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: photo.path }),
    });
    closePhotoModal();
    toast("삭제되었습니다");
    await loadBrowse();
    if ($("#view-gallery").classList.contains("active")) await loadGallery();
  }

  function currentFolderOfPhoto(photo) {
    if (!photo?.path) return "";
    const parts = photo.path.split("/");
    parts.pop();
    return parts.join("/");
  }

  async function openMoveDialog(paths) {
    const list = paths?.length
      ? paths
      : state.selectedPhoto
        ? [state.selectedPhoto.path]
        : [...state.selected];
    if (!list.length) return;

    state.movePaths = list;
    state.allFolderOptions = await collectFolders();
    const currentFolder = list.length === 1
      ? currentFolderOfPhoto({ path: list[0] })
      : state.currentPath;
    els.movePhotoName.textContent =
      list.length === 1 ? list[0].split("/").pop() : `${list.length}장 선택됨`;
    els.moveFolderSelect.innerHTML = state.allFolderOptions
      .slice()
      .sort((a, b) => a.localeCompare(b, "ko"))
      .map((p) => {
        const label = p ? `/${p}` : "/ (루트)";
        const selected = p === currentFolder ? " selected" : "";
        return `<option value="${escapeAttr(p)}"${selected}>${escapeHtml(label)}</option>`;
      })
      .join("");

    if (typeof els.moveModal.showModal === "function") els.moveModal.showModal();
    else els.moveModal.setAttribute("open", "");
  }

  function closeMoveModal() {
    if (els.moveModal.open) els.moveModal.close();
  }

  async function movePhoto() {
    const paths = state.movePaths?.length
      ? state.movePaths
      : state.selectedPhoto
        ? [state.selectedPhoto.path]
        : [];
    if (!paths.length) return;
    const toFolder = els.moveFolderSelect.value || "";

    await api("/api/photos/move-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, toFolder }),
    });

    closeMoveModal();
    closePhotoModal();
    clearSelection();
    state.movePaths = null;
    toast(`이동 완료 → ${toFolder ? `/${toFolder}` : "/"}`);

    await loadBrowse();
    if ($("#view-gallery").classList.contains("active")) await loadGallery();
  }

  async function stopCamera() {
    if (state.stream) {
      try {
        const track = state.stream.getVideoTracks()[0];
        if (track && state.torchSupported) {
          await track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
        }
      } catch (_) {}
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
  }

  function parseResolution(value) {
    if (!value || value === "max") return null;
    const m = String(value).match(/^(\d+)x(\d+)$/i);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  function buildResolutionOptions(caps) {
    const presets = [
      { w: 3840, h: 2160, label: "4K (3840×2160)" },
      { w: 2560, h: 1440, label: "QHD (2560×1440)" },
      { w: 1920, h: 1080, label: "FHD (1920×1080)" },
      { w: 1280, h: 720, label: "HD (1280×720)" },
      { w: 640, h: 480, label: "SD (640×480)" },
    ];

    const maxW = caps?.width?.max || 4096;
    const maxH = caps?.height?.max || 2160;
    const minW = caps?.width?.min || 320;
    const minH = caps?.height?.min || 240;

    const options = [`<option value="max">최고 (${maxW}×${maxH})</option>`];
    for (const p of presets) {
      if (p.w <= maxW && p.h <= maxH && p.w >= minW && p.h >= minH) {
        options.push(`<option value="${p.w}x${p.h}">${p.label}</option>`);
      }
    }

    // 사용자가 고른 값이 프리셋에 없어도 유지 (자동으로 max로 되돌리지 않음)
    const prev = state.resolution || "max";
    if (prev !== "max" && !options.some((o) => o.includes(`value="${prev}"`))) {
      const parsed = parseResolution(prev);
      if (parsed) {
        options.push(
          `<option value="${parsed.width}x${parsed.height}">선택 (${parsed.width}×${parsed.height})</option>`
        );
      }
    }

    els.resolutionSelect.innerHTML = options.join("");
    els.resolutionSelect.value = prev;
    if (els.resolutionSelect.value !== prev) {
      // 브라우저가 value를 못 찾은 경우 option을 직접 추가
      const opt = document.createElement("option");
      opt.value = prev;
      opt.textContent = prev === "max" ? "최고" : `선택 (${prev.replace("x", "×")})`;
      els.resolutionSelect.appendChild(opt);
      els.resolutionSelect.value = prev;
    }
  }

  function videoConstraintsForResolution() {
    const chosen = parseResolution(state.resolution);
    const base = { facingMode: { ideal: state.facingMode } };
    if (chosen) {
      return {
        ...base,
        width: { ideal: chosen.width },
        height: { ideal: chosen.height },
      };
    }
    return {
      ...base,
      width: { ideal: 4096 },
      height: { ideal: 2160 },
    };
  }

  async function applyResolution(track) {
    const caps = track.getCapabilities?.() || {};
    const chosen = parseResolution(state.resolution);
    try {
      if (chosen) {
        // exact는 기기마다 실패하므로 ideal 우선, 실패 시에만 완화
        try {
          await track.applyConstraints({
            width: { ideal: chosen.width, max: chosen.width },
            height: { ideal: chosen.height, max: chosen.height },
          });
        } catch {
          await track.applyConstraints({
            width: { ideal: chosen.width },
            height: { ideal: chosen.height },
          });
        }
      } else if (caps.width?.max && caps.height?.max) {
        await track.applyConstraints({
          width: { ideal: caps.width.max },
          height: { ideal: caps.height.max },
        });
      }
    } catch (err) {
      console.warn("해상도 적용 실패", err);
      toast("선택한 해상도를 적용하지 못했습니다");
    }
  }

  function updateFlashUi() {
    const label = FLASH_LABELS[state.flashMode] || "끔";
    els.flashLabel.textContent = label;
    els.btnFlash.classList.toggle("on", state.flashMode !== "off");
    const unsupported =
      (state.flashMode === "torch" && !state.torchSupported) ||
      ((state.flashMode === "on" || state.flashMode === "auto") && !state.flashSupported && !state.torchSupported);
    els.btnFlash.title = unsupported
      ? "이 기기/브라우저는 플래시를 제한적으로 지원합니다"
      : `플래시: ${label} (탭하여 변경)`;
  }

  async function applyTorch(track) {
    if (!track) return;
    const wantTorch = state.flashMode === "torch";
    if (!state.torchSupported && wantTorch) {
      toast("이 카메라는 상시 플래시(토치)를 지원하지 않습니다");
      return;
    }
    if (!state.torchSupported) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: wantTorch }] });
    } catch {
      try {
        await track.applyConstraints({ torch: wantTorch });
      } catch (err) {
        console.warn("토치 적용 실패", err);
        if (wantTorch) toast("플래시를 켤 수 없습니다");
      }
    }
  }

  async function detectFlashSupport(track) {
    const caps = track.getCapabilities?.() || {};
    state.torchSupported = Boolean(caps.torch);

    state.flashSupported = false;
    if (typeof ImageCapture !== "undefined") {
      try {
        const ic = new ImageCapture(track);
        const photoCaps = await ic.getPhotoCapabilities?.();
        const modes = photoCaps?.fillLightMode || [];
        state.flashSupported = Array.isArray(modes)
          ? modes.includes("flash") || modes.includes("auto")
          : Boolean(modes);
      } catch (_) {
        state.flashSupported = state.torchSupported;
      }
    } else {
      state.flashSupported = state.torchSupported;
    }
    updateFlashUi();
  }

  function cycleFlash() {
    const idx = FLASH_MODES.indexOf(state.flashMode);
    state.flashMode = FLASH_MODES[(idx + 1) % FLASH_MODES.length];
    updateFlashUi();
    const track = state.stream?.getVideoTracks?.()[0];
    applyTorch(track);
    toast(`플래시: ${FLASH_LABELS[state.flashMode]}`);
  }

  async function startCamera() {
    if (!window.isSecureContext) {
      els.camStatus.textContent = "HTTPS로 접속해야 카메라를 사용할 수 있습니다";
      return;
    }
    if (state.startingCamera) return;
    state.startingCamera = true;
    try {
      await stopCamera();
      const want = state.resolution === "max" ? "최고" : state.resolution.replace("x", "×");
      els.camStatus.textContent = `카메라 연결 중… (${want})`;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraintsForResolution(),
      });
      const track = stream.getVideoTracks()[0];
      await applyResolution(track);
      await detectFlashSupport(track);
      await applyTorch(track);

      state.stream = stream;
      els.video.srcObject = stream;
      await els.video.play();

      const caps = track.getCapabilities?.() || {};
      const settings = track.getSettings?.() || {};
      buildResolutionOptions(caps);

      // 선택값은 절대 max로 덮어쓰지 않음 — 실제 적용 해상도만 안내
      els.resolutionSelect.value = state.resolution;

      const actual =
        settings.width && settings.height
          ? `${settings.width}×${settings.height}`
          : "?";
      const side = state.facingMode === "environment" ? "후면" : "전면";
      const flashNote = state.torchSupported || state.flashSupported ? " · 플래시 가능" : "";
      const pick = state.resolution === "max" ? "최고" : state.resolution.replace("x", "×");
      els.camStatus.textContent = `${side} · 선택 ${pick} · 실제 ${actual}${flashNote}`;
    } catch (err) {
      console.error(err);
      els.camStatus.textContent = "카메라 권한이 필요합니다";
      toast("카메라 접근이 거부되었습니다");
    } finally {
      state.startingCamera = false;
    }
  }

  function watchGeo() {
    if (!navigator.geolocation) {
      els.geoStatus.textContent = "위치: 지원하지 않음";
      return;
    }
    navigator.geolocation.watchPosition(
      (pos) => {
        state.geo = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        els.geoStatus.textContent = `위치: ${state.geo.lat.toFixed(5)}, ${state.geo.lng.toFixed(5)}`;
      },
      () => {
        els.geoStatus.textContent = "위치: 권한 필요 / 수신 불가";
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  async function captureBlob() {
    const track = state.stream?.getVideoTracks?.()[0];
    const chosen = parseResolution(state.resolution);

    // 지원 기기: ImageCapture로 스틸 사진 + 플래시
    if (track && typeof ImageCapture !== "undefined") {
      try {
        const ic = new ImageCapture(track);
        const photoCaps = await ic.getPhotoCapabilities?.().catch(() => null);
        const opts = {};

        if (chosen) {
          opts.imageWidth = chosen.width;
          opts.imageHeight = chosen.height;
        } else {
          if (photoCaps?.imageWidth?.max) opts.imageWidth = photoCaps.imageWidth.max;
          if (photoCaps?.imageHeight?.max) opts.imageHeight = photoCaps.imageHeight.max;
        }

        const modes = photoCaps?.fillLightMode;
        if (Array.isArray(modes) && modes.length) {
          if (state.flashMode === "on" && modes.includes("flash")) opts.fillLightMode = "flash";
          else if (state.flashMode === "auto" && modes.includes("auto")) opts.fillLightMode = "auto";
          else if (state.flashMode === "off" && modes.includes("off")) opts.fillLightMode = "off";
          else if (state.flashMode === "torch" && modes.includes("flash")) opts.fillLightMode = "flash";
        }

        // 토치가 켜진 상태면 그대로 촬영 (상시광)
        const blob = await ic.takePhoto(opts);
        if (blob) return blob;
      } catch (err) {
        console.warn("ImageCapture 실패, 캔버스 폴백", err);
      }
    }

    // 플래시 on인데 ImageCapture 없으면 토치로 짧게 보조
    if (track && (state.flashMode === "on" || state.flashMode === "auto") && state.torchSupported) {
      try {
        await track.applyConstraints({ advanced: [{ torch: true }] });
        await new Promise((r) => setTimeout(r, 120));
      } catch (_) {}
    }

    const video = els.video;
    if (!video.videoWidth) throw new Error("카메라가 아직 준비되지 않았습니다");
    const canvas = els.canvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, 0, 0);

    if (track && state.flashMode !== "torch" && state.torchSupported) {
      try {
        await track.applyConstraints({ advanced: [{ torch: false }] });
      } catch (_) {}
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("이미지 생성 실패"))),
        "image/jpeg",
        1.0
      );
    });
  }

  async function uploadBlob(blob) {
    const folder = els.saveFolder.value || "";
    const fd = new FormData();
    // folder를 파일보다 먼저 보내야 서버에서 파일명에 폴더명을 쓸 수 있음
    fd.append("folder", folder);
    fd.append("takenAt", new Date().toISOString());
    if (state.geo.lat != null) {
      fd.append("lat", String(state.geo.lat));
      fd.append("lng", String(state.geo.lng));
      if (state.geo.accuracy != null) fd.append("accuracy", String(state.geo.accuracy));
    }
    fd.append("photo", blob, `capture_${Date.now()}.jpg`);
    return api("/api/upload", { method: "POST", body: fd });
  }

  function clearPendingCapture() {
    if (state.pendingCapture?.url) {
      // blob URL은 저장 썸네일로 쓰는 경우가 있어, 리뷰용만 정리
      if (!state.lastSavedPhoto || state.lastSavedPhoto.url !== state.pendingCapture.url) {
        URL.revokeObjectURL(state.pendingCapture.url);
      }
    }
    state.pendingCapture = null;
    els.reviewImg.removeAttribute("src");
    els.reviewOverlay.classList.add("hidden");
    if (els.camHud) els.camHud.style.visibility = "";
    $("#btnShutter").disabled = false;
  }

  function flashShutter() {
    const el = els.shutterFlash;
    if (!el) return;
    el.hidden = false;
    el.classList.remove("on");
    // reflow
    void el.offsetWidth;
    el.classList.add("on");
    setTimeout(() => {
      el.classList.remove("on");
      el.hidden = true;
    }, 200);
  }

  function showReview(blob) {
    if (state.pendingCapture?.url) URL.revokeObjectURL(state.pendingCapture.url);
    const url = URL.createObjectURL(blob);
    state.pendingCapture = { blob, url };
    els.reviewImg.src = url;
    els.reviewOverlay.classList.remove("hidden");
    if (els.camHud) els.camHud.style.visibility = "hidden";
    $("#btnShutter").disabled = true;
  }

  async function confirmSavePending() {
    if (!state.pendingCapture?.blob || state.uploading) return;
    try {
      state.uploading = true;
      $("#btnConfirmSave").disabled = true;
      $("#btnRetake").disabled = true;
      const result = await uploadBlob(state.pendingCapture.blob);
      const photo = result.photo;
      // 서버 URL로 썸네일 갱신
      clearPendingCapture();
      setLastThumb(photo);
      toast("저장됨");
      if (state.currentPath === (els.saveFolder.value || "")) await loadBrowse();
    } catch (err) {
      console.error(err);
      toast(err.message || "저장 실패");
    } finally {
      state.uploading = false;
      $("#btnConfirmSave").disabled = false;
      $("#btnRetake").disabled = false;
    }
  }

  async function takePhoto() {
    if (state.uploading || state.pendingCapture) return;
    try {
      state.uploading = true;
      $("#btnShutter").disabled = true;
      flashShutter();
      const blob = await captureBlob();

      // 설정: 바로 저장 ON → 미리보기 없이 즉시 저장
      if (els.autoSave?.checked) {
        toast("저장 중…");
        const result = await uploadBlob(blob);
        setLastThumb(result.photo);
        toast("바로 저장됨");
        if (state.currentPath === (els.saveFolder.value || "")) await loadBrowse();
        return;
      }

      // 기본: 미리보기 → 저장 / 다시 찍기
      showReview(blob);
    } catch (err) {
      console.error(err);
      toast(err.message || "촬영 실패");
      clearPendingCapture();
    } finally {
      state.uploading = false;
      if (!state.pendingCapture) $("#btnShutter").disabled = false;
    }
  }

  // Events
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  });

  if (els.btnBack) els.btnBack.addEventListener("click", () => goBack());

  $("#btnSelectAll").addEventListener("click", () => {
    for (const p of state.photos || []) state.selected.add(p.path);
    $$("#browsePhotos .photo-card").forEach((card) => {
      card.classList.add("selected");
      const cb = card.querySelector("input[type=checkbox]");
      if (cb) cb.checked = true;
    });
    updateSelectionUi();
  });

  $("#btnClearSel").addEventListener("click", () => clearSelection());

  $("#btnMoveSelected").addEventListener("click", () => {
    openMoveDialog([...state.selected]).catch((e) => toast(e.message));
  });

  $("#btnDownloadSelected").addEventListener("click", () => {
    downloadSelectedZip().catch((e) => toast(e.message));
  });

  $("#btnShareFolder").addEventListener("click", () => {
    openShareDialog().catch((e) => toast(e.message));
  });

  $("#btnCreateShare").addEventListener("click", () => {
    createShareLink().catch((e) => toast(e.message));
  });

  $("#btnCopyShare").addEventListener("click", async () => {
    if (!els.shareUrlInput.value) {
      toast("먼저 링크를 만들어 주세요");
      return;
    }
    try {
      await navigator.clipboard.writeText(els.shareUrlInput.value);
      toast("링크가 복사되었습니다");
    } catch {
      els.shareUrlInput.select();
      toast("링크를 길게 눌러 복사하세요");
    }
  });

  $("#btnRevokeShare").addEventListener("click", async () => {
    if (!state.shareToken) {
      toast("중지할 공유 링크가 없습니다");
      return;
    }
    if (!confirm("이 폴더 공유를 중지할까요?")) return;
    try {
      await api(`/api/shares/${encodeURIComponent(state.shareToken)}`, { method: "DELETE" });
      state.shareToken = null;
      els.shareUrlInput.value = "";
      if (els.shareModal.open) els.shareModal.close();
      toast("공유가 중지되었습니다");
    } catch (e) {
      toast(e.message);
    }
  });

  $("#btnShareClose").addEventListener("click", () => {
    if (els.shareModal.open) els.shareModal.close();
  });

  $("#btnDeleteSelected").addEventListener("click", () => {
    deleteSelectedPhotos().catch((e) => toast(e.message));
  });

  $("#btnRenameFolder").addEventListener("click", () => {
    if (!state.currentPath) return;
    openFolderDialog({
      mode: "rename",
      from: state.currentPath,
      name: state.currentPath.split("/").pop(),
    });
  });

  $("#btnDeleteFolder").addEventListener("click", async () => {
    if (!state.currentPath) return;
    if (!confirm(`폴더와 안의 사진을 모두 삭제할까요?\n/${state.currentPath}`)) return;
    try {
      await api("/api/folders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: state.currentPath }),
      });
      const parts = state.currentPath.split("/");
      parts.pop();
      state.currentPath = parts.join("/");
      clearSelection();
      toast("폴더가 삭제되었습니다");
      await loadBrowse();
    } catch (e) {
      toast(e.message);
    }
  });

  $("#searchInput")?.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      runSearch(e.target.value).catch((err) => toast(err.message));
    }, 280);
  });

  $("#btnBackup")?.addEventListener("click", async () => {
    try {
      toast("백업 ZIP 준비 중…");
      const res = await fetch("/api/backup", { headers: authHeaders() });
      if (!res.ok) throw new Error("백업 실패");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `photo-backup_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("백업 다운로드 시작");
    } catch (e) {
      toast(e.message);
    }
  });

  $("#btnDevices")?.addEventListener("click", () => {
    openDevicesModal().catch((e) => toast(e.message));
  });
  $("#btnDevicesClose")?.addEventListener("click", () => {
    const modal = $("#devicesModal");
    if (modal?.open) modal.close();
    else modal?.removeAttribute("open");
  });

  $("#btnLogout")?.addEventListener("click", async () => {
    if (!confirm("이 장치 등록을 해제하고 로그아웃할까요?")) return;
    try {
      await fetch("/api/logout", {
        method: "POST",
        headers: authHeaders(),
      });
    } catch (_) {}
    clearSession();
    location.reload();
  });

  $("#btnNewFolder").addEventListener("click", () => {
    openFolderDialog({ mode: "create" });
  });

  $("#folderCancel").addEventListener("click", () => {
    state.folderDialog = null;
    if (els.folderModal.open) els.folderModal.close();
  });

  $("#folderForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#folderName").value.trim();
    if (!name) return;
    const dlg = state.folderDialog || { mode: "create" };
    try {
      if (dlg.mode === "rename") {
        await renameFolder(dlg.from, name);
      } else {
        await createFolder(name);
      }
      state.folderDialog = null;
      if (els.folderModal.open) els.folderModal.close();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#btnShutter").addEventListener("click", () => takePhoto());
  $("#btnConfirmSave").addEventListener("click", () => {
    confirmSavePending().catch((e) => toast(e.message));
  });
  $("#btnRetake").addEventListener("click", () => {
    clearPendingCapture();
  });

  $("#btnStartCam").addEventListener("click", () => {
    closeCamSettings();
    startCamera();
  });
  $("#btnFlip").addEventListener("click", async () => {
    state.facingMode = state.facingMode === "environment" ? "user" : "environment";
    saveSettings({ facingMode: state.facingMode });
    await startCamera();
  });
  $("#btnFlash").addEventListener("click", () => {
    cycleFlash();
    saveSettings({ flashMode: state.flashMode });
  });

  // 바로 저장 설정 복원
  if (els.autoSave) {
    els.autoSave.checked = Boolean(saved.autoSave);
    els.autoSave.addEventListener("change", () => {
      saveSettings({ autoSave: els.autoSave.checked });
      toast(els.autoSave.checked ? "찍으면 바로 저장합니다" : "미리보기 후 저장합니다");
    });
  }

  els.btnCamSettings.addEventListener("click", openCamSettings);
  els.btnCloseSettings.addEventListener("click", closeCamSettings);
  els.camSettingsSheet.addEventListener("click", (e) => {
    if (e.target === els.camSettingsSheet) closeCamSettings();
  });
  els.btnFolderChip.addEventListener("click", openCamSettings);

  els.btnLastThumb.addEventListener("click", () => {
    if (state.lastSavedPhoto) openPhoto(state.lastSavedPhoto);
  });

  els.resolutionSelect.addEventListener("change", async () => {
    state.resolution = els.resolutionSelect.value;
    saveSettings({ resolution: state.resolution });
    toast(`해상도 ${state.resolution === "max" ? "최고" : state.resolution.replace("x", "×")}`);
    await startCamera();
  });

  $("#btnRefresh").addEventListener("click", () => {
    loadGallery().catch((e) => toast(e.message));
  });

  els.galleryFolder.addEventListener("change", () => {
    loadGallery().catch((e) => toast(e.message));
  });

  $$(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setGalleryMode(btn.dataset.galleryMode);
      if (state.galleryMode === "grid") {
        els.galleryEmpty.classList.toggle("hidden", state.galleryPhotos.length > 0);
      } else {
        els.galleryEmpty.classList.add("hidden");
      }
    });
  });

  els.saveFolder.addEventListener("change", () => {
    updateFolderChip();
    saveSettings({ saveFolder: els.saveFolder.value });
  });

  $("#modalClose").addEventListener("click", closePhotoModal);
  $("#modalLocBtn").addEventListener("click", () => {
    if (!state.selectedPhoto) return;
    showPhotoMap(state.selectedPhoto);
  });
  $("#modalMove").addEventListener("click", () => {
    openMoveDialog(state.selectedPhoto ? [state.selectedPhoto.path] : []).catch((e) =>
      toast(e.message)
    );
  });
  $("#btnMoveCancel").addEventListener("click", closeMoveModal);
  $("#btnDoMove").addEventListener("click", () => {
    movePhoto().catch((e) => toast(e.message));
  });
  $("#modalDelete").addEventListener("click", () => {
    deletePhoto().catch((e) => toast(e.message));
  });

  els.photoModal.addEventListener("click", (e) => {
    if (e.target === els.photoModal) closePhotoModal();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
    else if ($("#view-camera").classList.contains("active") && !state.pendingCapture) {
      startCamera();
    }
  });

  // Init
  watchGeo();
  (async () => {
    try {
      await showAuthGate();
      await loadBrowse();
      const folder = saved.saveFolder;
      if (folder && state.allFolderOptions.includes(folder)) {
        els.saveFolder.value = folder;
      } else if (state.currentPath) {
        els.saveFolder.value = state.currentPath;
      }
      updateFolderChip();
    } catch (e) {
      toast(e.message);
    }
  })();
})();
