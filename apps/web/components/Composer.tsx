'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComposerState } from '@/lib/starter-send';

/**
 * The inbox message box: one expanding text input, a ＋ menu for the other ways to start a message (Templates, Starters, a quote)
 * and one Send button. It only draws what the parent decides: validation, the 24-hour window and permissions
 * all stay in `composerState` and on the server, and the keyboard shortcut is unchanged (Ctrl/Cmd+Enter sends).
 */
export function Composer({ state, text, onText, onSend, sending, chargesNotice, onTemplates, onStarters, onQuote, onUseApprovedTemplate }: {
  state: ComposerState; text: string; onText: (t: string) => void; onSend: () => void; sending: boolean; chargesNotice?: string | null;
  onTemplates: () => void; onStarters: () => void; onQuote: () => void; onUseApprovedTemplate: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null), wrap = useRef<HTMLDivElement>(null);

  // grow with the text, up to the CSS max-height, then scroll
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    // scrollHeight excludes the border, and the box is border-box: add it back or a scrollbar appears one line too early
    el.style.height = 'auto'; el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (!menu) return;
    const out = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', out); document.removeEventListener('keydown', esc); };
  }, [menu]);

  const pick = (fn: () => void) => () => { setMenu(false); fn(); };

  return (
    <div className="composer">
      {state.notice && (
        <div className="composer-notice" role="status" data-testid="composer-notice" title={state.noticeTitle ?? undefined}>
          <span>{state.notice}</span>
          {state.suggestMetaTemplate && <button className="btn sm" onClick={onUseApprovedTemplate}>Use an approved template</button>}
        </div>
      )}
      <div className="composer-row">
        <div className="plus-wrap" ref={wrap}>
          <button className="plus-btn" type="button" aria-label="More ways to start a message" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((o) => !o)}>＋</button>
          {menu && (
            <div className="plus-menu" role="menu">
              <button role="menuitem" onClick={pick(onTemplates)}><span aria-hidden="true">📋</span> Templates</button>
              <button role="menuitem" onClick={pick(onStarters)} title="Ready-made wording you fill in and edit (not WhatsApp templates)"><span aria-hidden="true">✨</span> Starters</button>
              <button role="menuitem" onClick={pick(onQuote)}><span aria-hidden="true">₹</span> Quote</button>
            </div>
          )}
        </div>
        <textarea
          ref={box} aria-label="Message" rows={1} placeholder={state.placeholder} disabled={!state.canType} value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && state.canSend) onSend(); }}
        />
        <button className="btn primary send-btn" disabled={!state.canSend} onClick={onSend}>{sending ? 'Sending…' : 'Send'}</button>
      </div>
      {chargesNotice && !state.notice && <div className="composer-foot" data-testid="charges-notice">{chargesNotice}</div>}
    </div>
  );
}
