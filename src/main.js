import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';
import { ArchiveReader, libarchiveWasm } from 'libarchive-wasm';

const { RenderingEngine, Enums } = cornerstone;
const {
  MouseBindings,
  ToolGroupManager,
  StackScrollMouseWheelTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  addTool,
} = cornerstoneTools;

const state = {
  series: [],
  activeSeriesIndex: 0,
  files: [],
  imageIds: [],
  imageMeta: [],
  currentIndex: 0,
  renderingEngine: null,
  viewport: null,
  toolGroup: null,
  cineTimer: null,
  cinePlaying: false,
  cineBusy: false,
  originalVOI: null,
  initialized: false,
  archiveModule: null,
};

const $ = id => document.getElementById(id);
const el = {
  viewport: $('viewport'),
  fileInput: $('fileInput'),
  folderInput: $('folderInput'),
  openFilesBtn: $('openFilesBtn'),
  openFolderBtn: $('openFolderBtn'),
  dropOverlay: $('dropOverlay'),
  patientName: $('patientName'),
  patientId: $('patientId'),
  studyDescription: $('studyDescription'),
  modality: $('modality'),
  studyDate: $('studyDate'),
  seriesList: $('seriesList'),
  imageCountBadge: $('imageCountBadge'),
  statusText: $('statusText'),
  fileInfo: $('fileInfo'),
  hudPatient: $('hudPatient'),
  hudStudy: $('hudStudy'),
  hudModality: $('hudModality'),
  hudSlice: $('hudSlice'),
  windowText: $('windowText'),
  zoomText: $('zoomText'),
  sliceSlider: $('sliceSlider'),
  sliceLabel: $('sliceLabel'),
  prevBtn: $('prevBtn'),
  nextBtn: $('nextBtn'),
  cineBtn: $('cineBtn'),
  loading: $('loading'),
  loadingText: $('loadingText'),
};

const VIEWPORT_ID = 'DICOM_VIEWPORT';
const RENDERING_ENGINE_ID = 'DICOM_RENDERING_ENGINE';

const clean = value =>
  value == null || value === ''
    ? '—'
    : String(value).replaceAll('^', ' ').trim() || '—';

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));

function setLoading(show, text) {
  el.loading.classList.toggle('hidden', !show);
  if (text) el.loadingText.textContent = text;
}

function setStatus(text) {
  el.statusText.textContent = text;
}

function hasDicomPreamble(bytes) {
  if (bytes.length < 132) return false;
  return bytes[128] === 68 && bytes[129] === 73 && bytes[130] === 67 && bytes[131] === 77;
}

function hasPixelData(dataset) {
  return Boolean(
    dataset.elements?.x7fe00010 ||
    dataset.elements?.x7fe00008 ||
    dataset.elements?.x7fe00009
  );
}

