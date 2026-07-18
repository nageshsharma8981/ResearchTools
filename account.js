// ReWiseEd accounts — client runtime: API helper, drag-to-match captcha,
// photo resize. Used by signup / signin / profile / admin pages.
(function () {
  'use strict';
  const { esc, icon, toast } = window.Rewiseed;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      credentials: 'same-origin',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- drag-to-match captcha ----------
  // Server issues 3 emoji + 3 shuffled names; user drags (or taps) each emoji
  // onto its name; server verifies and returns a one-time token.
  function mountCaptcha(containerId) {
    const root = document.getElementById(containerId);
    let token = null, state = null, selected = null;

    async function load() {
      token = null;
      root.innerHTML = `<div class="stream-status"><span class="spinner"></span>Loading puzzle…</div>`;
      try {
        state = await api('/api/captcha');
      } catch (e) {
        root.innerHTML = `<div class="error-box">${icon('alert', 16)}<span>${esc(e.message)}</span> <button type="button" class="ghost" id="${containerId}-retry" style="min-height:32px;padding:4px 12px">Retry</button></div>`;
        document.getElementById(`${containerId}-retry`).onclick = load;
        return;
      }
      const placed = {};
      root.innerHTML = `
        <div class="cap-box">
          <div class="field-label" style="margin-bottom:8px">${icon('shield', 14)} Quick check: drag each symbol onto its name <span class="hint" style="display:inline">(or tap symbol, then tap name)</span></div>
          <div class="cap-items">${state.items.map(e => `<button type="button" class="cap-item" data-emoji="${esc(e)}" aria-label="symbol ${esc(e)}">${esc(e)}</button>`).join('')}</div>
          <div class="cap-slots">${state.targets.map(n => `<div class="cap-slot" data-name="${esc(n)}" tabindex="0" role="button" aria-label="target ${esc(n)}"><span class="cap-label">${esc(n)}</span></div>`).join('')}</div>
          <div class="cap-status" id="${containerId}-status"></div>
        </div>`;

      const items = [...root.querySelectorAll('.cap-item')];
      const slots = [...root.querySelectorAll('.cap-slot')];

      function place(emoji, slot) {
        // if emoji already placed elsewhere, free it
        for (const n of Object.keys(placed)) if (placed[n] === emoji) { delete placed[n]; }
        const prev = placed[slot.dataset.name];
        placed[slot.dataset.name] = emoji;
        slots.forEach(s => {
          const e = placed[s.dataset.name];
          s.classList.toggle('filled', !!e);
          s.querySelector('.cap-label').textContent = e ? `${e} ${s.dataset.name}` : s.dataset.name;
        });
        items.forEach(b => {
          const used = Object.values(placed).includes(b.dataset.emoji);
          b.classList.toggle('used', used);
        });
        if (prev) { /* replaced emoji returns to pool via classList refresh above */ }
        selected = null;
        items.forEach(b => b.classList.remove('selected'));
        if (Object.keys(placed).length === 3) submit();
      }

      async function submit() {
        const status = document.getElementById(`${containerId}-status`);
        status.innerHTML = `<span class="spinner"></span>`;
        try {
          const r = await api('/api/captcha/verify', { method: 'POST', body: { id: state.id, mapping: placed } });
          token = r.token;
          status.innerHTML = `<span class="badge ok">${icon('check', 12)} verified</span>`;
        } catch (e) {
          status.innerHTML = '';
          root.classList.add('cap-shake');
          setTimeout(() => root.classList.remove('cap-shake'), 400);
          toast(e.message, 'error');
          load();
        }
      }

      items.forEach(b => {
        b.draggable = true;
        b.addEventListener('dragstart', ev => ev.dataTransfer.setData('text/plain', b.dataset.emoji));
        b.addEventListener('click', () => {
          selected = selected === b.dataset.emoji ? null : b.dataset.emoji;
          items.forEach(x => x.classList.toggle('selected', x.dataset.emoji === selected));
        });
      });
      slots.forEach(s => {
        s.addEventListener('dragover', ev => { ev.preventDefault(); s.classList.add('over'); });
        s.addEventListener('dragleave', () => s.classList.remove('over'));
        s.addEventListener('drop', ev => { ev.preventDefault(); s.classList.remove('over'); place(ev.dataTransfer.getData('text/plain'), s); });
        const tap = () => { if (selected) place(selected, s); };
        s.addEventListener('click', tap);
        s.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tap(); } });
      });
    }

    load();
    return {
      getToken: () => token,
      reset: load,
    };
  }

  // ---------- photo: resize to 256px JPEG data URL ----------
  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a PNG, JPEG, or WebP image.'));
      if (file.size > 8_000_000) return reject(new Error('Image too large (8 MB max).'));
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = URL.createObjectURL(file);
    });
  }

  window.RewiseedAccount = { api, mountCaptcha, resizePhoto };
})();
