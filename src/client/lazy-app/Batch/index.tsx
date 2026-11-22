import { h, Component } from 'preact';
import * as style from './style.css';
import 'add-css:./style.css';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import { imageAccept, isImageFile } from 'shared/image-files';
import { AddIcon, Arrow, DownloadIcon, ExpandIcon, RemoveIcon } from '../icons';
import { encoderMap, EncoderType } from '../feature-meta';
import { assertSignal } from '../util';
import { decodeImage, processSvg } from '../util/image';
import {
  builtinResize,
  drawableToImageData,
  flattenAlpha,
} from '../util/canvas';
import WorkerBridge from '../worker-bridge';
import prettyBytes from '../Compress/Results/pretty-bytes';
import { createZip } from './zip';

interface Props {
  files: File[];
  showSnack: SnackBarElement['showSnackbar'];
  onBack: () => void;
  /** Lets the app shell block drag-and-drop replacement while work is running. */
  onBusyChange?: (busy: boolean) => void;
}

interface BatchItem {
  id: number;
  file: File;
  /** undefined: thumbnail pending, '': no preview available. */
  previewUrl?: string;
  compressed?: File;
  keptOriginal?: boolean;
  processing: boolean;
  error?: string;
  warning?: string;
  downloadUrl?: string;
}

type OutputFormat = 'image/jpeg' | 'image/webp' | 'image/png';
type ResizeMode = 'longEdge' | 'width';

interface BatchSettings {
  format: OutputFormat;
  quality: number;
  maxSize: number;
  useResize: boolean;
  resizeMode: ResizeMode;
  keepOriginal: boolean;
}

interface State extends BatchSettings {
  items: BatchItem[];
  processing: boolean;
  packaging: boolean;
  archiveProgress: number;
  archiveUrl?: string;
  archiveName?: string;
  showSettings: boolean;
  cancelled: boolean;
}

type CompressScope = 'all' | 'pending' | number[];

const encoders: Record<OutputFormat, EncoderType> = {
  'image/jpeg': 'mozJPEG',
  'image/webp': 'webP',
  'image/png': 'oxiPNG',
};
const formatExts: Record<OutputFormat, string> = {
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/png': '.png',
};
const settingsKey = 'batchSettings';
const thumbWidth = 112;
const maxSizeLimit = 10000;

const defaultSettings: BatchSettings = {
  format: 'image/webp',
  quality: encoderMap.webP.meta.defaultOptions.quality,
  maxSize: 1920,
  useResize: false,
  resizeMode: 'longEdge',
  keepOriginal: false,
};

function validSize(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maxSizeLimit;
}

function loadSettings(): BatchSettings {
  const result = { ...defaultSettings };
  try {
    if (typeof localStorage === 'undefined') return result;
    const raw = localStorage.getItem(settingsKey);
    if (!raw) return result;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return result;
    if (Object.prototype.hasOwnProperty.call(encoders, saved.format))
      result.format = saved.format;
    if (
      Number.isInteger(saved.quality) &&
      saved.quality >= 1 &&
      saved.quality <= 100
    )
      result.quality = saved.quality;
    if (validSize(saved.maxSize)) result.maxSize = saved.maxSize;
    if (typeof saved.useResize === 'boolean')
      result.useResize = saved.useResize;
    if (saved.resizeMode === 'width' || saved.resizeMode === 'longEdge')
      result.resizeMode = saved.resizeMode;
    if (typeof saved.keepOriginal === 'boolean')
      result.keepOriginal = saved.keepOriginal;
  } catch {
    // Unreadable or corrupt storage falls back to built-in defaults.
  }
  return result;
}

function storeSettings(settings: BatchSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  } catch {
    // Storage can be disabled or full; settings then only live in memory.
  }
}

function pickSettings(source: BatchSettings): BatchSettings {
  const { format, quality, maxSize, useResize, resizeMode, keepOriginal } =
    source;
  return { format, quality, maxSize, useResize, resizeMode, keepOriginal };
}

