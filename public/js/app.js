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
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const els = {
    app: $(".app"),
    pathLabel: $("#pathLabel"),
    folderList: $("#folderList"),
    browsePhotos: $("#browsePhotos"),
    browseEmpty: $("#browseEmpty"),
    galleryGrid: $("#galleryGrid"),
    galleryEmpty: $("#galleryEmpty"),
    saveFolder: $("#saveFolder"),
    galleryFolder: $("#galleryFolder"),
    resolutionSelect: $("#resolutionSelect"),
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
    folderModal: $("#folderModal"),
    zoomStage: $("#zoomStage"),
    modalImg: $("#modalImg"),
    modalName: $("#modalName"),
    modalTime: $("#modalTime"),
    modalSize: $("#modalSize"),
    modalLoc: $("#modalLoc"),
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

  async function api(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "요청 실패");
    return data;
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
    return p ? `/${p}` : "/";
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
    if (name === "gallery") loadGallery();
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

  function photoCard(photo) {
    const hasLoc = photo.lat != null && photo.lng != null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "photo-card";
    btn.innerHTML = `
      <img src="${escapeAttr(photo.url)}" alt="${escapeAttr(photo.name)}" loading="lazy" />
      ${hasLoc ? '<span class="badge">위치</span>' : ""}
    `;
    btn.addEventListener("click", () => openPhoto(photo));
    return btn;
  }

  async function loadBrowse() {
    const data = await api(`/api/browse?path=${encodeURIComponent(state.currentPath)}`);
    state.folders = data.folders;
    state.photos = data.photos;
    els.pathLabel.textContent = pathLabel(state.currentPath);
    $("#btnUp").disabled = !state.currentPath;

    els.folderList.innerHTML = "";
    for (const f of data.folders) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "folder-item";
      b.innerHTML = `<span class="folder-icon" aria-hidden="true"></span><strong>${escapeHtml(f.name)}</strong>`;
      b.addEventListener("click", () => {
        state.currentPath = f.path;
        els.saveFolder.value = f.path;
        loadBrowse();
      });
      els.folderList.appendChild(b);
    }

    els.browsePhotos.innerHTML = "";
    for (const p of data.photos) els.browsePhotos.appendChild(photoCard(p));

    const empty = data.folders.length === 0 && data.photos.length === 0;
    els.browseEmpty.classList.toggle("hidden", !empty);

    state.allFolderOptions = await collectFolders();
    fillFolderSelects();
  }

  async function loadGallery() {
    const filter = els.galleryFolder.value;
    const data = await api(`/api/browse?path=${encodeURIComponent(filter === "__all__" ? "" : filter)}`);

    let photos = data.photos || [];
    if (filter === "__all__") {
      photos = await collectAllPhotos();
    }

    els.galleryGrid.innerHTML = "";
    for (const p of photos) els.galleryGrid.appendChild(photoCard(p));
    els.galleryEmpty.classList.toggle("hidden", photos.length > 0);

    state.allFolderOptions = await collectFolders();
    fillFolderSelects();
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

  function openPhoto(photo) {
    state.selectedPhoto = photo;
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
    if (hasLoc) {
      const acc =
        photo.accuracy != null ? ` (±${Math.round(photo.accuracy)}m)` : "";
      els.modalLoc.textContent = `위치: ${photo.lat.toFixed(6)}, ${photo.lng.toFixed(6)}${acc}`;
      els.modalMaps.href = `https://www.openstreetmap.org/?mlat=${photo.lat}&mlon=${photo.lng}#map=17/${photo.lat}/${photo.lng}`;
      els.modalMaps.classList.remove("hidden");
      els.mapFrame.classList.remove("hidden");
      els.mapFrame.innerHTML = `<iframe
        title="지도"
        loading="lazy"
        referrerpolicy="no-referrer-when-downgrade"
        src="https://www.openstreetmap.org/export/embed.html?bbox=${photo.lng - 0.01}%2C${photo.lat - 0.008}%2C${photo.lng + 0.01}%2C${photo.lat + 0.008}&layer=mapnik&marker=${photo.lat}%2C${photo.lng}"
      ></iframe>`;
    } else {
      els.modalLoc.textContent = "위치 정보 없음 (촬영 시 위치 권한이 필요합니다)";
      els.modalMaps.classList.add("hidden");
      els.mapFrame.classList.add("hidden");
      els.mapFrame.innerHTML = "";
    }

    if (typeof els.photoModal.showModal === "function") els.photoModal.showModal();
    else els.photoModal.setAttribute("open", "");
  }

  function closePhotoModal() {
    if (els.photoModal.open) els.photoModal.close();
    els.mapFrame.innerHTML = "";
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
    fd.append("photo", blob, `capture_${Date.now()}.jpg`);
    fd.append("folder", folder);
    fd.append("takenAt", new Date().toISOString());
    if (state.geo.lat != null) {
      fd.append("lat", String(state.geo.lat));
      fd.append("lng", String(state.geo.lng));
      if (state.geo.accuracy != null) fd.append("accuracy", String(state.geo.accuracy));
    }
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
      // 항상: 찍은 사진 전체 화면 확인 → 저장 / 다시 찍기
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

  $("#btnUp").addEventListener("click", () => {
    if (!state.currentPath) return;
    const parts = state.currentPath.split("/");
    parts.pop();
    state.currentPath = parts.join("/");
    loadBrowse().catch((e) => toast(e.message));
  });

  $("#btnNewFolder").addEventListener("click", () => {
    $("#folderName").value = "";
    if (typeof els.folderModal.showModal === "function") els.folderModal.showModal();
    else els.folderModal.setAttribute("open", "");
    setTimeout(() => $("#folderName").focus(), 50);
  });

  $("#folderCancel").addEventListener("click", () => {
    if (els.folderModal.open) els.folderModal.close();
  });

  $("#folderForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#folderName").value.trim();
    if (!name) return;
    try {
      await createFolder(name);
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

  els.saveFolder.addEventListener("change", () => {
    updateFolderChip();
    saveSettings({ saveFolder: els.saveFolder.value });
  });

  $("#modalClose").addEventListener("click", closePhotoModal);
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
  loadBrowse()
    .then(() => {
      const folder = saved.saveFolder;
      if (folder && state.allFolderOptions.includes(folder)) {
        els.saveFolder.value = folder;
      } else if (state.currentPath) {
        els.saveFolder.value = state.currentPath;
      }
      updateFolderChip();
    })
    .catch((e) => toast(e.message));
})();
