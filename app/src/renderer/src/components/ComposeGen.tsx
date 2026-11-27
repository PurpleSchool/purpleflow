// «Создать» в поле ввода чата: явный режим генерации — картинка (видео и озвучка — скоро). Включается кнопкой или
// командой «/картинка»; модель и соотношение сторон — в плашке режима. При отправке сообщение прямо просит агента
// сгенерировать картинку через MCP PurpleSchool — без гаданий, рисовать ли её кодом.
import { useEffect, useState } from 'react';
import { AudioLines, Clapperboard, ImagePlus, WandSparkles, X } from 'lucide-react';
import { bridge } from '../lib/api';
import { useStore } from '../lib/store';
import { Select } from './Dropdown';
import { ABOUT } from './MediaModels';
import { VendorIcon } from './VendorIcon';

export interface GenMode {
  kind: 'image';
  /** Модель MCP; '' — агент выбирает сам. */
  model: string;
  /** Соотношение сторон; '' — по назначению картинки. */
  ratio: string;
}

/** Команды в подсказках «/»: включают режим, в текст не вставляются. */
export const GEN_COMMANDS: { name: string; kind: GenMode['kind'] | null; hint: string }[] = [
  { name: 'картинка', kind: 'image', hint: 'Нарисовать картинку — модель и соотношение сторон на выбор' },
  { name: 'видео', kind: null, hint: 'Скоро' },
  { name: 'озвучка', kind: null, hint: 'Скоро' },
];

const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];

/** Текст для агента: явная просьба сгенерировать картинку с выбранными параметрами. */
export function genPrompt(mode: GenMode, text: string): string {
  const params = [mode.model && `модель ${mode.model}`, mode.ratio && `соотношение сторон ${mode.ratio}`].filter(Boolean).join(', ');
  return `Сгенерируй картинку через generate_image${params ? ` (${params})` : ''}: ${text.trim()}`;
}

/** «/картинка …» в начале сообщения без выбранного режима — тоже режим (набрали команду и сразу отправили). */
export function genFromText(text: string): { mode: GenMode; text: string } | null {
  const m = /^\s*\/картинка(?=\s|$)\s*/i.exec(text);
  return m ? { mode: { kind: 'image', model: '', ratio: '' }, text: text.slice(m[0].length) } : null;
}

/** Кнопка «Создать» в строке поля ввода: меню видов генерации. */
export function GenMenu({ onPick }: { onPick: (kind: GenMode['kind']) => void }) {
  return (
    <Select<string>
      className="chat-gen-menu"
      value={undefined}
      placeholder="Создать"
      icon={<WandSparkles size={14} />}
      ariaLabel="Создать"
      title="Создать картинку (видео и озвучка — скоро)"
      minWidth={240}
      options={[
        { value: 'image', label: 'Картинка', hint: 'Модель и стороны — на выбор', icon: <ImagePlus size={14} /> },
        { value: 'video', label: 'Видео', icon: <Clapperboard size={14} />, disabled: true, badge: 'скоро' },
        { value: 'audio', label: 'Озвучка', icon: <AudioLines size={14} />, disabled: true, badge: 'скоро' },
      ]}
      onChange={(v) => v === 'image' && onPick('image')}
    />
  );
}

/** Плашка режима над строкой: что создаём, модель, соотношение сторон и выход из режима. */
export function GenPill({ mode, onChange, onClose }: { mode: GenMode; onChange: (m: GenMode) => void; onClose: () => void }) {
  const { state } = useStore();
  const live = Boolean(state.settings?.account && state.settings.media.enabled && state.settings.proxy.hasKey);
  // Модели — от сервера по ключу аккаунта; без входа — известные из справочника.
  const [ids, setIds] = useState<string[]>(Object.keys(ABOUT));
  useEffect(() => {
    if (!live) return;
    let alive = true;
    void bridge.account.mediaModels().then((r) => alive && r.ok && r.data.models.length && setIds(r.data.models.map((m) => m.id)));
    return () => {
      alive = false;
    };
  }, [live]);
  return (
    <div className="compose-gen" role="group" aria-label="Создать картинку">
      <span className="compose-gen-kind">
        <ImagePlus size={14} /> Картинка
      </span>
      <Select<string>
        className="compose-gen-select"
        value={mode.model}
        ariaLabel="Модель картинки"
        minWidth={300}
        options={[
          { value: '', label: 'Модель — авто', hint: 'Агент выберет по задаче', icon: <WandSparkles size={14} /> },
          ...ids.map((id) => ({
            value: id,
            label: ABOUT[id]?.name ?? id,
            hint: ABOUT[id]?.use,
            icon: <VendorIcon vendor={ABOUT[id]?.vendor ?? 'PurpleSchool'} size="xs" />,
          })),
        ]}
        onChange={(model) => onChange({ ...mode, model })}
      />
      <Select<string>
        className="compose-gen-select"
        value={mode.ratio}
        ariaLabel="Соотношение сторон"
        options={[{ value: '', label: 'Стороны — авто' }, ...RATIOS.map((r) => ({ value: r, label: r }))]}
        onChange={(ratio) => onChange({ ...mode, ratio })}
      />
      <button type="button" className="compose-gen-close" aria-label="Выйти из режима картинки" title="Обычное сообщение" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