/** Output dimensions, or undefined when no resize is needed. */
function targetSize(
  width: number,
  height: number,
  settings: BatchSettings,
): { width: number; height: number } | undefined {
  if (!settings.useResize) return;
  const edge =
    settings.resizeMode === 'width' ? width : Math.max(width, height);
  if (edge <= settings.maxSize) return;
  const scale = settings.maxSize / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Parallel encoders: half the cores, 1–4, reduced on low-memory devices. */
function defaultConcurrency(): number {
  if (typeof navigator === 'undefined') return 1;
  const cores = navigator.hardwareConcurrency || 2;
  let limit = Math.max(1, Math.min(4, Math.floor(cores / 2)));
  const memory = (navigator as any).deviceMemory as number | undefined;
  if (memory && memory <= 4) limit = Math.min(limit, 2);
  return limit;
}

function isGif(file: File): boolean {
  return file.type === 'image/gif' || /\.gif$/i.test(file.name);
}

function isSvg(file: File): boolean {
  return file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
}

function canMakeThumbnails(): boolean {
  return (
    typeof createImageBitmap === 'function' && typeof document !== 'undefined'
  );
}

async function makeThumbnail(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, {
    resizeWidth: thumbWidth,
    resizeQuality: 'medium',
  } as ImageBitmapOptions);
  const canvas = document.createElement('canvas');
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.8),
    );
    if (!blob) throw new Error('缩略图生成失败');
    return blob;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : '处理失败';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function archiveFileName(date: Date): string {
  return `compressed-images-${date.getFullYear()}${pad(
    date.getMonth() + 1,
  )}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}${pad(date.getSeconds())}.zip`;
}

function sizeLabel(size: number) {
  const pretty = prettyBytes(size);
  return `${pretty.value} ${pretty.unit}`;
}

export default class Batch extends Component<Props, State> {
  private nextId = 0;
  private controller = new AbortController();
  private mounted = true;
  private fileInput?: HTMLInputElement;
  private readonly concurrency = defaultConcurrency();
  private readonly bridges: WorkerBridge[] = Array.from(
    { length: this.concurrency },
    () => new WorkerBridge(),
  );
  /** Every object URL this component owns, so none can leak. */
  private readonly urls = new Set<string>();
  private thumbQueue: number[] = [];
  private thumbsRunning = false;
  private lastBusy = false;

  state: State = {
    ...loadSettings(),
    items: this.createItems(this.props.files),
    processing: false,
    packaging: false,
    archiveProgress: 0,
    showSettings: false,
    cancelled: false,
  };

  componentDidMount() {
    import('../sw-bridge')
      .then(({ mainAppLoaded }) => mainAppLoaded())
      .catch(() => {});
  }

  componentDidUpdate() {
    const busy = this.state.processing || this.state.packaging;
    if (busy === this.lastBusy) return;
    this.lastBusy = busy;
    if (this.props.onBusyChange) this.props.onBusyChange(busy);
  }

  componentWillReceiveProps(next: Props) {
    if (next.files === this.props.files) return;
    this.controller.abort();
    this.revokeAll();
    this.thumbQueue = [];
    this.setState({
      items: this.createItems(next.files),
      processing: false,
      packaging: false,
      archiveUrl: undefined,
      cancelled: false,
    });
  }

  componentWillUnmount() {
    this.mounted = false;
    this.controller.abort();
    this.thumbQueue = [];
    this.revokeAll();
    if (this.lastBusy && this.props.onBusyChange)
      this.props.onBusyChange(false);
  }

  private createUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  private revokeUrl(url?: string) {
    if (!url) return;
    URL.revokeObjectURL(url);
    this.urls.delete(url);
  }

  private revokeAll() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  private createItems(files: File[]): BatchItem[] {
    const thumbnails = canMakeThumbnails();
    const items: BatchItem[] = files.map((file) => ({
      id: this.nextId++,
      file,
      // SVGs are tiny and cannot go through createImageBitmap(blob).
      previewUrl:
        thumbnails && !isSvg(file) ? undefined : this.createUrl(file),
      processing: false,
      warning: isGif(file) ? 'GIF 动图仅保留第一帧' : undefined,
    }));
    if (thumbnails) {
      for (const item of items)
        if (item.previewUrl === undefined) this.thumbQueue.push(item.id);
      setTimeout(() => this.runThumbnails(), 0);
    }
    return items;
  }

