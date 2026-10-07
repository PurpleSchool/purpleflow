import { useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';

export interface PickedImage {
  id: string;
  name: string;
  file: File;
  url: string;
}

const MAX_MB = 10;

/** Зона для изображений к задаче: перетащить, вставить из буфера (⌘V) или выбрать вручную. */
export function ImageDrop({ images, onChange }: { images: PickedImage[]; onChange: (next: PickedImage[]) => void }) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(images);
  latest.current = images;

  const add = (files: FileList | File[]) => {
    const list = [...files];
    const imgs = list.filter((f) => f.type.startsWith('image/'));
    const big = imgs.filter((f) => f.size > MAX_MB * 1024 * 1024);
    setError(
      list.length > imgs.length ? 'Можно прикрепить только изображения.'
      : big.length ? `Файлы больше ${MAX_MB} МБ пропущены: ${big.map((f) => f.name).join(', ')}` : null,
    );
    const ok = imgs.filter((f) => f.size <= MAX_MB * 1024 * 1024).map((f, i) => ({
      id: `${Date.now()}-${i}-${f.name}`,
      name: f.name || `screenshot-${i + 1}.png`,
      file: f,
      url: URL.createObjectURL(f),
    }));
    if (ok.length) onChange([...latest.current, ...ok]);
  };

  // Вставка скриншота из буфера в любом месте экрана новой задачи.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = (id: string) => {
    const img = images.find((x) => x.id === id);
    if (img) URL.revokeObjectURL(img.url);
    onChange(images.filter((x) => x.id !== id));
  };

  return (
    <div
      className={`imgdrop ${over ? 'is-over' : ''} ${images.length ? 'has-items' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
    >
      {images.map((img) => (
        <figure key={img.id} className="imgdrop-thumb" title={img.name}>
          <img src={img.url} alt={img.name} />
          <button className="imgdrop-del" onClick={() => remove(img.id)} title="Убрать"><X size={12} /></button>
        </figure>
      ))}
      <button className="imgdrop-add" onClick={() => input.current?.click()}>
        <ImagePlus size={18} />
        <span>
          <strong>{images.length ? 'Ещё изображение' : 'Изображения к задаче'}</strong>
          <small>Перетащите, вставьте {window.psflow.platform === 'darwin' ? '⌘V' : 'Ctrl+V'} или выберите</small>
        </span>
      </button>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }} />
      {error && <p className="imgdrop-error">{error}</p>}
    </div>
  );
}