function numberArray(dataset, tag) {
  try {
    const value = dataset.string(tag);
    if (!value) return [];
    return value.split('\\').map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

function parseBasic(file, buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const dataset = dicomParser.parseDicom(bytes, {});
    const get = tag => {
      try {
        return dataset.string(tag) || '';
      } catch {
        return '';
      }
    };

    const sopInstanceUID = get('x00080018');
    const studyInstanceUID = get('x0020000d');
    const seriesInstanceUID = get('x0020000e');
    const modality = get('x00080060');
    const rows = Number(get('x00280010')) || 0;
    const columns = Number(get('x00280011')) || 0;

    // A valid DICOM image may have no DICM preamble. Do not require it.
    const looksLikeDicom =
      hasDicomPreamble(bytes) ||
      sopInstanceUID ||
      studyInstanceUID ||
      seriesInstanceUID ||
      modality ||
      (rows > 0 && columns > 0 && hasPixelData(dataset));

    if (!looksLikeDicom) return null;

    return {
      patientName: clean(get('x00100010')),
      patientId: clean(get('x00100020')),
      studyDescription: clean(get('x00081030')),
      modality: clean(modality),
      studyDate: clean(get('x00080020')),
      seriesDescription: clean(get('x0008103e')),
      seriesNumber: Number(get('x00200011')) || 0,
      instanceNumber: Number(get('x00200013')) || 0,
      seriesInstanceUID,
      studyInstanceUID,
      sopInstanceUID,
      imagePositionPatient: numberArray(dataset, 'x00200032'),
      imageOrientationPatient: numberArray(dataset, 'x00200037'),
      sliceLocation: Number(get('x00201041')),
      rows,
      columns,
      fileName: file.name,
      relativePath: file.webkitRelativePath || file.name,
    };
  } catch {
    return null;
  }
}

async function init() {
  if (state.initialized) return;

  await cornerstone.init();
  cornerstoneTools.init();

  dicomImageLoader.external = dicomImageLoader.external || {};
  dicomImageLoader.external.cornerstone = cornerstone;
  dicomImageLoader.external.dicomParser = dicomParser;
  dicomImageLoader.init({
    maxWebWorkers: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)),
    strict: false,
  });

  [WindowLevelTool, PanTool, ZoomTool, StackScrollMouseWheelTool].forEach(addTool);

  state.renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);
  state.renderingEngine.enableElement({
    viewportId: VIEWPORT_ID,
    type: Enums.ViewportType.STACK,
    element: el.viewport,
    defaultOptions: { background: [0, 0, 0] },
  });

  state.viewport = state.renderingEngine.getViewport(VIEWPORT_ID);

  state.toolGroup = ToolGroupManager.createToolGroup('DICOM_TOOL_GROUP');
  [WindowLevelTool, PanTool, ZoomTool, StackScrollMouseWheelTool].forEach(tool =>
    state.toolGroup.addTool(tool.toolName)
  );

  state.toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);
  state.toolGroup.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  state.toolGroup.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });
  state.toolGroup.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });
  state.toolGroup.setToolActive(StackScrollMouseWheelTool.toolName);

  el.viewport.addEventListener('contextmenu', event => event.preventDefault());

  const resize = () => {
    state.renderingEngine?.resize(true, true);
    state.viewport?.render();
  };

  addEventListener('resize', resize);
  if ('ResizeObserver' in window) {
    new ResizeObserver(resize).observe(el.viewport);
  }

  state.initialized = true;
}

function slicePosition(meta) {
  const p = meta.imagePositionPatient;
  const o = meta.imageOrientationPatient;

  if (p.length >= 3 && o.length >= 6) {
    const row = o.slice(0, 3);
    const col = o.slice(3, 6);
    const normal = [
      row[1] * col[2] - row[2] * col[1],
      row[2] * col[0] - row[0] * col[2],
      row[0] * col[1] - row[1] * col[0],
    ];
    return p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
  }

  return Number.isFinite(meta.sliceLocation) ? meta.sliceLocation : null;
}

