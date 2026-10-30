'use client';
import { useEffect, useMemo, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { enteredValues, SendBlock } from '@/lib/starter-send';
import { ErrorBox, Field, Loading, Modal } from '@/components/ui';

interface StarterItem { key: string; label: string; description: string; fields: { name: string; label: string; auto: boolean }[] }
interface Rendered { text: string; missing: string[]; sendBlock: SendBlock | null; notice: string; fields: { name: string; label: string; value: string; auto: boolean }[] }

/**
 * TripOS message starters: five ready-made wordings that are filled for this customer and then edited by the agent. They are
 * ordinary free-form messages (not WhatsApp templates and never "approved"), so they can be used only while WhatsApp allows a
 * free-form reply. Inserting a starter only fills the message box; nothing is sent from here.
 */
export function StarterPicker({ conversationId, onInsert, onUseApprovedTemplate, onClose }: { conversationId: string; onInsert: (text: string) => void; onUseApprovedTemplate: () => void; onClose: () => void }) {
  const list = useApi<{ windowOpen: boolean; sendBlock: SendBlock | null; notice: string; items: StarterItem[] }>(`/inbox/conversations/${conversationId}/starter-templates`);
  const [key, setKey] = useState<string | null>(null), [edits, setEdits] = useState<Record<string, string>>({});
  const [r, setR] = useState<Rendered | null>(null), [err, setErr] = useState<Error | null>(null);
  const editKey = JSON.stringify(edits);

  useEffect(() => {
    if (!key) return;
    setErr(null);
    const t = setTimeout(() => {
      api(`/inbox/conversations/${conversationId}/starter-templates/${key}/render`, { body: { values: enteredValues(edits) } }).then(setR).catch(setErr);
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, conversationId, editKey]);

  const choose = (k: string) => { setKey(k); setEdits({}); setR(null); };
  const block = list.data?.sendBlock ?? null;
  const manual = useMemo(() => (r?.fields ?? []).filter((f) => !f.auto || edits[f.name] !== undefined), [r, edits]);

  if (list.error) return <Modal title="Message starters" onClose={onClose}><ErrorBox e={list.error} retry={list.reload} /></Modal>;
  if (!list.data) return <Modal title="Message starters" onClose={onClose}><Loading /></Modal>;

  return (
    <Modal title="Message starters" onClose={onClose}>
      <div className="stack">
        <div className="small muted">TripOS wording you can fill in and edit. These are normal chat messages, not WhatsApp-approved templates.</div>
        {block && (
          <div className="banner warn small" role="alert" data-testid="starter-blocked">
            {block.message}
            {block.code === 'window_closed' && <> <button className="btn sm" onClick={() => { onClose(); onUseApprovedTemplate(); }}>Use an approved WhatsApp template</button></>}
          </div>
        )}
        <div className="chips" role="list" aria-label="Starters">
          {list.data.items.map((s) => <button key={s.key} role="listitem" className={`chip${key === s.key ? ' active' : ''}`} disabled={!!block} title={s.description} onClick={() => choose(s.key)}>{s.label}</button>)}
        </div>

        {key && !block && (
          <>
            <ErrorBox e={err} />
            {!r && !err && <Loading />}
            {r && (
              <>
                <div className="grid2">
                  {r.fields.map((f) => (
                    <Field key={f.name} label={`${f.label}${f.auto && edits[f.name] === undefined ? ' (filled in automatically)' : ''}`}>
                      <input aria-label={f.label} value={edits[f.name] ?? f.value} placeholder={f.value ? undefined : 'Enter manually'} onChange={(e) => setEdits({ ...edits, [f.name]: e.target.value })} />
                    </Field>
                  ))}
                </div>
                {manual.length === 0 && r.missing.length === 0 && <div className="small muted">Everything was filled in from this customer and their latest quotation.</div>}
                {r.missing.length > 0 && <div className="banner warn small" data-testid="starter-missing">Fill in: {r.missing.map((m) => r.fields.find((f) => f.name === m)?.label ?? m).join(', ')}. TripOS has no reliable data for {r.missing.length === 1 ? 'this' : 'these'}, so it never guesses.</div>}
                <div className="wa-bubble-preview" aria-label="Preview"><pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.text}</pre></div>
                <div className="row between">
                  <span className="small muted">You can still edit the message before sending.</span>
                  <button className="btn primary" disabled={r.missing.length > 0} onClick={() => { onInsert(r.text); onClose(); }}>Use in message</button>
                </div>
              </>
            )}
          </>
        )}
        <div className="small muted" data-testid="charges-notice">{list.data.notice}</div>
      </div>
    </Modal>
  );
}
