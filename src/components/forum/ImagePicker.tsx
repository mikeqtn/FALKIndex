import { useState, type ChangeEvent } from 'react';
import { api, handleAccountError } from '../accounts/api';

const MAX_IMAGES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** The address of a rebuilt image, the same on the forum's host and the main site's. */
export const imageUrl = (id: string) => `/api/forum/images/${id}`;

// Images attached while writing or editing a post. Each uploads as soon as it is picked and comes back
// rebuilt, so the preview shows what readers will see. One taken off the list is cleared up on a later
// upload, or, if it was already on the post, deleted when the edit is saved.
export function useImagePicker() {
  const [ids, setIds] = useState<string[]>([]);
  // Room taken by images the member cannot change here, such as ones a moderator hid.
  const [reserved, setReserved] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const room = MAX_IMAGES - reserved;
  const add = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    setError(''); setUploading(true);
    let count = ids.length;
    try {
      for (const file of files) {
        if (count >= room) throw new Error(`A post can have up to ${MAX_IMAGES} images.`);
        if (!TYPES.includes(file.type)) throw new Error(`${file.name} is not a JPEG, PNG or WebP image.`);
        if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 8 MB.`);
        const { image } = await api<{ image: { id: string } }>('/api/forum/images', { method:'POST', body:file, headers:{ 'Content-Type':file.type } });
        setIds(current => [...current, image.id]);
        count++;
      }
    } catch (failure) { setError(failure instanceof Error && failure.constructor === Error ? failure.message : handleAccountError(failure)); }
    finally { setUploading(false); }
  };
  const picker = <div className="forum-picker">
    {error && <div className="account-error" role="alert">{error}</div>}
    {ids.length > 0 && <ul className="forum-picked">{ids.map(id => <li key={id}>
      <img src={imageUrl(id)} alt="Attached image" />
      <button type="button" onClick={() => setIds(current => current.filter(x => x !== id))}>Remove</button>
    </li>)}</ul>}
    {ids.length < room && <label className="account-button secondary forum-add-image">
      {uploading ? 'Uploading…' : 'Add images'}
      <input className="sr-only" type="file" accept={TYPES.join(',')} multiple disabled={uploading} onChange={add} />
    </label>}
    <p className="small muted">Up to {MAX_IMAGES} JPEG, PNG or WebP images, 8 MB each. Location data is removed. Only post images you have the right to share.</p>
  </div>;
  const reset = (start: string[] = [], fixed = 0) => { setIds(start); setReserved(fixed); setError(''); };
  return { ids, uploading, picker, clear:() => reset(), reset };
}
