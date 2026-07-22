// ReWiseEd discovery — shared OpenAlex helpers for related papers,
// topic-based recommendations, and author/institution profiles.
// All keyless. Data quality caveats are surfaced in the UI, not hidden.
(function () {
  'use strict';
  const { esc, icon } = window.Rewiseed;
  const OA = 'https://api.openalex.org';
  const T = (u, o) => window.Rewiseed.fetchWithTimeout(u, { timeout: 20000, ...(o || {}) });
  const shortId = (id) => String(id || '').replace('https://openalex.org/', '');

  const firstAuthor = (w) => (w.authorships?.[0]?.author?.display_name || 'Unknown').split(' ').pop();
  const authorLine = (w) => {
    const names = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean);
    return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '') || 'Unknown authors';
  };

  async function relatedFor(idOrDoi) {
    const isDoi = /^10\.\d{4,9}\//.test(idOrDoi);
    const path = isDoi ? `doi:${encodeURIComponent(idOrDoi)}` : shortId(idOrDoi);
    const seed = await (await T(`${OA}/works/${path}?select=id,title,related_works,topics`)).json();
    const ids = (seed.related_works || []).slice(0, 8).map(shortId);
    let works = [];
    if (ids.length) {
      const r = await T(`${OA}/works?filter=openalex:${ids.join('|')}&per_page=8&select=id,doi,title,publication_year,authorships,cited_by_count,primary_location,open_access`);
      if (r.ok) works = (await r.json()).results || [];
    }
    works.sort((a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0));
    return { seed, works, topics: (seed.topics || []).slice(0, 3) };
  }

  // Papers matching a set of topic ids, excluding ids the user already has.
  async function byTopics(topicIds, excludeIds = [], perPage = 12) {
    if (!topicIds.length) return [];
    const filter = `topics.id:${topicIds.slice(0, 5).map(shortId).join('|')}`;
    const r = await T(`${OA}/works?filter=${filter}&sort=cited_by_count:desc&per_page=${perPage + excludeIds.length}&select=id,doi,title,publication_year,authorships,cited_by_count,primary_location,topics,open_access`);
    if (!r.ok) throw new Error(`OpenAlex returned ${r.status}`);
    const ex = new Set(excludeIds.map(x => shortId(x).toLowerCase()));
    const exDois = new Set(excludeIds.filter(x => /^10\./.test(x)).map(x => x.toLowerCase()));
    return ((await r.json()).results || [])
      .filter(w => !ex.has(shortId(w.id).toLowerCase()) && !exDois.has((w.doi || '').replace('https://doi.org/', '').toLowerCase()))
      .slice(0, perPage);
  }

  function paperCard(w, opts = {}) {
    const doi = (w.doi || '').replace('https://doi.org/', '');
    const venue = w.primary_location?.source?.display_name || '';
    return `<article class="paper" style="padding:14px 16px">
      <h3 style="font-size:15px">${esc(w.title || 'Untitled')}</h3>
      <div class="meta">${esc(authorLine(w))} · ${esc(venue) || 'Unknown venue'} · ${w.publication_year || 'n.d.'}</div>
      <div class="paper-foot">
        <span class="badge">${(w.cited_by_count || 0).toLocaleString()} citations</span>
        ${w.open_access ? (w.open_access.is_oa ? '<span class="badge ok">open access</span>' : '<span class="badge warn" title="Full text requires publisher or library access — details here come from public metadata and the abstract only">paywalled</span>') : ''}
        <span class="links">
          ${doi ? `<a class="link" href="https://doi.org/${esc(doi)}" target="_blank" rel="noopener noreferrer">DOI ${icon('external', 12)}</a>` : ''}
          <a class="link" href="${esc(w.id)}" target="_blank" rel="noopener noreferrer">OpenAlex ${icon('external', 12)}</a>
          ${opts.exploreLink !== false ? `<a class="link" href="citation-graph.html?q=${encodeURIComponent(doi || shortId(w.id))}">Map citations ${icon('arrow', 12)}</a>` : ''}
          <button class="ghost" style="min-height:30px;padding:3px 11px;font-size:12px" data-savew='${esc(JSON.stringify({
            doi, title: w.title || 'Untitled',
            authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean).slice(0, 12),
            year: w.publication_year, venue, url: w.id,
          }))}'>${icon('library', 12)} Save</button>
        </span>
      </div>
    </article>`;
  }

  function wireSaveButtons(root) {
    root.querySelectorAll('[data-savew]').forEach(b => b.onclick = () => {
      try { window.Rewiseed.saveToLibrary(JSON.parse(b.dataset.savew), b); }
      catch { window.Rewiseed.toast('Could not read that paper', 'error'); }
    });
  }

  // Renders a "papers like this" panel into `container`.
  async function renderRelated(container, idOrDoi) {
    container.innerHTML = `<div class="stream-status" style="margin-top:10px"><span class="spinner"></span>Finding related work…</div>`;
    try {
      const { works, topics } = await relatedFor(idOrDoi);
      if (!works.length) {
        container.innerHTML = `<p class="hint" style="margin:8px 0 0">OpenAlex lists no related works for this paper. Coverage is thinner for very recent, non-English, and non-journal outputs.</p>`;
        return;
      }
      container.innerHTML = `
        ${topics.length ? `<p class="hint" style="margin:6px 0 10px">Shared topics: ${topics.map(t => `<span class="badge">${esc(t.display_name)}</span>`).join(' ')}</p>` : ''}
        ${works.map(w => paperCard(w)).join('')}
        <p class="hint" style="margin:6px 0 0">Related works come from OpenAlex's similarity model — a starting point, not a systematic search.${works.some(w => w.open_access && !w.open_access.is_oa) ? ' ' + PAYWALL_NOTE : ''}</p>`;
      wireSaveButtons(container);
    } catch (e) {
      container.innerHTML = `<div class="error-box" style="margin-top:10px">${icon('alert', 16)}<span>${esc(e.message)}</span></div>`;
    }
  }

  async function authorSearch(q) {
    const r = await T(`${OA}/authors?search=${encodeURIComponent(q)}&per_page=5&select=id,display_name,display_name_alternatives,works_count,cited_by_count,summary_stats,counts_by_year,last_known_institutions,affiliations,orcid`);
    if (!r.ok) throw new Error(`OpenAlex returned ${r.status}`);
    return (await r.json()).results || [];
  }
  async function institutionSearch(q) {
    const r = await T(`${OA}/institutions?search=${encodeURIComponent(q)}&per_page=5&select=id,display_name,works_count,cited_by_count,country_code,type,homepage_url,summary_stats,counts_by_year`);
    if (!r.ok) throw new Error(`OpenAlex returned ${r.status}`);
    return (await r.json()).results || [];
  }
  // fetch the authoritative single record by id — freshest summary_stats + yearly counts
  async function entityById(kind, id) {
    const sel = kind === 'author'
      ? 'id,display_name,display_name_alternatives,works_count,cited_by_count,summary_stats,counts_by_year,last_known_institutions,affiliations,orcid'
      : 'id,display_name,works_count,cited_by_count,country_code,type,homepage_url,summary_stats,counts_by_year';
    const r = await T(`${OA}/${kind === 'author' ? 'authors' : 'institutions'}/${shortId(id)}?select=${sel}`);
    return r.ok ? await r.json() : null;
  }
  async function topWorks(filterKey, id, n = 6) {
    const r = await T(`${OA}/works?filter=${filterKey}:${shortId(id)}&sort=cited_by_count:desc&per_page=${n}&select=id,doi,title,publication_year,authorships,cited_by_count,primary_location,open_access`);
    return r.ok ? ((await r.json()).results || []) : [];
  }

  // Second, independent source for author metrics — Semantic Scholar (Allen Institute for AI).
  // Fetched through OUR server proxy (/api/s2-author): same-origin (no CORS), cached, and able to
  // use a server-side API key. Takes an OpenAlex author record. Matches the SAME researcher by
  // ORCID when we have one; otherwise picks the canonical (highest-cited) profile among same-surname
  // candidates — fragments have tiny counts, the merged record dominates.
  const shapeS2 = (p, matchedBy) => ({
    name: p.name, url: p.url, matchedBy,
    hIndex: p.hIndex, citationCount: p.citationCount, paperCount: p.paperCount,
    orcid: (p.externalIds?.ORCID || [])[0] || null,
  });
  async function semanticScholarAuthor(author) {
    if (!author) return null;
    const orcid = String(author.orcid || '').replace(/^https?:\/\/orcid\.org\//i, '').trim() || null;
    // OpenAlex sometimes localises the display name (e.g. Cyrillic); Semantic Scholar is Latin-indexed,
    // so query with a clean Latin-script name — display name if it already is one, else an alternative.
    const names = [author.display_name, ...(author.display_name_alternatives || [])].filter(Boolean);
    const clean = /^[A-Za-z][A-Za-z .,'’\-]*$/;
    const query = names.find(n => clean.test(n.trim())) || names.find(n => /[A-Za-z]/.test(n)) || author.display_name;
    if (!query) return null;
    let r;
    try { r = await T(`/api/s2-author?query=${encodeURIComponent(query)}`); }
    catch { return null; } // network/timeout or S2 rate-limit (429) — degrade to OpenAlex only
    if (!r.ok) return null;
    const data = (await r.json().catch(() => null))?.data || [];
    if (!data.length) return null;
    // 1) exact same researcher by ORCID
    if (orcid) {
      const m = data.find(a => (a.externalIds?.ORCID || []).map(x => String(x).trim()).includes(orcid));
      if (m) return shapeS2(m, 'orcid');
    }
    // 2) canonical profile for this name: prefer same-surname candidates, then most citations
    const surname = String(query).trim().split(/\s+/).pop().toLowerCase().replace(/[.,]/g, '');
    const byName = surname.length > 1 ? data.filter(a => String(a.name || '').toLowerCase().includes(surname)) : [];
    const pool = byName.length ? byName : data;
    pool.sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));
    return shapeS2(pool[0], 'name');
  }

  // Shown wherever a list may contain paywalled papers.
  const PAYWALL_NOTE = 'About paywalled papers: details shown here come from public metadata and the abstract only. For complete and authoritative content — full methods, results, tables, and exact quotations — please consult the publisher’s version via the DOI link or your institution’s library access.';

  window.RewiseedDiscovery = {
    relatedFor, byTopics, renderRelated, paperCard, wireSaveButtons,
    authorSearch, institutionSearch, entityById, topWorks, semanticScholarAuthor, shortId, authorLine, PAYWALL_NOTE,
  };
})();
