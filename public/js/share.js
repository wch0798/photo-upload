(() => {
  "use strict";

  const token = location.pathname.split("/").filter(Boolean).pop();
  const state = {
    path: "",
    rootLabel: "공유 폴더",
    photos: [],
    folders: [],
    selected: new Set(),
    history: [],
    zoom: { scale: 1, x: 0, y: 0, min: 1, max: 5 },
  };

  const $ = (s) => document.querySelector(s);
  const els = {
    title: $("#shareTitle"),
    breadcrumb: $("#breadcrumb"),
    folderList: $("#folderList"),
    photoGrid: $("#photoGrid"),
    empty: $("#empty"),
    selCount: $("#selCount"),
    btnBack: $("#btnBack"),
    btnSelectAll: $("#btnSelectAll"),
    btnDownload: $("#btnDownload"),
    toast: $("#toast"),
    photoModal: $("#photoModal"),
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
    shareAuth: $("#shareAuth"),
    shareApp: $("#shareApp"),
  };

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json().catch(() => ({})) : {};
    if (res.status === 401 && data.needSharePassword) {
      await unlockShare();
      throw new Error("비밀번호 확인 후 다시 시도하세요");
    }
    if (!res.ok) throw new Error(data.error || "요청 실패");
    return data;
  }

  async function unlockShare() {
    els.shareAuth.classList.remove("hidden");
    els.shareApp?.classList.add("hidden");
    return new Promise((resolve, reject) => {
      const form = $("#shareAuthForm");
      const handler = async (e) => {
        e.preventDefault();
        try {
          const password = $("#shareAuthPassword").value;
          const res = await fetch(`/api/share/${encodeURIComponent(token)}/auth`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "실패");
          form.removeEventListener("submit", handler);
          els.shareAuth.classList.add("hidden");
          els.shareApp?.classList.remove("hidden");
          resolve(true);
        } catch (err) {
          const el = $("#shareAuthError");
          el.textContent = err.message;
          el.classList.remove("hidden");
        }
      };
      form.addEventListener("submit", handler);
    });
  }

  async function ensureAccess() {
    const info = await fetch(`/api/shares/${encodeURIComponent(token)}`).then((r) => r.json());
    if (info.error) throw new Error(info.error);
    if (info.hasPassword) {
      // 쿠키가 있으면 browse가 통과함 — 먼저 시도
      const probe = await fetch(
        `/api/share/${encodeURIComponent(token)}/browse?path=`
      );
      if (probe.status === 401) await unlockShare();
    }
  }

  function updateSelUi() {
    const n = state.selected.size;
    els.selCount.textContent = n ? `${n}장 선택됨` : "";
    els.btnDownload.disabled = n === 0;
  }

  function renderBreadcrumb() {
    els.breadcrumb.innerHTML = "";
    const parts = state.path ? state.path.split("/") : [];
    const items = [
      { label: state.rootLabel || "공유", path: "" },
      ...parts.map((name, i) => ({
        label: name,
        path: parts.slice(0, i + 1).join("/"),
      })),
    ];
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
      if (idx !== items.length - 1) {
        btn.addEventListener("click", () => navigateTo(item.path, true));
      }
      els.breadcrumb.appendChild(btn);
    });
  }

  function navigateTo(path, fromCrumb) {
    if (!fromCrumb && path !== state.path) state.history.push(state.path);
    state.path = path || "";
    state.selected.clear();
    updateSelUi();
    load().catch((e) => toast(e.message));
  }

  function goBack() {
    if (!state.history.length) return;
    state.path = state.history.pop() || "";
    state.selected.clear();
    updateSelUi();
    load().catch((e) => toast(e.message));
  }

  async function load() {
    const data = await api(
      `/api/share/${encodeURIComponent(token)}/browse?path=${encodeURIComponent(state.path)}`
    );
    state.rootLabel = data.label || "공유 폴더";
    document.title = state.rootLabel;
    els.title.textContent = state.rootLabel;
    state.photos = data.photos || [];
    state.folders = data.folders || [];
    els.btnBack.disabled = state.history.length === 0;
    renderBreadcrumb();

    els.folderList.innerHTML = "";
    for (const f of state.folders) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "folder-item";
      b.innerHTML = `<span class="folder-icon"></span><strong>${escapeHtml(f.name)}</strong><span class="folder-meta">폴더</span>`;
      b.addEventListener("click", () => navigateTo(f.path, false));
      els.folderList.appendChild(b);
    }

    els.photoGrid.innerHTML = "";
    for (const p of state.photos) {
      const wrap = document.createElement("div");
      wrap.className = "photo-card selectable";
      const label = document.createElement("label");
      label.className = "sel-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      label.appendChild(cb);
      const img = document.createElement("img");
      img.alt = p.name;
      img.loading = "lazy";
      img.src = p.thumbUrl || p.url;
      wrap.appendChild(label);
      wrap.appendChild(img);
      if (p.lat != null) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "위치";
        wrap.appendChild(badge);
      }
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) state.selected.add(p.path);
        else state.selected.delete(p.path);
        wrap.classList.toggle("selected", cb.checked);
        updateSelUi();
      });
      img.addEventListener("click", () => openPhoto(p));
      els.photoGrid.appendChild(wrap);
    }
    els.empty.classList.toggle("hidden", state.folders.length + state.photos.length > 0);
  }

  function applyZoom() {
    const { scale, x, y } = state.zoom;
    els.modalImg.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${scale})`;
  }

  function resetZoom() {
    state.zoom = { scale: 1, x: 0, y: 0, min: 1, max: 5 };
    const img = els.modalImg;
    const stage = els.zoomStage;
    if (!img.naturalWidth || !stage) return;
    const fit = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
    img.style.width = `${img.naturalWidth * fit}px`;
    img.style.height = `${img.naturalHeight * fit}px`;
    applyZoom();
  }

  function clampPan() {
    const stage = els.zoomStage;
    const img = els.modalImg;
    const maxX = Math.max(0, (img.clientWidth * state.zoom.scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.clientHeight * state.zoom.scale - stage.clientHeight) / 2);
    state.zoom.x = Math.min(maxX, Math.max(-maxX, state.zoom.x));
    state.zoom.y = Math.min(maxY, Math.max(-maxY, state.zoom.y));
  }

  function setupZoom() {
    const stage = els.zoomStage;
    if (!stage || stage._ready) return;
    stage._ready = true;
    let pointers = new Map();
    let lastDist = 0;
    let lastTap = 0;
    stage.addEventListener("pointerdown", (e) => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
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
        applyZoom();
      } else if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (lastDist > 0) {
          state.zoom.scale = Math.min(5, Math.max(1, state.zoom.scale * (d / lastDist)));
          clampPan();
          applyZoom();
        }
        lastDist = d;
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) lastDist = 0;
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("click", () => {
      const now = Date.now();
      if (now - lastTap < 280) {
        state.zoom.scale = state.zoom.scale > 1.2 ? 1 : 2.5;
        if (state.zoom.scale === 1) {
          state.zoom.x = 0;
          state.zoom.y = 0;
        }
        clampPan();
        applyZoom();
      }
      lastTap = now;
    });
  }

  function hideMap() {
    els.modalLoc.classList.add("hidden");
    els.mapFrame.classList.add("hidden");
    els.mapFrame.innerHTML = "";
    els.modalMaps.classList.add("hidden");
    els.modalLocBtn.classList.remove("hidden");
  }

  function showMap(photo) {
    if (photo?.lat == null) return toast("위치 정보 없음");
    els.modalLoc.textContent = `위치: ${photo.lat.toFixed(6)}, ${photo.lng.toFixed(6)}`;
    els.modalLoc.classList.remove("hidden");
    els.modalMaps.href = `https://www.openstreetmap.org/?mlat=${photo.lat}&mlon=${photo.lng}#map=17/${photo.lat}/${photo.lng}`;
    els.modalMaps.classList.remove("hidden");
    els.modalLocBtn.classList.add("hidden");
    els.mapFrame.classList.remove("hidden");
    els.mapFrame.innerHTML = `<iframe title="지도" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${photo.lng - 0.01}%2C${photo.lat - 0.008}%2C${photo.lng + 0.01}%2C${photo.lat + 0.008}&layer=mapnik&marker=${photo.lat}%2C${photo.lng}"></iframe>`;
  }

  let currentPhoto = null;
  function openPhoto(photo) {
    currentPhoto = photo;
    hideMap();
    setupZoom();
    els.modalImg.onload = () => {
      resetZoom();
      els.modalSize.textContent = `${els.modalImg.naturalWidth}×${els.modalImg.naturalHeight}`;
    };
    els.modalImg.src = photo.url;
    els.modalName.textContent = photo.name;
    els.modalTime.textContent = photo.takenAt
      ? new Date(photo.takenAt).toLocaleString("ko-KR")
      : "";
    els.modalDownload.href = photo.url;
    els.modalDownload.download = photo.name;
    els.modalLocBtn.disabled = photo.lat == null;
    if (typeof els.photoModal.showModal === "function") els.photoModal.showModal();
    setTimeout(resetZoom, 40);
  }

  function closePhoto() {
    if (els.photoModal.open) els.photoModal.close();
    hideMap();
    currentPhoto = null;
  }

  async function downloadSelected() {
    const paths = [...state.selected];
    if (!paths.length) return;
    const res = await fetch(`/api/share/${encodeURIComponent(token)}/download-zip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) throw new Error("다운로드 실패");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `share_${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  els.btnBack.addEventListener("click", goBack);
  els.btnSelectAll.addEventListener("click", () => {
    const allOn = state.photos.every((p) => state.selected.has(p.path));
    state.selected.clear();
    if (!allOn) state.photos.forEach((p) => state.selected.add(p.path));
    [...els.photoGrid.children].forEach((card, i) => {
      const on = state.selected.has(state.photos[i]?.path);
      card.classList.toggle("selected", on);
      const cb = card.querySelector("input");
      if (cb) cb.checked = on;
    });
    updateSelUi();
  });
  els.btnDownload.addEventListener("click", () => downloadSelected().catch((e) => toast(e.message)));
  $("#modalClose").addEventListener("click", closePhoto);
  els.modalLocBtn.addEventListener("click", () => currentPhoto && showMap(currentPhoto));

  (async () => {
    try {
      await ensureAccess();
      await load();
    } catch (e) {
      document.body.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
    }
  })();
})();
