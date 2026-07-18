// ReWiseEd cinematic intro — scripted first-sign-in tour.
// Auto-advancing scenes, skippable, keyboard-driven, reduced-motion aware.
(function () {
  'use strict';
  const { icon, esc } = window.Rewiseed;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SCENE_MS = REDUCED ? 999999 : 5200; // reduced motion: manual advance only

  function scenes(name) {
    return [
      { kicker: 'ReWiseEd Research', h: 'Research, done <em>properly.</em>',
        p: 'A complete research workbench that runs in your browser — private by architecture, honest about AI.' },
      { kicker: 'Discover', icons: ['search', 'doi', 'gap'], h: 'Start with the <em>literature.</em>',
        p: 'Search 240M+ scholarly works, resolve any DOI, and surface the gaps other researchers missed — all without an API key.' },
      { kicker: 'Design', icons: ['flask', 'clipboard'], h: 'Design studies that <em>hold up.</em>',
        p: 'Turn topics into testable research questions — IVs, DVs, controls, hypotheses — then generate the survey or interview guide to run them.' },
      { kicker: 'Analyze', icons: ['dna', 'shield'], h: 'Analyze with <em>integrity.</em>',
        p: 'Thematic coding for qualitative data, and originality signals that are honest about what they can and cannot prove.' },
      { kicker: 'Write & Review', icons: ['grad', 'book', 'doc'], h: 'Ship <em>publication-ready</em> work.',
        p: 'Face a rigorous simulated reviewer, perfect your citations, and download an APA 7 formatted Word document.' },
      { kicker: 'The pipeline', pipe: true, h: 'Everything <em>connects.</em>',
        p: 'One click carries your work from search results to gap analysis to research questions to instruments — no copy-paste.' },
      { kicker: 'Private by architecture', icons: ['key'], h: 'Your work never <em>leaves you.</em>',
        p: 'Documents, transcripts, and AI keys stay in your browser. We can’t leak what we never receive.' },
      { finale: true, kicker: 'You’re all set', h: `Welcome${name ? ', <em>' + esc(name.split(' ')[0]) + '</em>' : ''}.`,
        p: 'The Tools menu (top right) goes everywhere. Your avatar opens your profile. That’s all you need.' },
    ];
  }

  function sceneHtml(s, i) {
    return `<div class="intro-scene" data-scene="${i}">
      ${s.icons ? `<div class="intro-icons">${s.icons.map(n => `<span class="ic">${icon(n, 30)}</span>`).join('')}</div>` : ''}
      ${s.pipe ? `<div class="intro-pipe">
        ${['Discover', 'Design', 'Analyze', 'Write'].map((x, j) => `
          <span class="chip" style="animation-delay:${250 + j * 260}ms">${x}</span>
          ${j < 3 ? `<span class="arr" style="animation-delay:${380 + j * 260}ms">${icon('arrow', 18)}</span>` : ''}`).join('')}
      </div>` : ''}
      <div class="kicker">${s.kicker}</div>
      <h1>${s.h}</h1>
      <p>${s.p}</p>
      ${s.finale ? `<div class="intro-cta">
        <button type="button" class="go" data-intro-done>Start exploring ${icon('arrow', 16)}</button>
      </div>` : ''}
    </div>`;
  }

  function play(name) {
    return new Promise((resolve) => {
      const S = scenes(name);
      const ov = document.createElement('div');
      ov.className = 'intro-overlay';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-label', 'Platform introduction');
      ov.innerHTML = `
        <div class="intro-progress"></div>
        <button type="button" class="intro-skip">Skip intro (Esc)</button>
        ${S.map(sceneHtml).join('')}
        <div class="intro-dots">${S.map(() => '<span></span>').join('')}</div>`;
      document.body.appendChild(ov);
      document.body.style.overflow = 'hidden';
      void ov.offsetWidth; // force reflow so the fade-in transition runs even in throttled tabs
      ov.classList.add('on');

      let i = -1, timer = null;
      const els = ov.querySelectorAll('.intro-scene');
      const dots = ov.querySelectorAll('.intro-dots span');
      const bar = ov.querySelector('.intro-progress');

      function show(n) {
        if (n >= S.length) return finish();
        i = n;
        els.forEach((el, j) => el.classList.toggle('on', j === i));
        dots.forEach((d, j) => d.classList.toggle('on', j <= i));
        bar.style.width = `${((i + 1) / S.length) * 100}%`;
        clearTimeout(timer);
        if (!S[i].finale) timer = setTimeout(() => show(i + 1), SCENE_MS);
      }
      function finish() {
        clearTimeout(timer);
        document.removeEventListener('keydown', onKey);
        ov.classList.add('off');
        setTimeout(() => { ov.remove(); document.body.style.overflow = ''; resolve(); }, 650);
      }
      function onKey(e) {
        if (e.key === 'Escape') finish();
        else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
          if (!(e.target instanceof HTMLButtonElement)) { e.preventDefault(); show(i + 1); }
        } else if (e.key === 'ArrowLeft') show(Math.max(0, i - 1));
      }
      ov.querySelector('.intro-skip').onclick = finish;
      ov.addEventListener('click', (e) => {
        if (e.target.closest('[data-intro-done]')) return finish();
        if (e.target.closest('button')) return;
        show(i + 1); // click anywhere advances
      });
      document.addEventListener('keydown', onKey);
      show(0);
    });
  }

  window.RewiseedIntro = { play };
})();
