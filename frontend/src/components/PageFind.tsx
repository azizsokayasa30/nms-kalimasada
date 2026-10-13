import { useEffect, useRef, useState } from 'react';

const ALL = 'page-find';
const CURRENT = 'page-find-current';

type Hit = { range?: Range; element?: HTMLElement };

type Registry = {
  set: (name: string, value: Highlight) => void;
  delete: (name: string) => void;
};

function registry(): Registry | null {
  const css = CSS as unknown as { highlights?: Registry };
  if (!css.highlights || typeof Highlight === 'undefined') return null;
  return css.highlights;
}

function clearFieldMarks(root: ParentNode | null) {
  root?.querySelectorAll('.find-field').forEach((el) => el.classList.remove('find-field', 'current'));
}

function clearMarks() {
  const store = registry();
  store?.delete(ALL);
  store?.delete(CURRENT);
  clearFieldMarks(document.getElementById('page-content'));
  window.getSelection()?.removeAllRanges();
}

function paint(root: HTMLElement | null, hits: Hit[], active: number) {
  clearFieldMarks(root);
  const store = registry();
  const rest: Range[] = [];
  let currentRange: Range | undefined;
  hits.forEach((hit, index) => {
    if (hit.element) {
      hit.element.classList.add('find-field');
      if (index === active) hit.element.classList.add('current');
    }
    if (!hit.range) return;
    if (index === active) currentRange = hit.range;
    else rest.push(hit.range);
  });
  if (!store) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    if (currentRange) selection?.addRange(currentRange);
    return;
  }
  if (rest.length) store.set(ALL, new Highlight(...rest));
  else store.delete(ALL);
  if (currentRange) {
    const current = new Highlight(currentRange);
    current.priority = 2;
    store.set(CURRENT, current);
  } else {
    store.delete(CURRENT);
  }
}

function skipBranch(node: Node) {
  return node instanceof HTMLScriptElement || node instanceof HTMLStyleElement || node instanceof HTMLElement && node.closest('script, style, noscript');
}

function addTextHits(node: Text, needle: string, hits: Hit[]) {
  const parent = node.parentElement;
  if (!parent || parent.closest('script, style, noscript')) return;
  if (!parent.getClientRects().length) return;
  const text = node.textContent ?? '';
  const lower = text.toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const index = lower.indexOf(needle, from);
    if (index < 0) break;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + needle.length);
    hits.push({ range });
    from = index + needle.length;
  }
}

function collect(root: HTMLElement, query: string) {
  const needle = query.trim().toLowerCase();
  const hits: Hit[] = [];
  if (!needle) return hits;
  const walk = (node: Node) => {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      if (node.type !== 'hidden' && node.type !== 'password' && node.value.toLowerCase().includes(needle)) {
        hits.push({ element: node });
      }
      return;
    }
    if (node instanceof HTMLSelectElement) {
      const label = node.selectedOptions[0]?.textContent ?? '';
      if (label.toLowerCase().includes(needle)) hits.push({ element: node });
      return;
    }
    if (skipBranch(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      addTextHits(node as Text, needle, hits);
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return hits;
}

function reveal(hit: Hit) {
  const node = hit.range?.startContainer;
  const el = hit.element ?? (node instanceof Element ? node : node?.parentElement);
  el?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
}

export function PageFind() {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const hitsRef = useRef<Hit[]>([]);
  const indexRef = useRef(0);
  const queryRef = useRef('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearMarks();
    };
  }, []);

  useEffect(() => {
    queryRef.current = query;
    let timer = 0;
    const run = (scroll: boolean) => {
      const root = document.getElementById('page-content');
      const hits = root ? collect(root, queryRef.current) : [];
      hitsRef.current = hits;
      const next = hits.length ? Math.min(indexRef.current, hits.length - 1) : 0;
      indexRef.current = next;
      setIndex(next);
      setTotal(hits.length);
      paint(root, hits, next);
      if (scroll && hits[next]) reveal(hits[next]);
    };
    const schedule = (scroll: boolean, delay: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => run(scroll), delay);
    };
    schedule(Boolean(query.trim()), 60);
    const root = document.getElementById('page-content');
    const observer = new MutationObserver(() => {
      if (!queryRef.current.trim()) return;
      schedule(false, 150);
    });
    if (root) observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [query]);

  function go(delta: number) {
    const hits = hitsRef.current;
    if (!hits.length) return;
    const next = (indexRef.current + delta + hits.length) % hits.length;
    indexRef.current = next;
    setIndex(next);
    paint(document.getElementById('page-content'), hits, next);
    reveal(hits[next]);
  }

  return (
    <form className="page-find" onSubmit={(event) => event.preventDefault()}>
      <input
        ref={inputRef}
        value={query}
        placeholder="Cari di halaman"
        aria-label="Cari teks di halaman"
        onChange={(event) => {
          indexRef.current = 0;
          setIndex(0);
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            go(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            indexRef.current = 0;
            setIndex(0);
            setQuery('');
          }
        }}
      />
      {query.trim() ? (
        <div className="page-find-row">
          <span aria-live="polite">{total ? `${index + 1}/${total}` : 'Tidak ada'}</span>
          <button type="button" aria-label="Sebelumnya" disabled={!total} onClick={() => go(-1)}>↑</button>
          <button type="button" aria-label="Berikutnya" disabled={!total} onClick={() => go(1)}>↓</button>
        </div>
      ) : null}
    </form>
  );
}

export function isFindPage(pathname: string) {
  return pathname === '/devices'
    || pathname.startsWith('/devices/')
    || pathname === '/topology'
    || pathname === '/mrtg'
    || pathname.startsWith('/mrtg/');
}