  /** Small thumbnails are generated one at a time to bound memory. */
  private async runThumbnails() {
    if (this.thumbsRunning) return;
    this.thumbsRunning = true;
    try {
      while (this.mounted && this.thumbQueue.length) {
        const id = this.thumbQueue.shift()!;
        const item = this.state.items.find((entry) => entry.id === id);
        if (!item || item.previewUrl !== undefined) continue;
        let url = '';
        try {
          url = this.createUrl(await makeThumbnail(item.file));
        } catch {
          // Undecodable input keeps the neutral placeholder.
        }
        if (!this.mounted) {
          this.revokeUrl(url);
          return;
        }
        this.setState((state) => {
          const current = state.items.find((entry) => entry.id === id);
          if (!current || current.previewUrl !== undefined) {
            this.revokeUrl(url);
            return null;
          }
          return {
            items: state.items.map((entry) =>
              entry.id === id ? { ...entry, previewUrl: url } : entry,
            ),
          };
        });
      }
    } finally {
      this.thumbsRunning = false;
    }
  }

  private releaseItems(items: BatchItem[]) {
    for (const item of items) {
      this.revokeUrl(item.previewUrl);
      this.revokeUrl(item.downloadUrl);
    }
  }

  private invalidateArchive() {
    this.revokeUrl(this.state.archiveUrl);
  }

  private patchItem(id: number, patch: Partial<BatchItem>) {
    this.setState((state) => {
      if (!state.items.some((item) => item.id === id)) {
        this.revokeUrl(patch.downloadUrl);
        return null;
      }
      return {
        items: state.items.map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      };
    });
  }

  private updateSettings(patch: Partial<BatchSettings>) {
    const next = { ...pickSettings(this.state), ...patch };
    this.setState(patch as State);
    storeSettings(next);
  }

  private async resizeData(
    data: ImageData,
    size: { width: number; height: number },
    signal: AbortSignal,
    bridge: WorkerBridge,
  ): Promise<ImageData> {
    // Same Lanczos3 resampler as the single-image editor; canvas as fallback.
    const workerResize = (bridge as any).resize;
    if (typeof workerResize === 'function') {
      try {
        return await workerResize.call(bridge, signal, data, {
          width: size.width,
          height: size.height,
          method: 'lanczos3',
          fitMethod: 'stretch',
          premultiply: true,
          linearRGB: true,
        });
      } catch {
        assertSignal(signal);
      }
    }
    return builtinResize(
      data,
      0,
      0,
      data.width,
      data.height,
      size.width,
      size.height,
      'high',
    );
  }

  private async compressFile(
    file: File,
    signal: AbortSignal,
    settings: BatchSettings,
    bridge: WorkerBridge = this.bridges[0],
  ): Promise<File> {
    let data = isSvg(file)
      ? drawableToImageData(await processSvg(signal, file))
      : await decodeImage(signal, file, bridge);
    assertSignal(signal);
    const size = targetSize(data.width, data.height, settings);
    if (size) data = await this.resizeData(data, size, signal, bridge);
    assertSignal(signal);
    if (settings.format === 'image/jpeg') data = flattenAlpha(data, '#ffffff');
    assertSignal(signal);
    const encoder = encoderMap[encoders[settings.format]];
    const options =
      settings.format === 'image/png'
        ? encoder.meta.defaultOptions
        : { ...encoder.meta.defaultOptions, quality: settings.quality };
    const output = await encoder.encode(signal, bridge, data, options as any);
    assertSignal(signal);
    const name =
      (file.name.replace(/\.[^.]+$/, '') || 'image') +
      formatExts[settings.format];
    const result = new File([output], name, { type: encoder.meta.mimeType });
    // Never hand back a bigger file when the user asked to keep originals.
    if (settings.keepOriginal && !size && result.size >= file.size)
      return file;
    return result;
  }

  private onCompressAll = () => this.compress('all');

  private onCompressPending = () => this.compress('pending');

  private retryItem = (id: number) => this.compress([id]);

