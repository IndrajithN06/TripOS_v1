'use client';

export interface WaPreviewData {
  header: { type: 'none' | 'text' | 'image' | 'document'; text?: string };
  body: string; footer?: string;
  buttons: { type: 'quick_reply' | 'url' | 'phone'; text: string; target?: string }[];
  missing?: string[];
}
export interface WaMedia { kind: 'image' | 'document'; label: string; url: string | null; missing: string | null }

/** WhatsApp-style bubble: what the customer will actually see (header media, text, footer, buttons). */
export function WaPreview({ preview, media, extraImages = [] }: { preview: WaPreviewData; media?: WaMedia | null; extraImages?: string[] }) {
  const h = preview.header;
  return (
    <div className="wa-phone" aria-label="WhatsApp message preview">
      <div className="wa-msg">
        {h.type === 'image' && (media?.url ? <img className="wa-hdr" src={media.url} alt={media.label} /> : <div className="wa-hdr wa-missing">{media?.missing ?? 'Header image'}</div>)}
        {h.type === 'document' && <div className="wa-doc"><span className="wa-doc-ico">PDF</span><span>{media?.label ?? 'Quotation.pdf'}</span></div>}
        {h.type === 'text' && h.text && <div className="wa-title">{h.text}</div>}
        <div className="wa-body">{preview.body}</div>
        {preview.footer && <div className="wa-foot">{preview.footer}</div>}
        <div className="wa-time">now ✓✓</div>
        {preview.buttons.length > 0 && <div className="wa-btns">{preview.buttons.map((b, i) => <div key={i} className="wa-btn" title={b.target}>{b.type === 'url' ? '↗ ' : b.type === 'phone' ? '✆ ' : '↩ '}{b.text}</div>)}</div>}
      </div>
      {extraImages.length > 0 && <div className="wa-extra">{extraImages.map((u) => <img key={u} src={u} alt="Vehicle photo sent after the message" />)}<div className="small muted">Sent as separate photos right after the message</div></div>}
    </div>
  );
}
