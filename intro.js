// ReWiseEd cinematic intro — scripted first-sign-in tour.
// Auto-advancing scenes, skippable, keyboard-driven, reduced-motion aware.
(function () {
  'use strict';
  const { icon, esc } = window.Rewiseed;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SCENE_MS = REDUCED ? 999999 : 5200; // reduced motion: manual advance only

  function scenes(name) {
    return [
      { kicker: 'ItsMyResearch', h: 'Research, done <em>systematically.</em>',
        p: 'A complete research workbench that runs in your browser — organised around the way research actually works, private by architecture, honest about AI.' },
      { kicker: 'The whole process', pipe: true, h: 'Seven steps, <em>one workbench.</em>',
        p: 'Every tool sits at the step where you actually need it — from defining the problem to publishing the paper. Follow the path, or jump to your step.' },
      { kicker: 'Steps I–II', icons: ['gap', 'search', 'graph'], h: 'Define the problem. <em>Map the field.</em>',
        p: 'Surface the gap that becomes your question, then search 240M+ works, walk citation networks, and synthesise the literature — all without an API key.' },
      { kicker: 'Steps III–V', icons: ['flask', 'clipboard', 'globe'], h: 'Design studies that <em>hold up.</em>',
        p: 'Turn topics into testable hypotheses, build validated surveys and interview guides, plan the analysis early, and gather data from official sources.' },
      { kicker: 'Step VI', icons: ['sigma', 'dna', 'shield'], h: 'Analyse with <em>rigour.</em>',
        p: 'Full PLS-SEM, mediation and regression on a drag-and-drop canvas; reflexive thematic coding for qualitative data — your data never leaves your device.' },
      { kicker: 'Step VII', icons: ['doc', 'grad', 'book'], h: 'Write, check, and <em>publish.</em>',
        p: 'Draft the paper, verify every citation, face a journal-grade reviewer, format in six styles — then submit to our own peer-reviewed open-access journal.' },
      { kicker: 'Private by architecture', icons: ['key'], h: 'Your work never <em>leaves you.</em>',
        p: 'Documents, transcripts, and AI keys stay in your browser. We can’t leak what we never receive.' },
      { finale: true, kicker: 'You’re all set', h: `Welcome${name ? ', <em>' + esc(name.split(' ')[0]) + '</em>' : ''}.`,
        p: 'The home page lays out all seven steps — click any step to see its tools. The Tools menu (top right) goes everywhere.' },
    ];
  }

  function sceneHtml(s, i) {
    return `<div class="intro-scene" data-scene="${i}">
      ${s.icons ? `<div class="intro-icons">${s.icons.map(n => `<span class="ic">${icon(n, 30)}</span>`).join('')}</div>` : ''}
      ${s.pipe ? `<div class="intro-pipe">
        ${['Define', 'Review', 'Design', 'Collect', 'Analyse', 'Report'].map((x, j, a) => `
          <span class="chip" style="animation-delay:${250 + j * 200}ms">${x}</span>
          ${j < a.length - 1 ? `<span class="arr" style="animation-delay:${360 + j * 200}ms">${icon('arrow', 16)}</span>` : ''}`).join('')}
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