  private async compress(scope: CompressScope) {
    const state = this.state;
    if (state.processing || state.packaging || !state.items.length) return;
    if (state.useResize && !validSize(state.maxSize)) {
      this.props.showSnack(`最大尺寸应为 1 到 ${maxSizeLimit} 的整数`);
      return;
    }
    const targets = state.items.filter((item) =>
      scope === 'all'
        ? true
        : scope === 'pending'
        ? !item.compressed
        : scope.includes(item.id),
    );
    if (!targets.length) return;
    this.controller.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    const settings = pickSettings(state);
    const ids = new Set(targets.map((item) => item.id));
    this.invalidateArchive();
    for (const item of targets) this.revokeUrl(item.downloadUrl);
    this.setState((current) => ({
      items: current.items.map((item) =>
        ids.has(item.id)
          ? {
              ...item,
              compressed: undefined,
              keptOriginal: undefined,
              downloadUrl: undefined,
              error: undefined,
              processing: false,
            }
          : item,
      ),
      processing: true,
      cancelled: false,
      archiveUrl: undefined,
    }));

    const queue = targets.map((item) => ({ id: item.id, file: item.file }));
    let success = 0;
    const run = async (bridge: WorkerBridge) => {
      while (queue.length) {
        if (signal.aborted || !this.mounted) return;
        const { id, file } = queue.shift()!;
        this.patchItem(id, { processing: true });
        try {
          const compressed = await this.compressFile(
            file,
            signal,
            settings,
            bridge,
          );
          assertSignal(signal);
          if (!this.mounted) return;
          success++;
          this.patchItem(id, {
            compressed,
            keptOriginal: compressed === file,
            processing: false,
            downloadUrl: this.createUrl(compressed),
          });
        } catch (err) {
          if (signal.aborted || !this.mounted) return;
          console.warn('Batch item failed:', file.name, err);
          this.patchItem(id, { processing: false, error: errorMessage(err) });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const lanes = this.bridges.slice(
      0,
      Math.max(1, Math.min(this.bridges.length, queue.length)),
    );
    await Promise.all(lanes.map(run));
    if (signal.aborted || !this.mounted) return;
    this.setState({ processing: false });
    this.props.showSnack(
      `批量压缩完成：成功 ${success}/${targets.length} 张`,
      { timeout: 5000 },
    );
  }

  private onCancel = () => {
    this.controller.abort();
    this.setState((state) => ({
      processing: false,
      packaging: false,
      cancelled: true,
      items: state.items.map((item) =>
        item.processing ? { ...item, processing: false } : item,
      ),
    }));
  };

  private onAddFiles = (event: Event) => {
    if (this.state.processing || this.state.packaging) return;
    const input = event.target as HTMLInputElement;
    const selected = Array.from(input.files || []);
    input.value = '';
    const files = selected.filter(isImageFile);
    if (files.length !== selected.length)
      this.props.showSnack('已跳过非图片文件');
    if (!files.length) return;
    this.invalidateArchive();
    const added = this.createItems(files);
    this.setState((state) => ({
      items: [...state.items, ...added],
      archiveUrl: undefined,
      cancelled: false,
    }));
  };

  private removeItem = (id: number) => {
    if (this.state.processing || this.state.packaging) return;
    const item = this.state.items.find((entry) => entry.id === id);
    if (!item) return;
    this.releaseItems([item]);
    this.invalidateArchive();
    this.setState((state) => ({
      items: state.items.filter((entry) => entry.id !== id),
      archiveUrl: undefined,
    }));
  };

  private prepareDownload = async () => {
    if (this.state.processing || this.state.packaging) return;
    const files = this.state.items.flatMap((item) =>
      item.compressed ? [item.compressed] : [],
    );
    if (!files.length) return;
    this.controller.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.setState({ packaging: true, archiveProgress: 0, cancelled: false });
    try {
      const now = new Date();
      const archive = await createZip(
        files,
        signal,
        (archiveProgress) => {
          if (!signal.aborted && this.mounted)
            this.setState({ archiveProgress });
        },
        now,
      );
      assertSignal(signal);
      if (!this.mounted) return;
      this.invalidateArchive();
      this.setState({
        archiveUrl: this.createUrl(archive),
        archiveName: archiveFileName(now),
        packaging: false,
      });
    } catch (err) {
      if (signal.aborted || !this.mounted) return;
      this.setState({ packaging: false });
      this.props.showSnack(err instanceof Error ? err.message : '打包失败');
    }
  };

  render({ onBack }: Props, state: State) {
    const {
      items,
      format,
      quality,
      maxSize,
      useResize,
      resizeMode,
      keepOriginal,
      processing,
      packaging,
      showSettings,
      archiveUrl,
      archiveName,
    } = state;
    const successes = items.filter((item) => item.compressed);
    const failures = items.filter((item) => item.error).length;
    const completed = successes.length + failures;
    const pending = items.length - successes.length;
    const originalSize = successes.reduce(
      (sum, item) => sum + item.file.size,
      0,
    );
    const outputSize = successes.reduce(
      (sum, item) => sum + item.compressed!.size,
      0,
    );
    const saved = originalSize
      ? Math.round((1 - outputSize / originalSize) * 100)
      : 0;
    const busy = processing || packaging;
    return (
      <section class={style.batch}>
        <header class={style.header}>
          <button
            class={style.backBtn}
            onClick={onBack}
            title="返回"
            aria-label="返回"
          >
            <Arrow />
          </button>
          <h1>批量压缩</h1>
          <span class={style.count}>{items.length} 张</span>
          <button
            class={style.settingsToggle}
            onClick={() => this.setState({ showSettings: !showSettings })}
            aria-expanded={showSettings}
            aria-controls="batch-settings"
            title="压缩设置"
          >
            <ExpandIcon />
            <span class={style.buttonLabel}>设置</span>
          </button>
          <button
            class={style.addBtn}
            onClick={() => this.fileInput!.click()}
            disabled={busy}
            title="添加图片"
            aria-label="添加图片"
          >
            <AddIcon />
            <span class={style.buttonLabel}>添加图片</span>
          </button>
          <input
            class={style.hidden}
            type="file"
            multiple
            accept={imageAccept}
            ref={(input) => {
              this.fileInput = input || undefined;
            }}
            onChange={this.onAddFiles}
          />
        </header>
        <div class={style.workspace}>
          <aside
            id="batch-settings"
            class={`${style.controls} ${showSettings ? style.open : ''}`}
          >
            <h2>压缩设置</h2>
            <label class={style.settingItem}>
              <span>输出格式</span>
              <select
                value={format}
                onChange={(event) =>
                  this.updateSettings({
                    format: (event.target as HTMLSelectElement)
                      .value as OutputFormat,
                  })
                }
                disabled={busy}
              >
                <option value="image/jpeg">JPEG</option>
                <option value="image/webp">WebP</option>
                <option value="image/png">PNG</option>
              </select>
            </label>
            <label class={style.settingItem}>
              <span>
                质量 <strong>{quality}%</strong>
              </span>
              <input
                type="range"
                min="1"
                max="100"
                value={quality}
                disabled={busy || format === 'image/png'}
                onInput={(event) =>
                  this.updateSettings({
                    quality: (event.target as HTMLInputElement).valueAsNumber,
                  })
                }
              />
            </label>
            <label class={style.toggleLabel}>
              <input
                type="checkbox"
                checked={useResize}
                disabled={busy}
                onChange={() => this.updateSettings({ useResize: !useResize })}
              />
              限制最大尺寸
            </label>
            {useResize && (
              <div class={style.resizeGroup}>
                <div
                  class={style.radioGroup}
                  role="radiogroup"
                  aria-label="限制方式"
                >
                  <label>
                    <input
                      type="radio"
                      name="batch-resize-mode"
                      checked={resizeMode === 'longEdge'}
                      disabled={busy}
                      onChange={() =>
                        this.updateSettings({ resizeMode: 'longEdge' })
                      }
                    />
                    按长边
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="batch-resize-mode"
                      checked={resizeMode === 'width'}
                      disabled={busy}
                      onChange={() =>
                        this.updateSettings({ resizeMode: 'width' })
                      }
                    />
                    按宽度
                  </label>
                </div>
                <label class={style.settingItem}>
                  <span>
                    {resizeMode === 'width' ? '最大宽度' : '最长边'} / px
                  </span>
                  <input
                    type="number"
                    min="1"
                    max={String(maxSizeLimit)}
                    step="1"
                    value={maxSize}
                    disabled={busy}
                    inputMode="numeric"
                    onInput={(event) =>
                      this.updateSettings({
                        maxSize: (event.target as HTMLInputElement)
                          .valueAsNumber,
                      })
                    }
                  />
                </label>
              </div>
            )}
            <label class={style.toggleLabel}>
              <input
                type="checkbox"
                checked={keepOriginal}
                disabled={busy}
                onChange={() =>
                  this.updateSettings({ keepOriginal: !keepOriginal })
                }
              />
              结果更大时保留原图
            </label>
            <p class={style.hint}>
              并行 {this.concurrency} 路处理；设置会保存在本机浏览器。
            </p>
          </aside>
          <main class={style.content}>
            <div class={style.summary} role="status" aria-live="polite">
              <span>
                {processing
                  ? `正在处理 ${Math.min(completed + 1, items.length)}/${
                      items.length
                    }`
                  : state.cancelled
                  ? '已取消'
                  : `已完成 ${completed}/${items.length}`}
                {failures > 0 ? `，失败 ${failures} 张` : ''}
              </span>
              {successes.length > 0 && (
                <strong>
                  {sizeLabel(originalSize)} → {sizeLabel(outputSize)}
                  <span class={saved >= 0 ? style.saved : style.growth}>
                    {saved >= 0 ? `节省 ${saved}%` : `增大 ${-saved}%`}
                  </span>
                </strong>
              )}
            </div>
            <progress
              class={style.progress}
              value={packaging ? state.archiveProgress : completed}
              max={packaging ? successes.length || 1 : items.length || 1}
              aria-label={packaging ? '打包进度' : '压缩进度'}
            />
            <ul class={style.itemList}>
              {items.map((item) => {
                const difference =
                  item.compressed && item.file.size
                    ? Math.round(
                        (1 - item.compressed.size / item.file.size) * 100,
                      )
                    : 0;
                return (
                  <li key={item.id} class={style.item}>
                    {item.previewUrl ? (
                      <img
                        class={style.thumb}
                        src={item.previewUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span class={style.thumb} aria-hidden="true" />
                    )}
                    <div class={style.info}>
                      <div class={style.name} title={item.file.name}>
                        {item.file.name}
                      </div>
                      <div class={style.sizes}>
                        {sizeLabel(item.file.size)}
                        {item.compressed &&
                          ` → ${sizeLabel(item.compressed.size)}`}
                      </div>
                      {item.keptOriginal && (
                        <span class={style.note}>压缩后更大，已保留原图</span>
                      )}
                      {item.warning && (
                        <span class={style.note}>{item.warning}</span>
                      )}
                      {item.error && (
                        <span class={style.error} role="status">
                          {item.error}
                        </span>
                      )}
                    </div>
                    <span
                      class={`${style.itemStatus} ${
                        difference < 0 ? style.growth : style.saved
                      }`}
                    >
                      {item.processing
                        ? '处理中'
                        : item.compressed
                        ? difference >= 0
                          ? `-${difference}%`
                          : `+${-difference}%`
                        : item.error
                        ? '失败'
                        : '待处理'}
                    </span>
                    <div class={style.itemActions}>
                      {item.error && (
                        <button
                          class={style.textBtn}
                          disabled={busy}
                          onClick={() => this.retryItem(item.id)}
                          aria-label={`重试 ${item.file.name}`}
                        >
                          重试
                        </button>
                      )}
                      {item.compressed && (
                        <a
                          class={style.iconBtn}
                          href={item.downloadUrl}
                          download={item.compressed.name}
                          title={`下载 ${item.compressed.name}`}
                          aria-label={`下载 ${item.file.name}`}
                        >
                          <DownloadIcon />
                        </a>
                      )}
                      <button
                        class={style.iconBtn}
                        disabled={busy}
                        onClick={() => this.removeItem(item.id)}
                        title="移除图片"
                        aria-label={`移除 ${item.file.name}`}
                      >
                        <RemoveIcon />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {!items.length && <div class={style.empty}>暂无图片</div>}
          </main>
        </div>
        <footer class={style.actionBar}>
          {busy ? (
            <button class={style.cancelBtn} onClick={this.onCancel}>
              取消{packaging ? '打包' : '压缩'}
            </button>
          ) : (
            [
              completed > 0 && pending > 0 && (
                <button
                  key="pending"
                  class={style.secondaryBtn}
                  onClick={this.onCompressPending}
                >
                  压缩未完成 ({pending})
                </button>
              ),
              <button
                key="all"
                class={style.compressBtn}
                disabled={!items.length}
                onClick={this.onCompressAll}
              >
                {completed ? '重新压缩' : '开始压缩'}
              </button>,
            ]
          )}
          {archiveUrl ? (
            <a
              class={style.downloadBtn}
              href={archiveUrl}
              download={archiveName || 'compressed-images.zip'}
            >
              <DownloadIcon />
              下载 ZIP
            </a>
          ) : (
            <button
              class={style.downloadBtn}
              disabled={!successes.length || busy}
              onClick={this.prepareDownload}
            >
              <DownloadIcon />
              {packaging
                ? `打包 ${state.archiveProgress}/${successes.length}`
                : `打包下载${successes.length ? ` (${successes.length})` : ''}`}
            </button>
          )}
        </footer>
      </section>
    );
  }
}
