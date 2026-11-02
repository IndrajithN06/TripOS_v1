'use client';
import { useEffect } from 'react';

/** Full-size view of an image from the thread. Closes on Escape, on the close button, or on a click outside the picture. */
export function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-bar">
        <a className="btn sm" href={url} target="_blank" rel="noreferrer">Open original</a>
        <button className="btn sm" onClick={onClose} aria-label="Close image">✕ Close</button>
      </div>
      <img src={url} alt="Attachment, full size" />
    </div>
  );
}