function sortImages(images) {
  return images.sort((a, b) => {
    const ap = slicePosition(a.meta);
    const bp = slicePosition(b.meta);

    if (ap !== null && bp !== null && ap !== bp) return ap - bp;
    if (a.meta.instanceNumber !== b.meta.instanceNumber) {
      return a.meta.instanceNumber - b.meta.instanceNumber;
    }
    return a.meta.fileName.localeCompare(b.meta.fileName, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function buildSeries(parsed) {
  const map = new Map();

  for (const item of parsed) {
    const key =
      item.meta.seriesInstanceUID ||
      'NO_UID|' +
        item.meta.seriesNumber +
        '|' +
        item.meta.modality +
        '|' +
        item.meta.seriesDescription;

    if (!map.has(key)) {
      map.set(key, {
        uid: item.meta.seriesInstanceUID || key,
        studyInstanceUID: item.meta.studyInstanceUID,
        seriesNumber: item.meta.seriesNumber,
        description: item.meta.seriesDescription,
        modality: item.meta.modality,
        images: [],
      });
    }

    map.get(key).images.push(item);
  }

  const series = [...map.values()];
  series.forEach(seriesItem => sortImages(seriesItem.images));

  return series.sort(
    (a, b) =>
      (a.seriesNumber || 0) - (b.seriesNumber || 0) ||
      String(a.description || '').localeCompare(String(b.description || ''))
  );
}

async function getArchiveModule() {
  if (state.archiveModule) return state.archiveModule;

  setLoading(true, 'Preparando lector ZIP/RAR…');

  const wasmUrl =
    'https://cdn.jsdelivr.net/npm/libarchive-wasm@1.2.0/dist/libarchive.wasm';

  try {
    const loadPromise = libarchiveWasm({
      locateFile: () => wasmUrl,
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('El lector ZIP/RAR tardó demasiado en inicializar.')),
        20000
      )
    );

    state.archiveModule = await Promise.race([loadPromise, timeoutPromise]);
    return state.archiveModule;
  } catch (error) {
    state.archiveModule = null;
    console.error('Error inicializando lector ZIP/RAR:', error);
    throw new Error(
      'No se pudo iniciar el lector de archivos comprimidos. Compruebe su conexión a Internet e inténtelo nuevamente.'
    );
  }
}


function isArchiveFile(file) {
  const name = file.name.toLowerCase();
  return (
    /\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(name) ||
    file.type === 'application/zip' ||
    file.type === 'application/x-rar-compressed' ||
    file.type === 'application/vnd.rar'
  );
}

async function extractArchive(file) {
  const module = await getArchiveModule();
  const data = new Uint8Array(await file.arrayBuffer());
  const reader = new ArchiveReader(module, data);
  const extracted = [];

  try {
    for (const entry of reader.entries()) {
      const pathname = entry.getPathname?.() || '';
      const size = Number(entry.getSize?.() || 0);

      if (!pathname || pathname.endsWith('/') || size <= 0) continue;

      try {
        const bytes = entry.readData();
        if (!bytes?.length) continue;

        const filename = pathname.split('/').pop() || 'dicom';
        const extractedFile = new File([new Uint8Array(bytes)], filename, {
          type: 'application/dicom',
        });

        try {
          Object.defineProperty(extractedFile, 'webkitRelativePath', {
            value: file.name + '/' + pathname,
          });
        } catch {}

        extracted.push(extractedFile);
      } catch (error) {
        console.warn('No se pudo extraer', pathname, error);
      }
    }
  } finally {
    reader.free();
  }

  return extracted;
}


async function normalizeInput(list) {
  const input = [...list].filter(file => file && file.size > 0);
  const output = [];

  for (let i = 0; i < input.length; i++) {
    const file = input[i];

    if (isArchiveFile(file)) {
      setLoading(true, 'Abriendo archivo ' + file.name + '…');
      const extracted = await extractArchive(file);

      if (!extracted.length) {
        throw new Error(
          'El archivo comprimido no contiene archivos que el visor pueda extraer.'
        );
      }

      for (const extractedFile of extracted) {
        try {
          Object.defineProperty(extractedFile, 'webkitRelativePath', {
            value: file.name + '/' + extractedFile.name,
          });
        } catch {}
        output.push(extractedFile);
      }
    } else {
      output.push(file);
    }
  }

  return output;
}

function dedupe(parsed) {
  const seen = new Set();

  return parsed.filter(item => {
    const key =
      item.meta.sopInstanceUID ||
      item.meta.relativePath ||
      item.meta.fileName;

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadFiles(list) {
  const candidates = await normalizeInput(list);

  if (!candidates.length) {
    setStatus('No se encontraron archivos.');
    return;
  }

  stopCine();
  setLoading(true, 'Analizando estudio…');

  try {
    await init();

    const parsed = [];
    let skipped = 0;

    for (let i = 0; i < candidates.length; i++) {
      if (i % 8 === 0) {
        setLoading(
          true,
          'Analizando DICOM ' + (i + 1) + ' de ' + candidates.length + '…'
        );
      }

      const file = candidates[i];
      const meta = parseBasic(file, await file.arrayBuffer());

      if (meta) parsed.push({ file, meta });
      else skipped++;
    }

    const usable = dedupe(parsed);

    if (!usable.length) {
      state.series = [];
      updateList();
      setStatus('No se encontraron imágenes DICOM compatibles.');
      alert(
        'No se encontraron imágenes DICOM compatibles dentro de los archivos seleccionados.'
      );
      return;
    }

    state.series = buildSeries(usable);
    state.activeSeriesIndex = 0;

    updateStudy(usable[0].meta);
    updateList();
    await setSeries(0);

    el.dropOverlay.classList.add('hidden');

    const totalImages = usable.length;
    const totalSeries = state.series.length;
    setStatus(
      totalImages +
        ' imagen' +
        (totalImages === 1 ? '' : 'es') +
        ' DICOM · ' +
        totalSeries +
        ' serie' +
        (totalSeries === 1 ? '' : 's') +
        (skipped ? ' · ' + skipped + ' archivo' + (skipped === 1 ? '' : 's') + ' omitido' + (skipped === 1 ? '' : 's') : '') +
        '.'
    );
  } catch (error) {
    console.error(error);
    setStatus('Error al cargar el estudio.');
    const detail = error?.message ? '\\n\\nDetalle: ' + error.message : '';
    alert(
      'No se pudo abrir el estudio.' +
        detail +
        '\\n\\nSi es ZIP/RAR, compruebe que no esté protegido con contraseña o dividido en varios volúmenes.'
    );
  } finally {
    setLoading(false);
  }
}

async function collectDroppedItems(dataTransfer) {
  const out = [];
  const items = [...(dataTransfer.items || [])];

  async function walk(entry, path = '') {
    if (entry.isFile) {
      await new Promise(resolve =>
        entry.file(file => {
          try {
            Object.defineProperty(file, 'webkitRelativePath', {
              value: path + file.name,
            });
          } catch {}
          out.push(file);
          resolve();
        })
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();

      await new Promise(resolve => {
        const read = () =>
          reader.readEntries(async entries => {
            if (!entries.length) {
              resolve();
              return;
            }

            for (const child of entries) await walk(child, path + entry.name + '/');
            read();
          });

        read();
      });
    }
  }

  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();

    if (entry) {
      await walk(entry);
    } else {
      const file = item.getAsFile?.();
      if (file) out.push(file);
    }
  }

  return out;
}

async function setSeries(index) {
  if (!state.series.length || !state.viewport) return;

  stopCine();

  state.activeSeriesIndex = Math.max(0, Math.min(index, state.series.length - 1));
  const series = state.series[state.activeSeriesIndex];

  state.files = series.images.map(item => item.file);
  state.imageMeta = series.images.map(item => item.meta);
  state.imageIds = state.files.map(file =>
    dicomImageLoader.wadouri.fileManager.add(file)
  );
  state.currentIndex = 0;

  updateSeriesListSelection();

  if (!state.imageIds.length) return;

  await state.viewport.setStack(state.imageIds, 0);
  state.viewport.render();

  state.originalVOI = state.viewport.getProperties().voiRange || null;

  updateSlice();
  updateViewport();
  updateStudy(state.imageMeta[0]);
}

function updateStudy(meta) {
  const m = meta || {};

  el.patientName.textContent = m.patientName || '—';
  el.patientId.textContent = m.patientId || '—';
  el.studyDescription.textContent =
    m.studyDescription || m.seriesDescription || '—';
  el.modality.textContent = m.modality || '—';
  el.studyDate.textContent = m.studyDate || '—';

  el.hudPatient.textContent = 'PACIENTE ' + (m.patientName || '—');
  el.hudStudy.textContent =
    'ESTUDIO ' + (m.studyDescription || m.seriesDescription || '—');
  el.hudModality.textContent = m.modality || '—';
}

function updateList() {
  el.seriesList.innerHTML = '';
  el.imageCountBadge.textContent = state.series.length;

  if (!state.series.length) {
    el.seriesList.innerHTML =
      '<div class="empty-side"><span class="empty-icon">◫</span><b>Sin estudio cargado</b><small>Seleccione un DICOM, ZIP/RAR o una carpeta con el estudio.</small></div>';
    return;
  }

  state.series.forEach((series, index) => {
    const item = document.createElement('div');
    item.className =
      'series-item ' + (index === state.activeSeriesIndex ? 'active' : '');

    const title =
      series.description && series.description !== '—'
        ? series.description
        : 'Serie ' + (series.seriesNumber || index + 1);

    item.innerHTML =
      '<div class="thumb">' +
      String(index + 1).padStart(2, '0') +
      '</div>' +
      '<div>' +
      '<div class="series-name">' +
      esc(title) +
      '</div>' +
      '<div class="series-sub">Serie ' +
      esc(series.seriesNumber || index + 1) +
      ' · ' +
      esc(series.modality || 'DICOM') +
      ' · ' +
      series.images.length +
      ' imágenes</div>' +
      '</div>';

    item.onclick = () => setSeries(index);
    el.seriesList.appendChild(item);
  });
}

function updateSeriesListSelection() {
  [...el.seriesList.children].forEach((item, index) =>
    item.classList.toggle('active', index === state.activeSeriesIndex)
  );
}

function updateSlice() {
  const total = state.imageIds.length;

  el.sliceSlider.max = Math.max(0, total - 1);
  el.sliceSlider.value = state.currentIndex;
  el.sliceSlider.disabled = total <= 1;

  el.sliceLabel.textContent = (total ? state.currentIndex + 1 : 0) + ' / ' + total;
  el.hudSlice.textContent = (total ? state.currentIndex + 1 : 0) + ' / ' + total;

  el.prevBtn.disabled = state.currentIndex <= 0;
  el.nextBtn.disabled = state.currentIndex >= total - 1;

  updateSeriesListSelection();

  const meta = state.imageMeta[state.currentIndex];
  el.fileInfo.textContent =
    meta?.relativePath || meta?.fileName || 'Sin estudio cargado';
}

function updateViewport() {
  if (!state.viewport) return;

  const properties = state.viewport.getProperties();
  const voi = properties.voiRange;

  if (voi) {
    el.windowText.textContent =
      Math.round(voi.upper - voi.lower) +
      ' / ' +
      Math.round((voi.upper + voi.lower) / 2);
  }

  const zoom = state.viewport.getZoom?.();
  if (typeof zoom === 'number') {
    el.zoomText.textContent = zoom.toFixed(2) + '×';
  }
}

async function setSlice(index) {
  if (!state.imageIds.length || !state.viewport) return;

  state.currentIndex = Math.max(
    0,
    Math.min(index, state.imageIds.length - 1)
  );

  await state.viewport.setImageIdIndex(state.currentIndex);
  state.viewport.render();

  updateSlice();
  updateViewport();
}

function reset() {
  if (!state.viewport) return;

  state.viewport.resetCamera();

  if (state.originalVOI) {
    state.viewport.setProperties({ voiRange: state.originalVOI });
  }

  state.viewport.setProperties({ invert: false });
  state.viewport.render();
  updateViewport();
}

function invert() {
  if (!state.viewport) return;

  state.viewport.setProperties({
    invert: !state.viewport.getProperties().invert,
  });
  state.viewport.render();
}

function zoom(factor) {
  if (!state.viewport) return;

  state.viewport.setZoom((state.viewport.getZoom?.() || 1) * factor);
  state.viewport.render();
  updateViewport();
}

function fit() {
  if (!state.viewport) return;

  state.viewport.resetCamera();
  state.viewport.render();
  updateViewport();
}

function fullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    el.viewport.requestFullscreen?.();
  }
}

function stopCine() {
  state.cinePlaying = false;
  state.cineBusy = false;

  if (state.cineTimer) clearInterval(state.cineTimer);
  state.cineTimer = null;

  el.cineBtn.innerHTML = '<i>▶</i><span>Cine</span>';
}

function cine() {
  if (state.cinePlaying) {
    stopCine();
    return;
  }

  if (state.imageIds.length < 2) return;

  state.cinePlaying = true;
  el.cineBtn.innerHTML = '<i>■</i><span>Detener</span>';

  state.cineTimer = setInterval(async () => {
    if (state.cineBusy || !state.cinePlaying) return;

    state.cineBusy = true;
    try {
      await setSlice((state.currentIndex + 1) % state.imageIds.length);
    } finally {
      state.cineBusy = false;
    }
  }, 110);
}

el.openFilesBtn.onclick = () => el.fileInput.click();
el.openFolderBtn.onclick = () => el.folderInput.click();

el.fileInput.onchange = event => {
  loadFiles(event.target.files);
  event.target.value = '';
};

el.folderInput.onchange = event => {
  loadFiles(event.target.files);
  event.target.value = '';
};

el.sliceSlider.oninput = event => setSlice(Number(event.target.value));
el.prevBtn.onclick = () => setSlice(state.currentIndex - 1);
el.nextBtn.onclick = () => setSlice(state.currentIndex + 1);
el.cineBtn.onclick = cine;

document.querySelectorAll('.toolbar button[data-action]').forEach(button => {
  button.onclick = () =>
    ({
      reset,
      invert,
      zoomIn: () => zoom(1.2),
      zoomOut: () => zoom(1 / 1.2),
      fit,
      fullscreen,
      cine,
    }[button.dataset.action])();
});

document.onkeydown = event => {
  if (event.target.matches('input, textarea, select')) return;

  if (event.key === 'ArrowLeft') setSlice(state.currentIndex - 1);
  if (event.key === 'ArrowRight') setSlice(state.currentIndex + 1);
  if (event.key.toLowerCase() === 'r') reset();
  if (event.key.toLowerCase() === 'i') invert();
  if (event.key.toLowerCase() === 'f') fullscreen();

  if (event.code === 'Space') {
    event.preventDefault();
    cine();
  }
};

['dragenter', 'dragover'].forEach(type =>
  el.viewport.addEventListener(type, event => {
    event.preventDefault();
    el.dropOverlay.classList.remove('hidden');
  })
);

el.viewport.addEventListener('drop', async event => {
  event.preventDefault();
  el.dropOverlay.classList.remove('hidden');
  loadFiles(await collectDroppedItems(event.dataTransfer));
});

init().catch(error => {
  console.error(error);
  setStatus('No se pudo inicializar el visor.');
});
