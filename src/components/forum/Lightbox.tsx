import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { imageUrl } from './ImagePicker';

export type Picture = { id: string, width: number, height: number };

/**
 * Images, large, in a window centred over the page, so looking at one never leaves it: images in messages
 * (MessagesDock.tsx) and in forum posts (ThreadView.tsx). With preview, the small copy, already loaded, shows until the
 * full image arrives. Escape, the close button or a click outside closes it; with more than one image the arrow keys
 * and buttons step through them. A modal <dialog> keeps focus inside and gives it back to the image that opened it.
 */
export function Lightbox({ images, start, alt, preview = false, onClose }: {
  images: Picture[], start: number, alt: string, preview?: boolean, onClose: () => void,
}) {
  const [index, setIndex] = useState(start);
  const box = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = box.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const many = images.length > 1, image = images[index];
  // The images can change while this is open, as when a post is edited or a message deleted.
  useEffect(() => { if (!image) onClose(); }, [image]);
  const step = (by: number) => setIndex(i => (i + by + images.length) % images.length);
  if (!image) return null;
  return <dialog ref={box} className="f-lightbox" aria-label={many ? `Image ${index + 1} of ${images.length}` : 'Image'}
    onCancel={e => { e.preventDefault(); onClose(); }}
    // A click on the dimmed page around the image lands on the dialog itself.
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    onKeyDown={e => {
      // Escape closes only this, not a panel behind it such as the messages panel.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (many && e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (many && e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    }}>
    <img key={image.id} className="f-lightbox-image" src={imageUrl(image.id)} width={image.width} height={image.height}
      alt={many ? `${alt} ${index + 1} of ${images.length}` : alt}
      style={preview ? { backgroundImage:`url(${imageUrl(image.id, 'thumb')})` } : undefined} />
    <button className="f-lightbox-button f-lightbox-close" type="button" aria-label="Close image" onClick={onClose}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
    {many && <>
      <button className="f-lightbox-button f-lightbox-prev" type="button" aria-label="Previous image" onClick={() => step(-1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      <button className="f-lightbox-button f-lightbox-next" type="button" aria-label="Next image" onClick={() => step(1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
      </button>
      <span className="f-lightbox-count" aria-hidden="true">{index + 1} / {images.length}</span>
    </>}
  </dialog>;
}

/** For a link to an image: a plain click opens it in the Lightbox; a ctrl-, cmd- or middle-click still opens a new tab. */
export const openInLightbox = (open: () => void) => (e: MouseEvent<HTMLAnchorElement>) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  open();
};
