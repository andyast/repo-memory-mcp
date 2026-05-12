(function() {
  let currentView = 'memories';
  let currentFilter = 'all';
  let project = {};

  function $q(sel) { return document.querySelector(sel); }
  function $$q(sel) { return document.querySelectorAll(sel); }
  function api(path, options) {
    return fetch(path, options).then(function(r) {
      return r.json().then(function(data) {
        if (!r.ok) throw new Error(data.error || 'Request failed');
        return data;
      });
    });
  }

  function postJson(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    if (s < 604800) return Math.floor(s/86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function shortSha(sha) {
    if (!sha) return '';
    return sha.slice(0, 7);
  }

  function renderStats(data) {
    $q('#totalMemories').textContent = data.total;
    $q('#activeCount').textContent = data.byStatus.active || 0;
    $q('#needsRevalidationCount').textContent = data.byStatus['needs-revalidation'] || 0;
    $q('#staleCount').textContent = data.byStatus.stale || 0;
    $q('#projectPath').textContent = data.project.projectRoot.replace('/Users/', '~/').replace('/home/', '~/');
    project = data.project;
  }

  function renderStatsDetails(data) {
    renderStats(data);
    var typeHtml = data.byType && data.byType.length
      ? data.byType.map(function(t) { return '<div class="stats-row"><span>' + escapeHtml(t.type) + '</span><strong>' + t.count + '</strong></div>'; }).join('')
      : '<p class="stats-muted">No memory types yet.</p>';
    var tagHtml = data.topTags && data.topTags.length
      ? '<div class="tag-cloud">' + data.topTags.map(function(t) { return '<span class="memory-tag">' + escapeHtml(t.tag) + ' <strong>' + t.count + '</strong></span>'; }).join('') + '</div>'
      : '<p class="stats-muted">No tags yet.</p>';
    var auditHtml = data.recentAudit && data.recentAudit.byOperation.length
      ? data.recentAudit.byOperation.map(function(a) { return '<div class="stats-row"><span>' + escapeHtml(a.operation) + '</span><strong>' + a.count + '</strong></div>'; }).join('')
      : '<p class="stats-muted">No recent audit activity.</p>';
    var reval = data.lastRevalidation
      ? '<div class="stats-kv"><span>Ran</span><strong>' + timeAgo(data.lastRevalidation.createdAt) + '</strong></div>' +
        '<div class="stats-kv"><span>Affected</span><strong>' + data.lastRevalidation.affectedCount + '</strong></div>' +
        '<div class="stats-kv"><span>Range</span><code>' + shortSha(data.lastRevalidation.fromSha) + ' → ' + shortSha(data.lastRevalidation.toSha) + '</code></div>' +
        '<div class="stats-muted">' + (data.lastRevalidation.changedFiles || []).slice(0, 5).map(escapeHtml).join(', ') + '</div>'
      : '<p class="stats-muted">No revalidation runs recorded.</p>';
    var reviewHtml = data.needsReview && data.needsReview.items.length
      ? data.needsReview.items.map(function(m) { return '<div class="stats-review-item" data-id="' + escapeHtml(m.id) + '"><div><strong>' + escapeHtml(m.title) + '</strong><span>' + escapeHtml(m.type) + ' · ' + timeAgo(m.updatedAt) + '</span></div><span class="memory-badge badge-' + m.status + '">' + escapeHtml(statusLabel(m.status)) + '</span></div>'; }).join('')
      : '<p class="stats-muted">Nothing currently needs review.</p>';

    $q('#statsDetails').innerHTML =
      '<div class="stats-panel"><h2>Memory Types</h2>' + typeHtml + '</div>' +
      '<div class="stats-panel"><h2>Top Tags</h2>' + tagHtml + '</div>' +
      '<div class="stats-panel"><h2>Artifacts</h2><div class="big-number">' + data.artifactCount + '</div><p class="stats-muted">Stored source artifacts and command outputs.</p></div>' +
      '<div class="stats-panel"><h2>Recent Audit Activity</h2>' + auditHtml + '</div>' +
      '<div class="stats-panel"><h2>Last Revalidation</h2>' + reval + '</div>' +
      '<div class="stats-panel wide"><h2>Review Queue <span>' + ((data.needsReview && data.needsReview.count) || 0) + '</span></h2>' + reviewHtml + '</div>';

    $q('#statsDetails').querySelectorAll('.stats-review-item').forEach(function(item) {
      item.addEventListener('click', function() { openMemory(item.dataset.id); });
    });
  }

  function loadStatsDetails() {
    $q('#loading').style.display = 'flex';
    $q('#loading p').textContent = 'Loading stats...';
    $q('#statsDetails').style.display = 'none';
    api('/api/stats').then(function(data) {
      $q('#loading').style.display = 'none';
      $q('#loading p').textContent = 'Loading memories...';
      $q('#statsDetails').style.display = 'grid';
      renderStatsDetails(data);
    });
  }

  function statusLabel(status) {
    return String(status || '').replace(/-/g, ' ');
  }

  function evidenceMeta(m) {
    var count = m.evidenceCount || 0;
    if (count > 0) return '<span title="Linked evidence">' + count + ' evidence</span>';
    if (m.sourceArtifactId) return '<span title="Source artifact">source-backed</span>';
    return '';
  }

  function actionButtons(id, status, compact) {
    var buttons = [];
    if (['proposed', 'needs-revalidation', 'stale', 'probably-active'].includes(status)) {
      buttons.push('<button class="memory-action-btn primary" data-id="' + escapeHtml(id) + '" data-action="verify">' + (status === 'proposed' ? 'Accept' : 'Verify') + '</button>');
    }
    if (status !== 'rejected') buttons.push('<button class="memory-action-btn" data-id="' + escapeHtml(id) + '" data-action="rejected">Reject</button>');
    if (status !== 'stale') buttons.push('<button class="memory-action-btn danger" data-id="' + escapeHtml(id) + '" data-action="stale">Mark stale</button>');
    if (!compact) buttons.push('<button class="memory-action-btn danger" data-id="' + escapeHtml(id) + '" data-action="delete">Delete</button>');
    return buttons.join('');
  }

  function renderMemoryCard(m) {
    var filesHtml = '';
    if (m.files && m.files.length > 0) {
      filesHtml = '<div class="memory-file-row">' +
        m.files.map(f => '<span class="memory-file-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>' + escapeHtml(f.split('/').pop()) + '</span>').join('') +
        '</div>';
    }

    var shaHtml = m.observedCommit ? '<span class="memory-sha">' + shortSha(m.observedCommit) + '</span>' : '';
    var evidenceHtml = evidenceMeta(m);
    var metaHtml = (evidenceHtml || shaHtml) ? '<div class="memory-meta-line">' + evidenceHtml + shaHtml + '</div>' : '';

    return '<div class="memory-card status-' + m.status + '" data-id="' + m.id + '">' +
      '<div class="memory-header">' +
        '<div class="memory-chip type-chip">' + escapeHtml(m.type) + '</div>' +
        '<div class="memory-badge badge-' + m.status + '">' + escapeHtml(statusLabel(m.status)) + '</div>' +
      '</div>' +
      '<div class="memory-title">' + escapeHtml(m.title) + '</div>' +
      '<div class="memory-claim">' + escapeHtml(m.claim) + '</div>' +
      '<div class="memory-tags">' + (m.tags || []).map(t => '<span class="memory-tag">' + escapeHtml(t) + '</span>').join('') + '</div>' +
      filesHtml +
      metaHtml +
    '</div>';
  }

  function renderReviewQueue(items) {
    var el = $q('#reviewQueue');
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = '<div class="review-queue-empty"><strong>Review queue clear.</strong><span>No proposed, stale, or needs-revalidation memories need attention.</span></div>';
      return;
    }
    el.innerHTML = '<div class="review-queue-header"><div><h2>Needs attention</h2><p>Proposed, stale, and revalidation items to clear first.</p></div><span>' + items.length + ' open</span></div>' +
      '<div class="review-list">' + items.map(function(m) {
        return '<article class="review-item status-' + m.status + '" data-id="' + escapeHtml(m.id) + '">' +
          '<div class="review-main"><div class="review-eyebrow"><span class="memory-badge badge-' + m.status + '">' + escapeHtml(statusLabel(m.status)) + '</span><span>' + escapeHtml(m.type) + '</span><span>' + timeAgo(m.updatedAt) + '</span></div>' +
          '<strong>' + escapeHtml(m.title) + '</strong></div>' +
          '<div class="review-actions">' + actionButtons(m.id, m.status, true) + '</div>' +
        '</article>';
      }).join('') + '</div>';
    el.querySelectorAll('.review-item').forEach(function(item) {
      item.addEventListener('click', function(e) {
        if (e.target.classList.contains('memory-action-btn')) return;
        openMemory(item.dataset.id);
      });
    });
    el.querySelectorAll('.memory-action-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); runMemoryAction(btn.dataset.id, btn.dataset.action, el); });
    });
  }

  function renderAuditItem(a) {
    var icons = {
      create: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><line x1="12" y1="22" x2="12" y2="15.5"/><polyline points="22 8.5 12 15.5 2 8.5"/></svg>',
      update_status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><line x1="12" y1="22" x2="12" y2="15.5"/><polyline points="22 8.5 12 15.5 2 8.5"/></svg>',
      revalidate_status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>',
      revalidate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>',
      delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 0 0 0-7.54-.54l-3 3a5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
      link_evidence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
      supersede: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
      verify: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
    };
    var icon = icons[a.operation] || icons.create;
    var reason = a.reason ? '<div class="audit-reason">' + escapeHtml(a.reason) + '</div>' : '';
    var metadata = renderAuditMetadata(a.metadata || {});
    return '<div class="audit-item">' +
      '<div class="audit-icon">' + icon + '</div>' +
      '<div class="audit-body">' +
        '<div class="audit-op">' + escapeHtml(a.operation) + ' <span>' + escapeHtml(a.targetType) + '</span></div>' +
        '<div class="audit-detail">' + escapeHtml(a.targetId) + '</div>' +
        reason +
        metadata +
      '</div>' +
      '<div class="audit-time">' + timeAgo(a.createdAt) + '</div>' +
    '</div>';
  }

  function renderAuditMetadata(metadata) {
    var entries = Object.entries(metadata || {}).filter(function(pair) {
      return pair[1] !== null && pair[1] !== undefined && pair[1] !== '';
    });
    if (!entries.length) return '';

    var preferred = ['title', 'memoryTitle', 'claim', 'status', 'previousStatus', 'artifactId', 'relation', 'quote', 'changedFiles', 'matchedFiles', 'affectedCount', 'headSha'];
    entries.sort(function(a, b) {
      var ai = preferred.indexOf(a[0]);
      var bi = preferred.indexOf(b[0]);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    return '<div class="audit-metadata">' + entries.map(function(pair) {
      var key = pair[0];
      var value = pair[1];
      var display = Array.isArray(value) ? value.join(', ') : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      if (display.length > 280) display = display.slice(0, 277) + '...';
      return '<div class="audit-meta-row"><span>' + escapeHtml(key) + '</span><code>' + escapeHtml(display) + '</code></div>';
    }).join('') + '</div>';
  }

  function loadMemories() {
    var q = $q('#searchInput').value;
    var params = '?limit=100';
    if (currentFilter !== 'all') params += '&status=' + currentFilter;
    if (q) params += '&q=' + encodeURIComponent(q);

    $q('#loading').style.display = 'flex';
    $q('#memoriesGrid').style.display = 'none';
    $q('#emptyState').style.display = 'none';

    api('/api/memories' + params).then(function(data) {
      $q('#loading').style.display = 'none';
      api('/api/stats').then(function(stats) {
        renderStats(stats);
        renderReviewQueue(stats.needsReview && stats.needsReview.items);
      });
      if (data.memories.length === 0) {
        $q('#emptyState').style.display = 'flex';
        $q('#memoriesGrid').style.display = 'none';
      } else {
        $q('#memoriesGrid').style.display = 'grid';
        $q('#memoriesGrid').innerHTML = data.memories.map(renderMemoryCard).join('');
        $q('#memoriesGrid').querySelectorAll('.memory-card').forEach(function(card) {
          card.addEventListener('click', function() {
            openMemory(card.dataset.id);
          });
        });
      }
    });
  }

  function loadAudit() {
    $q('#loading').style.display = 'flex';
    api('/api/audit').then(function(data) {
      $q('#loading').style.display = 'none';
      $q('#auditList').innerHTML = data.audit.length > 0
        ? data.audit.map(renderAuditItem).join('')
        : '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><h3>No audit entries yet</h3><p>Actions like storing, marking, or deleting memories will appear here.</p></div>';
    });
  }

  function openMemory(id) {
    api('/api/memory/' + id).then(function(m) {
      var body = '<div class="modal-type">' + escapeHtml(m.type) + '</div>' +
        '<div class="modal-title">' + escapeHtml(m.title) + '</div>' +
        '<div class="modal-claim">' + escapeHtml(m.claim) + '</div>';

      if (m.rationale) {
        body += '<div class="modal-rationale"><strong>Rationale:</strong> ' + escapeHtml(m.rationale) + '</div>';
      }

      body += '<div class="modal-meta">' +
        '<div class="memory-badge badge-' + m.status + '">' + escapeHtml(m.status) + '</div>' +
        (m.tags || []).map(t => '<span class="memory-tag">' + escapeHtml(t) + '</span>').join('') +
        '</div>';

      if (m.files && m.files.length > 0) {
        body += '<div>' + m.files.map(f => '<span class="memory-file-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>' + escapeHtml(f) + '</span>').join(' ') + '</div>';
      }

      if (m.observedCommit || m.lastVerifiedCommit) {
        body += '<div class="modal-commits">' +
          (m.observedCommit ? 'Observed at: ' + m.observedCommit + '<br>' : '') +
          (m.lastVerifiedCommit ? 'Last verified at: ' + m.lastVerifiedCommit : '') +
          '</div>';
      }

      if (m.evidence && m.evidence.length > 0) {
        body += '<div class="modal-evidence"><strong>Evidence:</strong>' + m.evidence.map(function(e) {
          var quote = e.quote ? '<blockquote>' + escapeHtml(e.quote) + '</blockquote>' : '';
          var preview = e.preview ? '<pre>' + escapeHtml(e.preview) + '</pre>' : '';
          return '<div class="evidence-card"><div><span class="memory-tag">' + escapeHtml(e.relation) + '</span> <strong>' + escapeHtml(e.title) + '</strong> <code>' + escapeHtml(e.artifactId) + '</code></div>' + quote + preview + '</div>';
        }).join('') + '</div>';
      }

      body += '<div class="modal-actions" data-memory-id="' + escapeHtml(m.id) + '">' +
        '<button class="memory-action-btn primary" data-action="verify">Accept / verify</button>' +
        '<button class="memory-action-btn danger" data-action="stale">Mark stale</button>' +
        '<button class="memory-action-btn" data-action="historical">Mark historical</button>' +
        '<button class="memory-action-btn" data-action="rejected">Reject</button>' +
        '<button class="memory-action-btn danger" data-action="delete">Delete</button>' +
        '<div class="modal-action-message" role="status"></div>' +
        '</div>';

      body += '<div style="margin-top:16px;font-size:.8rem;color:var(--text-muted)">' +
        'Created ' + timeAgo(m.createdAt) + (m.updatedAt !== m.createdAt ? ' &middot; Updated ' + timeAgo(m.updatedAt) : '') +
        '</div>';

      $q('#modalBody').innerHTML = body;
      var actions = $q('#modalBody .modal-actions');
      if (actions) attachMemoryActions(actions, m.id);
      $q('#memoryModal').classList.add('open');
    });
  }

  function attachMemoryActions(actions, id) {
    actions.addEventListener('click', function(e) {
      if (!e.target.classList.contains('memory-action-btn')) return;
      var button = e.target;
      var action = button.dataset.action;
      var message = actions.querySelector('.modal-action-message');
      actions.querySelectorAll('button').forEach(function(btn) { btn.disabled = true; });
      message.textContent = 'Saving...';
      memoryActionRequest(id, action).then(function() {
        $q('#memoryModal').classList.remove('open');
        loadMemories();
        if (currentView === 'audit') loadAudit();
      }).catch(function(err) {
        message.textContent = err.message || 'Action failed';
        actions.querySelectorAll('button').forEach(function(btn) { btn.disabled = false; });
        alert(message.textContent);
      });
    });
  }

  function memoryActionRequest(id, action) {
    var encodedId = encodeURIComponent(id);
    return action === 'verify'
      ? postJson('/api/memory/' + encodedId + '/verify', {})
      : action === 'delete'
        ? postJson('/api/memory/' + encodedId + '/delete', { reason: 'Deleted from dashboard' })
        : postJson('/api/memory/' + encodedId + '/status', { status: action });
  }

  function runMemoryAction(id, action, scope) {
    scope.querySelectorAll('.memory-action-btn').forEach(function(btn) { btn.disabled = true; });
    memoryActionRequest(id, action).then(function() {
      loadMemories();
      if (currentView === 'stats') loadStatsDetails();
    }).catch(function(err) {
      alert((err && err.message) || 'Action failed');
      scope.querySelectorAll('.memory-action-btn').forEach(function(btn) { btn.disabled = false; });
    });
  }

  function switchView(view) {
    currentView = view;
    $$q('.nav-item').forEach(function(el) {
      el.classList.toggle('active', el.dataset.view === view);
    });
    $q('#pageTitle').textContent = view === 'memories' ? 'Memories' : view === 'audit' ? 'Audit Log' : 'Stats';
    $q('#filters').style.display = view === 'memories' ? 'flex' : 'none';
    $q('#reviewQueue').style.display = view === 'memories' ? 'block' : 'none';
    $q('#searchInput').parentElement.style.display = view !== 'audit' ? '' : 'none';
    $q('#memoriesGrid').style.display = view === 'memories' ? 'grid' : 'none';
    $q('#auditList').style.display = view === 'audit' ? 'flex' : 'none';
    $q('#statsDetails').style.display = view === 'stats' ? 'grid' : 'none';
    $q('#emptyState').style.display = 'none';

    if (view === 'memories') loadMemories();
    else if (view === 'audit') loadAudit();
    else if (view === 'stats') loadStatsDetails();
  }

  // Init
  api('/api/stats').then(function(data) {
    renderStats(data);
    loadMemories();
  });

  // Events
  function closeMemoryModal() {
    $q('#memoryModal').classList.remove('open');
  }

  $q('.modal-close').addEventListener('click', closeMemoryModal);
  $q('#memoryModal .modal-backdrop').addEventListener('click', closeMemoryModal);
  window.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && $q('#memoryModal').classList.contains('open')) closeMemoryModal();
  });

  $q('#searchInput').addEventListener('input', function() {
    if (currentView === 'memories') loadMemories();
  });

  $q('#filters').addEventListener('click', function(e) {
    if (!e.target.classList.contains('filter-btn')) return;
    $$q('.filter-btn').forEach(function(btn) { btn.classList.remove('active'); });
    e.target.classList.add('active');
    currentFilter = e.target.dataset.filter;
    loadMemories();
  });

  $$q('.nav-item').forEach(function(item) {
    item.addEventListener('click', function(e) {
      e.preventDefault();
      switchView(item.dataset.view);
    });
  });

  $q('#themeToggle').addEventListener('click', function() {
    var html = document.documentElement;
    var next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    try { localStorage.setItem('repo-memory-theme', next); } catch(_) {}
  });

  try {
    var saved = localStorage.getItem('repo-memory-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch(_) {}

  window.addEventListener('hashchange', function() {
    var view = location.hash.slice(1) || 'memories';
    if (['memories','audit','stats'].includes(view)) switchView(view);
  });

  if (location.hash && ['memories','audit','stats'].includes(location.hash.slice(1))) {
    switchView(location.hash.slice(1));
  }

  // Auto-refresh every 30 seconds
  setInterval(function() {
    if (currentView === 'memories') {
      api('/api/stats').then(renderStats);
    } else if (currentView === 'stats') {
      api('/api/stats').then(renderStatsDetails);
    }
  }, 30000);
})();
