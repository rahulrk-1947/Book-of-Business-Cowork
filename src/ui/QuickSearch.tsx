/**
 * Quick search — a command-palette overlay. Open it from anywhere with the
 * keyboard (Cmd/Ctrl+K or "/") or the top-bar search box. Type to find a
 * contact, invoice/bill/credit, account or journal; arrow keys to move,
 * Enter to jump straight there.
 */
import React, { useEffect, useRef, useState } from 'react';
import { api, money } from './api';
import { openSource } from './components';
import { nav } from './App';

type Hit = any;

export function QuickSearch({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<Array<{ type: string; label: string; hits: Hit[] }>>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Flatten for keyboard navigation.
  const flat: Hit[] = groups.flatMap((g) => g.hits);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setGroups([]); setActive(0); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api('search.global', term);
        if (!cancelled) { setGroups(r.groups ?? []); setActive(0); }
      } catch { if (!cancelled) setGroups([]); }
      finally { if (!cancelled) setLoading(false); }
    }, 160);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  function openHit(h: Hit) {
    onClose();
    if (h.open.kind === 'source') openSource(h.open.source, h.open.id);
    else nav(h.open.hash);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[active]) openHit(flat[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }

  let runningIndex = -1;
  return (
    <div className="qs-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="qs-panel" role="dialog" aria-label="Quick search">
        <input
          ref={inputRef}
          className="qs-input"
          placeholder="Search invoices, bills, contacts, accounts, journals…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="qs-results">
          {q.trim() === '' && (
            <div className="qs-empty">
              Start typing to search across your whole organisation.
              <div className="qs-hint">Tip: open this anytime with <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> or <kbd>/</kbd></div>
            </div>
          )}
          {q.trim() !== '' && !loading && flat.length === 0 && (
            <div className="qs-empty">No matches for “{q.trim()}”.</div>
          )}
          {groups.map((g) => (
            <div key={g.type} className="qs-group">
              <div className="qs-group-label">{g.label}</div>
              {g.hits.map((h) => {
                runningIndex += 1;
                const idx = runningIndex;
                return (
                  <button
                    key={`${h.type}-${h.id}`}
                    className={`qs-hit${idx === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => openHit(h)}
                  >
                    <span className="qs-hit-main">
                      <span className="qs-hit-title">{h.title}</span>
                      {h.subtitle && <span className="qs-hit-sub">{h.subtitle}</span>}
                    </span>
                    {h.badge && <span className="qs-hit-badge">{h.badge}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="qs-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
