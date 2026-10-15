/* global UTIF, Config */

const elements = {
  clearSelection: document.querySelector("#clear-selection-button"),
  contextMenu: document.querySelector("#context-menu"),
  delete: document.querySelector("#delete-button"),
  dropZone: document.querySelector("#drop-zone"),
  duplicate: document.querySelector("#duplicate-button"),
  export: document.querySelector("#export-button"),
  fileInput: document.querySelector("#file-input"),
  group: document.querySelector("#group-button"),
  inspector: document.querySelector("#inspector"),
  layerCount: document.querySelector("#layer-count"),
  groupLoose: document.querySelector("#group-loose-button"),
  layerTree: document.querySelector("#layer-tree"),
  censorButton: document.querySelector("#censor-button"),
  censorPanel: document.querySelector("#censor-panel"),
  mirrorH: document.querySelector("#mirror-h-button"),
  mirrorV: document.querySelector("#mirror-v-button"),
  rotateLeft: document.querySelector("#rotate-left-button"),
  rotateRight: document.querySelector("#rotate-right-button"),
  previewOverlay: document.querySelector("#preview-overlay"),
  previewStage: document.querySelector("#preview-stage"),
  moveDown: document.querySelector("#move-down-button"),
  moveUp: document.querySelector("#move-up-button"),
  previewCanvas: document.querySelector("#preview-canvas"),
  previewContent: document.querySelector("#preview-content"),
  previewDetails: document.querySelector("#preview-details"),
  previewEmpty: document.querySelector("#preview-empty"),
  previewTitle: document.querySelector("#preview-title"),
  selectionSummary: document.querySelector("#selection-summary"),
  status: document.querySelector("#status"),
  ungroup: document.querySelector("#ungroup-button"),
  workspace: document.querySelector("#workspace"),
};

// root holds loose layers and containers; a container's children are layers.
const state = { activeId: null, config: Config.load(), root: [], selectedIds: new Set(), sourceName: "layers" };
const DESCRIPTION_PREFIX = "scanner-container:";
const TIFF_SEPARATOR_DPI = 72;
const TIFF_SEPARATOR_WIDTH = 595;
const TIFF_SEPARATOR_HEIGHT = 842;
let nextId = 1;

/* ---------- undo / redo ---------- */

// Snapshots share the immutable pixel data and copy everything else.
const undoStack = [];
const redoStack = [];
let coalesceKey = null;

function cloneEntry(entry) {
  if (isContainer(entry)) return { ...entry, values: { ...entry.values }, overrides: { ...entry.overrides }, children: entry.children.map(cloneEntry) };
  return { ...entry, censors: entry.censors.map((censor) => ({ ...censor })) };
}

function snapshot() {
  return { activeId: state.activeId, root: state.root.map(cloneEntry), selectedIds: new Set(state.selectedIds) };
}

function pushHistory(before) {
  undoStack.push(before);
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

// A key coalesces consecutive edits (e.g. typing) into one undo step until the next change event.
function checkpoint(key = null) {
  if (key && key === coalesceKey) return;
  coalesceKey = key;
  pushHistory(snapshot());
}

function restore(target) {
  state.root = target.root;
  state.selectedIds = target.selectedIds;
  state.activeId = target.activeId;
  coalesceKey = null;
  render();
}

function stepHistory(from, to, emptyMessage) {
  const target = from.pop();
  if (!target) {
    setStatus(emptyMessage);
    return;
  }
  to.push(snapshot());
  restore(target);
}

const undo = () => stepHistory(undoStack, redoStack, "Nothing to undo.");
const redo = () => stepHistory(redoStack, undoStack, "Nothing to redo.");

document.addEventListener("change", () => { coalesceKey = null; }, true);

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function newId(prefix) {
  return `${prefix}-${nextId++}`;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", isError);
}

const isContainer = (entry) => entry.kind === "container";

function allLists() {
  return [state.root, ...state.root.filter(isContainer).map((container) => container.children)];
}

function locate(entryId) {
  for (const list of allLists()) {
    const index = list.findIndex((entry) => entry.id === entryId);
    if (index >= 0) return { entry: list[index], index, list, parent: list === state.root ? null : state.root.find((container) => container.children === list) };
  }
  return null;
}

function flat() {
  return state.root.flatMap((entry) => (isContainer(entry) ? [entry, ...entry.children] : [entry]));
}

function selectedEntries() {
  return flat().filter((entry) => state.selectedIds.has(entry.id));
}

function typeOf(container) {
  return state.config.types.find((type) => type.id === container.typeId) ?? null;
}

function fieldValue(container, field) {
  return container.values[field.id] ?? field.default;
}

function createCanvas(pixels, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas;
}

function thumbnailFor(canvas) {
  const maxSize = 120;
  const scale = Math.min(maxSize / canvas.width, maxSize / canvas.height, 1);
  const thumb = document.createElement("canvas");
  thumb.width = Math.max(1, Math.round(canvas.width * scale));
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL("image/png");
}

function isBlackSeparator(pixels) {
  const samples = Math.min(4096, pixels.length / 4);
  let dark = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const pixel = Math.floor(sample * (pixels.length / 4) / samples) * 4;
    if (pixels[pixel] < 12 && pixels[pixel + 1] < 12 && pixels[pixel + 2] < 12) dark += 1;
  }
  return samples > 0 && dark / samples > 0.995;
}

function createLayer(pixels, width, height, index, dpi = 300) {
  const rgba = new Uint8Array(pixels);
  const canvas = createCanvas(rgba, width, height);
  return { id: newId("layer"), kind: "layer", name: `Layer ${index}`, width, height, dpi, pixels: rgba, canvas, thumbnail: thumbnailFor(canvas), rotation: 0, flipX: false, flipY: false, censors: [] };
}

function createContainer(name) {
  return { id: newId("container"), kind: "container", name, typeId: "", values: {}, overrides: {}, collapsed: false, children: [], separator: null };
}

function blackPage() {
  const pixels = new Uint8Array(TIFF_SEPARATOR_WIDTH * TIFF_SEPARATOR_HEIGHT * 4);
  for (let pixel = 3; pixel < pixels.length; pixel += 4) pixels[pixel] = 255;
  return { width: TIFF_SEPARATOR_WIDTH, height: TIFF_SEPARATOR_HEIGHT, dpi: TIFF_SEPARATOR_DPI, pixels };
}

function legacyJpegStreams(buffer) {
  const view = new DataView(buffer);
  const littleEndian = view.getUint8(0) === 0x49 && view.getUint8(1) === 0x49;
  if (view.getUint16(2, littleEndian) !== 42) return [];
  const streams = [];
  let ifdOffset = view.getUint32(4, littleEndian);
  while (ifdOffset && ifdOffset + 2 <= view.byteLength) {
    const entryCount = view.getUint16(ifdOffset, littleEndian);
    let jpegOffset;
    let jpegLength;
    for (let index = 0; index < entryCount; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      if (entryOffset + 12 > view.byteLength) throw new Error("The TIFF directory is truncated.");
      const tag = view.getUint16(entryOffset, littleEndian);
      const type = view.getUint16(entryOffset + 2, littleEndian);
      const count = view.getUint32(entryOffset + 4, littleEndian);
      if (type === 4 && count === 1 && tag === 513) jpegOffset = view.getUint32(entryOffset + 8, littleEndian);
      if (type === 4 && count === 1 && tag === 514) jpegLength = view.getUint32(entryOffset + 8, littleEndian);
    }
    streams.push(jpegOffset !== undefined && jpegLength !== undefined ? { offset: jpegOffset, length: jpegLength } : null);
    const nextOffsetLocation = ifdOffset + 2 + entryCount * 12;
    if (nextOffsetLocation + 4 > view.byteLength) throw new Error("The TIFF directory is truncated.");
    ifdOffset = view.getUint32(nextOffsetLocation, littleEndian);
  }
  return streams;
}

async function decodeEmbeddedJpeg(buffer, stream) {
  if (stream.offset + stream.length > buffer.byteLength) throw new Error("An embedded JPEG stream extends beyond the TIFF file.");
  const image = await createImageBitmap(new Blob([buffer.slice(stream.offset, stream.offset + stream.length)], { type: "image/jpeg" }));
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(image, 0, 0);
  image.close();
  return { height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width };
}

/* ---------- selection ---------- */

function clearSelection() {
  state.selectedIds.clear();
  state.activeId = null;
  render();
}

let anchorId = null;

function visibleEntries() {
  return state.root.flatMap((entry) => (isContainer(entry) ? [entry, ...(entry.collapsed ? [] : entry.children)] : [entry]));
}

function selectEntry(entryId, toggle, range = false) {
  const visible = visibleEntries();
  const from = visible.findIndex((entry) => entry.id === anchorId);
  const to = visible.findIndex((entry) => entry.id === entryId);
  if (range && from >= 0 && to >= 0) {
    const ids = visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((entry) => entry.id);
    state.selectedIds = new Set(toggle ? [...state.selectedIds, ...ids] : ids);
    state.activeId = entryId;
    render();
    return;
  }
  anchorId = entryId;
  if (toggle) {
    if (state.selectedIds.has(entryId)) state.selectedIds.delete(entryId);
    else state.selectedIds.add(entryId);
  } else {
    state.selectedIds = new Set([entryId]);
  }
  state.activeId = state.selectedIds.has(entryId) ? entryId : selectedEntries().at(-1)?.id ?? null;
  render();
}

/* ---------- tree rendering ---------- */

const dropLine = document.createElement("div");
dropLine.className = "drop-line";
dropLine.hidden = true;

function layerRow(layer, isRoot) {
  const row = document.createElement("div");
  row.className = `layer-row${state.selectedIds.has(layer.id) ? " is-selected" : ""}`;
  row.dataset.id = layer.id;
  if (isRoot) row.dataset.blockId = layer.id;
  row.innerHTML = `
    <img class="layer-thumb" src="${layer.thumbnail}" alt="" draggable="false" />
    <span><span class="layer-name"></span><span class="layer-meta">${displaySize(layer).width} × ${displaySize(layer).height}</span></span>
  `;
  row.querySelector(".layer-name").textContent = layer.name;
  return row;
}

function containerBlock(container) {
  const block = document.createElement("div");
  block.className = "container-block";
  block.dataset.blockId = container.id;
  const header = document.createElement("div");
  header.className = `layer-row container-row${state.selectedIds.has(container.id) ? " is-selected" : ""}`;
  header.dataset.id = container.id;
  const type = typeOf(container);
  header.innerHTML = `
    <button class="collapse-toggle" type="button" data-toggle title="Expand or collapse">${container.collapsed ? "▸" : "▾"}</button>
    <span><span class="layer-name"></span><span class="layer-meta"></span></span>
  `;
  header.querySelector(".layer-name").textContent = container.name;
  header.querySelector(".layer-meta").textContent = `${type?.name ?? "No type"} · ${container.children.length} layer${container.children.length === 1 ? "" : "s"}`;
  block.append(header);
  if (!container.collapsed) {
    const body = document.createElement("div");
    body.className = "container-children";
    for (const child of container.children) body.append(layerRow(child, false));
    if (!container.children.length) {
      const empty = document.createElement("div");
      empty.className = "container-empty";
      empty.textContent = "Drag layers here";
      body.append(empty);
    }
    block.append(body);
  }
  return block;
}

function renderTree() {
  elements.layerTree.replaceChildren(dropLine);
  for (const entry of state.root) elements.layerTree.append(isContainer(entry) ? containerBlock(entry) : layerRow(entry, true));
}

function renderPreview() {
  const entry = activeLayer();
  const show = Boolean(entry);
  elements.previewContent.hidden = !show;
  elements.previewEmpty.hidden = show;
  if (!show) return;
  const { width, height } = displaySize(entry);
  elements.previewTitle.textContent = entry.name;
  elements.previewDetails.textContent = `${width} × ${height} px`;
  const preview = elements.previewCanvas;
  preview.width = width;
  preview.height = height;
  preview.getContext("2d", { alpha: false }).drawImage(renderLayer(entry, false), 0, 0);
  elements.previewStage.style.width = `${width}px`;
  renderOverlay();
}

/* ---------- container inspector ---------- */

function labeled(text, control) {
  const label = document.createElement("label");
  label.className = "field";
  const caption = document.createElement("span");
  caption.textContent = text;
  label.append(caption, control);
  return label;
}

function hideContextMenu() {
  elements.contextMenu.hidden = true;
}

function showContextMenu(x, items) {
  const menu = elements.contextMenu;
  menu.replaceChildren(...items.map(({ label, action, danger }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.classList.toggle("is-danger", Boolean(danger));
    button.addEventListener("click", () => { hideContextMenu(); action(); });
    return button;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.min(x.clientX, window.innerWidth - menu.offsetWidth - 4)}px`;
  menu.style.top = `${Math.min(x.clientY, window.innerHeight - menu.offsetHeight - 4)}px`;
}

function fieldControl(container, field) {
  const options = field.kind === "combo" ? Config.options(state.config, field.listId) : null;
  const value = fieldValue(container, field);
  const overridden = options && (container.overrides[field.id] || (value && !options.some((option) => option.value === value)));
  let control;
  if (options && !overridden) {
    control = document.createElement("select");
    control.append(new Option("— choose —", ""));
    for (const option of options) control.append(new Option(option.label, option.value));
    control.value = value;
    control.addEventListener("change", () => { checkpoint(); container.values[field.id] = control.value; });
  } else {
    control = document.createElement("input");
    control.type = "text";
    control.value = value;
    control.classList.toggle("is-overridden", Boolean(overridden));
    if (overridden) control.title = "Overridden — right-click to revert to the list";
    control.addEventListener("input", () => { checkpoint(`field-${container.id}-${field.id}`); container.values[field.id] = control.value; });
  }
  if (options) {
    control.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContextMenu(event, [overridden
        ? { label: "Revert to list", action: () => {
          checkpoint();
          delete container.overrides[field.id];
          if (!options.some((option) => option.value === container.values[field.id])) container.values[field.id] = "";
          renderInspector();
        } }
        : { label: "Override", action: () => { checkpoint(); container.overrides[field.id] = true; renderInspector(); } }]);
    });
  }
  return labeled(field.label || "(unnamed field)", control);
}

function renderInspector() {
  const selected = selectedEntries();
  const container = selected.length === 1 && isContainer(selected[0]) ? selected[0] : null;
  elements.inspector.hidden = !container;
  elements.inspector.replaceChildren();
  if (!container) return;

  const heading = document.createElement("p");
  heading.className = "eyebrow";
  heading.textContent = "Container";

  const name = document.createElement("input");
  name.type = "text";
  name.value = container.name;
  name.addEventListener("change", () => { checkpoint(); container.name = name.value.trim() || container.name; renderTree(); });

  const type = document.createElement("select");
  type.append(new Option("No type", ""));
  for (const candidate of state.config.types) type.append(new Option(candidate.name, candidate.id));
  type.value = typeOf(container) ? container.typeId : "";
  type.addEventListener("change", () => { checkpoint(); container.typeId = type.value; render(); });

  elements.inspector.append(heading, labeled("Name", name), labeled("Type", type));
  for (const field of typeOf(container)?.fields ?? []) elements.inspector.append(fieldControl(container, field));
  if (typeOf(container)?.fields.length === 0) {
    const note = document.createElement("p");
    note.className = "help-text";
    note.textContent = "This type has no fields. Add some on the admin page.";
    elements.inspector.append(note);
  }
}

function render() {
  const selected = selectedEntries();
  const layers = flat().filter((entry) => !isContainer(entry)).length;
  const containers = state.root.filter(isContainer).length;
  const hasLayers = layers + containers > 0;
  elements.workspace.classList.toggle("is-empty", !hasLayers);
  elements.layerCount.textContent = hasLayers ? `${layers} layer${layers === 1 ? "" : "s"} · ${containers} container${containers === 1 ? "" : "s"}` : "No layers";
  elements.selectionSummary.textContent = selected.length ? `${selected.length} item${selected.length === 1 ? "" : "s"} selected` : "Nothing selected";
  for (const button of [elements.clearSelection, elements.delete, elements.duplicate, elements.moveUp, elements.moveDown, elements.group]) {
    button.disabled = selected.length === 0;
  }
  elements.ungroup.disabled = !selected.some(isContainer);
  elements.groupLoose.disabled = !state.root.some((entry) => !isContainer(entry));
  for (const button of [elements.rotateLeft, elements.rotateRight, elements.mirrorH, elements.mirrorV]) button.disabled = selected.length === 0;
  elements.censorButton.disabled = !activeLayer();
  elements.censorButton.classList.toggle("is-active", censorState.active);
  elements.censorButton.setAttribute("aria-pressed", String(censorState.active));
  elements.export.disabled = !hasLayers;
  renderTree();
  renderPreview();
  renderCensorPanel();
  renderInspector();
}

/* ---------- editing operations ---------- */

function applyMove(ids, target) {
  checkpoint();
  const parent = target.parentId ? locate(target.parentId)?.entry : null;
  const list = parent ? parent.children : state.root;
  const moving = new Set(ids);
  let index = target.beforeId ? list.findIndex((entry) => entry.id === target.beforeId) : list.length;
  if (index < 0) index = list.length;
  while (index < list.length && moving.has(list[index].id)) index += 1;
  const anchor = list[index] ?? null;
  const entries = ids.map((entryId) => {
    const location = locate(entryId);
    location.list.splice(location.index, 1);
    return location.entry;
  });
  list.splice(anchor ? list.indexOf(anchor) : list.length, 0, ...entries);
  render();
}

function moveSelected(direction) {
  checkpoint();
  for (const list of allLists()) {
    const isSelected = (index) => state.selectedIds.has(list[index].id);
    if (direction < 0) {
      for (let index = 1; index < list.length; index += 1) {
        if (isSelected(index) && !isSelected(index - 1)) [list[index - 1], list[index]] = [list[index], list[index - 1]];
      }
    } else {
      for (let index = list.length - 2; index >= 0; index -= 1) {
        if (isSelected(index) && !isSelected(index + 1)) [list[index + 1], list[index]] = [list[index], list[index + 1]];
      }
    }
  }
  render();
}

function copyEntry(entry, suffix = " copy") {
  const copy = { ...entry, id: newId(entry.kind), name: `${entry.name}${suffix}` };
  if (isContainer(entry)) {
    copy.values = { ...entry.values };
    copy.overrides = { ...entry.overrides };
    copy.children = entry.children.map((child) => copyEntry(child, suffix));
  } else {
    copy.censors = entry.censors.map((censor) => ({ ...censor, id: newId("censor") }));
  }
  return copy;
}

let clipboard = [];

function copySelected() {
  const selected = selectedEntries();
  if (!selected.length) return;
  clipboard = selected
    .filter((entry) => !state.selectedIds.has(locate(entry.id).parent?.id))
    .map((entry) => copyEntry(entry, ""));
  setStatus(`Copied ${clipboard.length} item${clipboard.length === 1 ? "" : "s"}.`);
}

function pasteClipboard() {
  if (!clipboard.length) return;
  checkpoint();
  const copies = clipboard.map((entry) => copyEntry(entry, ""));
  const target = selectedEntries()[0];
  let list = state.root;
  let index = state.root.length;
  if (target) {
    const location = locate(target.id);
    // Containers cannot nest, so they paste above the target's top-level container.
    const anchor = copies.some(isContainer) ? location.parent ?? location.entry : location.entry;
    list = copies.some(isContainer) ? state.root : location.list;
    index = list.indexOf(anchor);
  }
  list.splice(index, 0, ...copies);
  state.selectedIds = new Set(copies.map((entry) => entry.id));
  state.activeId = copies.at(-1).id;
  render();
}

function duplicateSelected() {
  checkpoint();
  const copies = [];
  const duplicateIn = (list, parentSelected) => {
    const result = [];
    for (const entry of list) {
      result.push(entry);
      const selected = state.selectedIds.has(entry.id);
      if (isContainer(entry)) entry.children = duplicateIn(entry.children, selected);
      if (selected && !parentSelected) {
        const copy = copyEntry(entry);
        copies.push(copy.id);
        result.push(copy);
      }
    }
    return result;
  };
  state.root = duplicateIn(state.root, false);
  for (const copyId of copies) state.selectedIds.add(copyId);
  state.activeId = copies.at(-1) ?? state.activeId;
  render();
}

function deleteSelected() {
  checkpoint();
  state.root = state.root.filter((entry) => !state.selectedIds.has(entry.id));
  for (const container of state.root.filter(isContainer)) container.children = container.children.filter((child) => !state.selectedIds.has(child.id));
  clearSelection();
}

function groupSelected() {
  const selected = flat().filter((entry) => !isContainer(entry) && state.selectedIds.has(entry.id));
  if (!selected.length) {
    setStatus("Select one or more image layers to put in a container.", true);
    return;
  }
  checkpoint();
  const first = locate(selected[0].id);
  const container = createContainer(`Container ${state.root.filter(isContainer).length + 1}`);
  state.root.splice(state.root.indexOf(first.parent ?? first.entry), 0, container);
  for (const layer of selected) {
    const location = locate(layer.id);
    location.list.splice(location.index, 1);
  }
  container.children.push(...selected);
  state.selectedIds = new Set([container.id]);
  state.activeId = container.id;
  setStatus("Container created.");
  render();
}

// Each selected loose layer closes the group above it; the last selected layer and those below stay loose.
function insertSeparatorsMulti() {
  if (!state.root.some((entry) => !isContainer(entry) && state.selectedIds.has(entry.id))) {
    setStatus("Select loose layers to insert separators above.", true);
    return;
  }
  checkpoint();
  let count = state.root.filter(isContainer).length;
  const result = [];
  let index = 0;
  while (index < state.root.length) {
    if (isContainer(state.root[index])) {
      result.push(state.root[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < state.root.length && !isContainer(state.root[end])) end += 1;
    const run = state.root.slice(index, end);
    index = end;
    if (!run.some((layer) => state.selectedIds.has(layer.id))) {
      result.push(...run);
      continue;
    }
    let current = [];
    const flush = () => {
      if (!current.length) return;
      count += 1;
      const container = createContainer(`Container ${count}`);
      container.children = current;
      result.push(container);
      current = [];
    };
    const lastCut = run.findLastIndex((layer) => state.selectedIds.has(layer.id));
    for (const layer of run.slice(0, lastCut)) {
      if (state.selectedIds.has(layer.id)) flush();
      current.push(layer);
    }
    flush();
    result.push(...run.slice(lastCut));
  }
  state.root = result;
  setStatus("Separators inserted.");
  render();
}

// Groups the loose layers directly above the first selected layer; it and the layers below stay ungrouped.
function insertSeparatorAbove() {
  if (selectedEntries().filter((entry) => !isContainer(entry)).length > 1) {
    insertSeparatorsMulti();
    return;
  }
  const layer = selectedEntries().find((entry) => !isContainer(entry));
  if (!layer) {
    setStatus("Select a layer to insert a separator above.", true);
    return;
  }
  const location = locate(layer.id);
  if (location.parent) {
    if (location.index === 0) {
      setStatus("A separator already sits above this layer.");
      return;
    }
    checkpoint();
    const remainder = location.list.splice(location.index);
    state.root.splice(state.root.indexOf(location.parent) + 1, 0, ...remainder);
    setStatus("Layers from here down were released from the container.");
  } else {
    const { root } = state;
    let start = location.index;
    while (start > 0 && !isContainer(root[start - 1])) start -= 1;
    if (start === location.index) {
      setStatus("There are no loose layers above to group.");
      return;
    }
    checkpoint();
    const above = createContainer(`Container ${root.filter(isContainer).length + 1}`);
    above.children = root.splice(start, location.index - start, above);
    setStatus("Layers above grouped.");
  }
  render();
}

function groupLoose() {
  if (!state.root.some((entry) => !isContainer(entry))) return;
  checkpoint();
  let count = state.root.filter(isContainer).length;
  const result = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    count += 1;
    const container = createContainer(`Container ${count}`);
    container.children = run;
    result.push(container);
    run = [];
  };
  for (const entry of state.root) {
    if (isContainer(entry)) {
      flush();
      result.push(entry);
    } else {
      run.push(entry);
    }
  }
  flush();
  state.root = result;
  setStatus("Loose layers grouped.");
  render();
}

function ungroupSelected() {
  checkpoint();
  const released = [];
  for (const container of state.root.filter((entry) => isContainer(entry) && state.selectedIds.has(entry.id))) {
    state.root.splice(state.root.indexOf(container), 1, ...container.children);
    released.push(...container.children.map((child) => child.id));
  }
  state.selectedIds = new Set(released);
  state.activeId = released.at(-1) ?? null;
  render();
}

/* ---------- drag reordering ---------- */

let drag = null;
let suppressClick = false;

function draggedIds(entryId) {
  const ids = state.selectedIds.has(entryId) ? state.selectedIds : new Set([entryId]);
  return flat()
    .filter((entry) => ids.has(entry.id) && !ids.has(locate(entry.id).parent?.id))
    .map((entry) => entry.id);
}

function createGhost(ids) {
  const first = locate(ids[0]).entry;
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  const thumbnail = isContainer(first) ? first.children[0]?.thumbnail : first.thumbnail;
  if (thumbnail) {
    const image = new Image();
    image.src = thumbnail;
    ghost.append(image);
  }
  const label = document.createElement("span");
  label.textContent = ids.length > 1 ? `${ids.length} items` : first.name;
  ghost.append(label);
  return ghost;
}

function rowFor(entryId) {
  return elements.layerTree.querySelector(`[data-block-id="${entryId}"], [data-id="${entryId}"]`);
}

function childTarget(container, y) {
  const { children } = container;
  if (container.collapsed || !children.length) return { parentId: container.id, beforeId: null, into: true };
  for (let index = 0; index < children.length; index += 1) {
    const rect = rowFor(children[index].id).getBoundingClientRect();
    if (y >= rect.bottom) continue;
    return { parentId: container.id, beforeId: y < rect.top + rect.height / 2 ? children[index].id : children[index + 1]?.id ?? null };
  }
  return { parentId: container.id, beforeId: null };
}

function computeTarget(x, y, ids) {
  const treeRect = elements.layerTree.getBoundingClientRect();
  if (x < treeRect.left || x > treeRect.right || y < treeRect.top || y > treeRect.bottom) return null;
  const movingContainers = ids.some((entryId) => isContainer(locate(entryId).entry));
  for (let index = 0; index < state.root.length; index += 1) {
    const entry = state.root[index];
    const element = rowFor(entry.id);
    const rect = element.getBoundingClientRect();
    if (y >= rect.bottom) continue;
    const upper = y < rect.top + rect.height / 2;
    if (!isContainer(entry) || movingContainers) return { parentId: null, beforeId: upper ? entry.id : state.root[index + 1]?.id ?? null };
    const header = element.querySelector(".container-row").getBoundingClientRect();
    if (y < header.top + header.height * 0.3) return { parentId: null, beforeId: entry.id };
    return childTarget(entry, y);
  }
  return { parentId: null, beforeId: null };
}

function clearIndicator() {
  dropLine.hidden = true;
  elements.layerTree.querySelectorAll(".is-drop-into").forEach((element) => element.classList.remove("is-drop-into"));
}

function showTarget(target) {
  clearIndicator();
  if (!target) return;
  if (target.into) {
    rowFor(target.parentId).classList.add("is-drop-into");
    return;
  }
  const list = target.parentId ? locate(target.parentId).entry.children : state.root;
  const reference = rowFor(target.beforeId ?? list.at(-1).id).getBoundingClientRect();
  const treeRect = elements.layerTree.getBoundingClientRect();
  const edge = target.beforeId ? reference.top - 3 : reference.bottom + 3;
  dropLine.style.top = `${edge - treeRect.top + elements.layerTree.scrollTop - 2}px`;
  dropLine.style.left = `${reference.left - treeRect.left + elements.layerTree.scrollLeft}px`;
  dropLine.style.width = `${reference.width}px`;
  dropLine.hidden = false;
}

function markDragging(ids, on) {
  for (const entryId of ids) {
    const element = rowFor(entryId);
    if (element) element.classList.toggle("is-dragging", on);
  }
}

function endDrag(commit) {
  if (!drag) return;
  const finished = drag;
  drag = null;
  if (!finished.active) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 50);
  finished.ghost.remove();
  document.body.classList.remove("is-reordering");
  clearIndicator();
  markDragging(finished.ids, false);
  if (commit && finished.target) applyMove(finished.ids, finished.target);
}

elements.layerTree.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("[data-toggle]")) return;
  const row = event.target.closest("[data-id]");
  if (row) drag = { active: false, id: row.dataset.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, target: null };
});

window.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.active = true;
    drag.ids = draggedIds(drag.id);
    drag.ghost = createGhost(drag.ids);
    document.body.append(drag.ghost);
    document.body.classList.add("is-reordering");
    markDragging(drag.ids, true);
  }
  drag.ghost.style.transform = `translate(${event.clientX + 14}px, ${event.clientY + 14}px)`;
  const treeRect = elements.layerTree.getBoundingClientRect();
  if (event.clientY < treeRect.top + 36) elements.layerTree.scrollTop -= 14;
  else if (event.clientY > treeRect.bottom - 36) elements.layerTree.scrollTop += 14;
  drag.target = computeTarget(event.clientX, event.clientY, drag.ids);
  showTarget(drag.target);
});

window.addEventListener("pointerup", (event) => {
  if (drag && event.pointerId === drag.pointerId) endDrag(true);
});
window.addEventListener("pointercancel", () => endDrag(false));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { endDrag(false); hideContextMenu(); }
  const typing = event.target.closest?.("input, select, textarea");
  if (event.key === "F2" && !typing && location.hash !== "#/admin") {
    const target = selectedEntries().at(-1);
    if (target) { event.preventDefault(); startRename(target.id); }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    if (!typing && location.hash !== "#/admin") insertSeparatorAbove();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
    event.preventDefault();
    if (!typing && location.hash !== "#/admin") groupSelected();
  }
  const textEditing = event.target.closest?.("input:not([type=color]), textarea");
  const historyKey = (event.ctrlKey || event.metaKey) ? event.key.toLowerCase() : "";
  if (!textEditing && !drag && !censorDrag && location.hash !== "#/admin" && !document.querySelector(".modal-backdrop")) {
    if (historyKey === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (historyKey === "y") { event.preventDefault(); redo(); }
    else if (historyKey === "c") { event.preventDefault(); copySelected(); }
    else if (historyKey === "v") { event.preventDefault(); pasteClipboard(); }
  }
  if (event.key === "Delete" && !typing && !drag && !censorDrag && location.hash !== "#/admin" && !document.querySelector(".modal-backdrop") && state.selectedIds.size) {
    event.preventDefault();
    confirmDelete();
  }
  if (event.key === "Backspace" && !typing && censorState.active && censorState.selectedId) removeCensor(censorState.selectedId);
});
window.addEventListener("click", (event) => {
  if (!elements.contextMenu.contains(event.target)) hideContextMenu();
});

function confirmDialog(message) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "modal";
    dialog.setAttribute("role", "alertdialog");
    const text = document.createElement("p");
    text.textContent = message;
    const hint = document.createElement("p");
    hint.className = "help-text";
    hint.textContent = "Enter = Yes, Esc = No";
    const actions = document.createElement("div");
    actions.className = "admin-row";
    const no = Object.assign(document.createElement("button"), { type: "button", className: "button", textContent: "No" });
    const yes = Object.assign(document.createElement("button"), { type: "button", className: "button button-danger", textContent: "Yes" });
    actions.append(no, yes);
    dialog.append(text, hint, actions);
    backdrop.append(dialog);
    const finish = (result) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(result);
    };
    function onKey(event) {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(event.key === "Enter");
    }
    document.addEventListener("keydown", onKey, true);
    no.addEventListener("click", () => finish(false));
    yes.addEventListener("click", () => finish(true));
    document.body.append(backdrop);
    yes.focus();
  });
}

async function confirmDelete() {
  const selected = selectedEntries();
  const containers = selected.filter(isContainer).length;
  const noun = selected.length === 1 ? (containers ? "this container" : "this layer") : `these ${selected.length} items`;
  const extra = containers ? " Layers inside deleted containers are deleted too." : "";
  if (await confirmDialog(`Delete ${noun}?${extra}`)) deleteSelected();
}

function startRename(entryId) {
  const entry = locate(entryId)?.entry;
  const label = elements.layerTree.querySelector(`[data-id="${entryId}"] .layer-name`);
  if (!entry || !label) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rename-input";
  input.value = entry.name;
  label.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (commit && name && name !== entry.name) {
      checkpoint();
      entry.name = name;
    }
    render();
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  for (const name of ["pointerdown", "click", "dblclick", "contextmenu"]) input.addEventListener(name, (event) => event.stopPropagation());
}

elements.layerTree.addEventListener("dblclick", (event) => {
  const row = event.target.closest("[data-id]");
  if (row && !event.target.closest("[data-toggle]")) startRename(row.dataset.id);
});

window.addEventListener("contextmenu", hideContextMenu, true);
elements.layerTree.addEventListener("contextmenu", (event) => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  event.preventDefault();
  if (!state.selectedIds.has(row.dataset.id)) selectEntry(row.dataset.id, false);
  const selected = selectedEntries();
  const items = [];
  if (selected.some((entry) => !isContainer(entry))) items.push({ label: "New container (Ctrl+G)", action: groupSelected });
  if (selected.some(isContainer)) items.push({ label: "Ungroup", action: ungroupSelected });
  if (selected.some((entry) => !isContainer(entry))) items.push({ label: "Insert separator above (Ctrl+B)", action: insertSeparatorAbove });
  items.push(
    ...(selected.length === 1 ? [{ label: "Rename (F2)", action: () => startRename(selected[0].id) }] : []),
    { label: "Duplicate", action: duplicateSelected },
    { label: "Delete…", action: confirmDelete, danger: true },
  );
  showContextMenu(event, items);
});

elements.layerTree.addEventListener("click", (event) => {
  if (suppressClick) return;
  const toggle = event.target.closest("[data-toggle]");
  const row = event.target.closest("[data-id]");
  if (toggle && row) {
    const container = locate(row.dataset.id).entry;
    container.collapsed = !container.collapsed;
    render();
  } else if (row) {
    selectEntry(row.dataset.id, event.ctrlKey || event.metaKey, event.shiftKey);
  } else if (event.target === elements.layerTree) {
    clearSelection();
  }
});

function reloadConfig() {
  state.config = Config.load();
  render();
}

window.addEventListener("scanner:config", reloadConfig);
window.addEventListener("storage", (event) => {
  if (event.key === Config.KEY) reloadConfig();
});

function route() {
  const view = location.hash === "#/admin" ? "admin" : "editor";
  document.querySelectorAll("[data-view]").forEach((node) => { node.hidden = node.dataset.view !== view; });
  hideContextMenu();
}

window.addEventListener("hashchange", route);

/* ---------- page transforms and censoring ---------- */

// Censors are stored in display space (after rotation/mirroring) and follow the page when it is transformed.
const censorState = { active: false, selectedId: null };
const SVG_NS = "http://www.w3.org/2000/svg";
let censorInputs = {};
let censorDrag = null;

function activeLayer() {
  const entry = state.activeId ? locate(state.activeId)?.entry : null;
  return entry && !isContainer(entry) && state.selectedIds.has(entry.id) ? entry : null;
}

function displaySize(layer) {
  return layer.rotation % 180 === 0 ? { width: layer.width, height: layer.height } : { width: layer.height, height: layer.width };
}

function renderLayer(layer, withCensors) {
  const { width, height } = displaySize(layer);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.translate(width / 2, height / 2);
  context.rotate(layer.rotation * Math.PI / 180);
  context.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
  context.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (withCensors) {
    for (const censor of layer.censors) {
      context.save();
      context.translate(censor.x, censor.y);
      context.rotate(censor.rotation * Math.PI / 180);
      context.fillStyle = censor.color;
      context.fillRect(-censor.w / 2, -censor.h / 2, censor.w, censor.h);
      context.restore();
    }
  }
  return canvas;
}

function bakedPage(layer) {
  if (!layer.rotation && !layer.flipX && !layer.flipY && !layer.censors.length) return layer;
  const canvas = renderLayer(layer, true);
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  return { width: canvas.width, height: canvas.height, dpi: layer.dpi, pixels };
}

function refreshThumbnail(layer) {
  layer.thumbnail = thumbnailFor(renderLayer(layer, true));
}

const normalizeAngle = (angle) => ((((angle + 180) % 360) + 360) % 360) - 180;

function transformLayer(layer, op) {
  const { width, height } = displaySize(layer);
  for (const censor of layer.censors) {
    if (op === "cw") [censor.x, censor.y, censor.rotation] = [height - censor.y, censor.x, censor.rotation + 90];
    else if (op === "ccw") [censor.x, censor.y, censor.rotation] = [censor.y, width - censor.x, censor.rotation - 90];
    else if (op === "flipX") [censor.x, censor.rotation] = [width - censor.x, -censor.rotation];
    else [censor.y, censor.rotation] = [height - censor.y, -censor.rotation];
    censor.rotation = normalizeAngle(censor.rotation);
  }
  if (op === "cw") layer.rotation = (layer.rotation + 90) % 360;
  else if (op === "ccw") layer.rotation = (layer.rotation + 270) % 360;
  else {
    // A displayed horizontal mirror is a source-vertical flip when the page is turned sideways.
    const sideways = layer.rotation % 180 !== 0;
    const flipSourceX = (op === "flipX") !== sideways;
    if (flipSourceX) layer.flipX = !layer.flipX;
    else layer.flipY = !layer.flipY;
  }
  refreshThumbnail(layer);
}

function transformSelected(op) {
  checkpoint();
  const targets = new Set();
  for (const entry of selectedEntries()) {
    if (isContainer(entry)) entry.children.forEach((child) => targets.add(child));
    else targets.add(entry);
  }
  targets.forEach((layer) => transformLayer(layer, op));
  render();
}

function svgEl(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function renderOverlay() {
  const layer = activeLayer();
  const svg = elements.previewOverlay;
  svg.replaceChildren();
  if (!layer) return;
  const { width, height } = displaySize(layer);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.classList.toggle("is-editing", censorState.active);
  const unit = width / (svg.getBoundingClientRect().width || width);
  for (const censor of layer.censors) {
    const group = svgEl("g", { transform: `translate(${censor.x} ${censor.y}) rotate(${censor.rotation})` });
    const selected = censorState.active && censor.id === censorState.selectedId;
    group.append(svgEl("rect", {
      "data-censor": censor.id, fill: censor.color, height: censor.h, width: censor.w, x: -censor.w / 2, y: -censor.h / 2,
      ...(selected ? { stroke: "#60a5fa", "stroke-width": 2 * unit } : {}),
    }));
    if (selected) {
      const stem = 28 * unit;
      group.append(
        svgEl("line", { stroke: "#60a5fa", "stroke-width": 2 * unit, x1: 0, x2: 0, y1: -censor.h / 2, y2: -censor.h / 2 - stem }),
        svgEl("circle", { "data-handle": "rotate", cx: 0, cy: -censor.h / 2 - stem, fill: "#60a5fa", r: 7 * unit }),
        svgEl("rect", { "data-handle": "resize", fill: "#60a5fa", height: 12 * unit, width: 12 * unit, x: censor.w / 2 - 6 * unit, y: censor.h / 2 - 6 * unit }),
      );
    }
    svg.append(group);
  }
}

function svgPoint(event) {
  const svg = elements.previewOverlay;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return { x: point.x, y: point.y };
}

function rotatePoint(x, y, degrees) {
  const radians = degrees * Math.PI / 180;
  return { x: x * Math.cos(radians) - y * Math.sin(radians), y: x * Math.sin(radians) + y * Math.cos(radians) };
}

function addCensor(layer, box) {
  const { width, height } = displaySize(layer);
  const censor = { id: newId("censor"), x: width / 2, y: height / 2, w: width * 0.3, h: height * 0.1, rotation: 0, color: "#000000", ...box };
  layer.censors.push(censor);
  censorState.selectedId = censor.id;
  return censor;
}

function removeCensor(censorId) {
  const layer = activeLayer();
  if (!layer) return;
  checkpoint();
  layer.censors = layer.censors.filter((censor) => censor.id !== censorId);
  if (censorState.selectedId === censorId) censorState.selectedId = null;
  refreshThumbnail(layer);
  render();
}

function syncCensorInputs(censor) {
  for (const [key, input] of Object.entries(censorInputs)) input.value = key === "color" ? censor[key] : Math.round(censor[key] * 10) / 10;
}

elements.previewOverlay.addEventListener("pointerdown", (event) => {
  const layer = activeLayer();
  if (!layer || !censorState.active || event.button !== 0) return;
  event.preventDefault();
  const point = svgPoint(event);
  const before = snapshot();
  const { handle, censor: hitId } = event.target.dataset;
  const selected = layer.censors.find((censor) => censor.id === censorState.selectedId);
  if (handle && selected) {
    censorDrag = { censor: selected, mode: handle };
  } else if (hitId) {
    censorState.selectedId = hitId;
    const hit = layer.censors.find((censor) => censor.id === hitId);
    censorDrag = { censor: hit, dx: hit.x - point.x, dy: hit.y - point.y, mode: "move" };
  } else {
    censorDrag = { censor: addCensor(layer, { x: point.x, y: point.y, w: 0, h: 0 }), mode: "draw", start: point };
  }
  elements.previewOverlay.setPointerCapture(event.pointerId);
  censorDrag.before = before;
  censorDrag.moved = false;
  renderOverlay();
});

elements.previewOverlay.addEventListener("pointermove", (event) => {
  if (!censorDrag) return;
  censorDrag.moved = true;
  const { censor, mode } = censorDrag;
  const point = svgPoint(event);
  if (mode === "move") {
    censor.x = point.x + censorDrag.dx;
    censor.y = point.y + censorDrag.dy;
  } else if (mode === "draw") {
    censor.x = (censorDrag.start.x + point.x) / 2;
    censor.y = (censorDrag.start.y + point.y) / 2;
    censor.w = Math.abs(point.x - censorDrag.start.x);
    censor.h = Math.abs(point.y - censorDrag.start.y);
  } else if (mode === "rotate") {
    censor.rotation = normalizeAngle(Math.atan2(point.y - censor.y, point.x - censor.x) * 180 / Math.PI + 90);
  } else {
    // Keep the top-left corner fixed in the box's own frame while the bottom-right follows the pointer.
    const anchor = rotatePoint(-censor.w / 2, -censor.h / 2, censor.rotation);
    const corner = { x: censor.x + anchor.x, y: censor.y + anchor.y };
    const local = rotatePoint(point.x - corner.x, point.y - corner.y, -censor.rotation);
    censor.w = Math.max(4, local.x);
    censor.h = Math.max(4, local.y);
    const center = rotatePoint(censor.w / 2, censor.h / 2, censor.rotation);
    censor.x = corner.x + center.x;
    censor.y = corner.y + center.y;
  }
  renderOverlay();
  if (Object.keys(censorInputs).length) syncCensorInputs(censor);
});

function endCensorDrag() {
  if (!censorDrag) return;
  const { before, censor, mode, moved } = censorDrag;
  censorDrag = null;
  const layer = activeLayer();
  if (!layer) return;
  let changed = moved;
  if (mode === "draw" && (censor.w < 6 || censor.h < 6)) {
    layer.censors = layer.censors.filter((candidate) => candidate !== censor);
    censorState.selectedId = null;
    changed = false;
  }
  if (changed) pushHistory(before);
  refreshThumbnail(layer);
  render();
}

elements.previewOverlay.addEventListener("pointerup", endCensorDrag);
elements.previewOverlay.addEventListener("pointercancel", endCensorDrag);

function renderCensorPanel() {
  const layer = activeLayer();
  const panel = elements.censorPanel;
  censorInputs = {};
  panel.hidden = !(censorState.active && layer);
  panel.replaceChildren();
  if (panel.hidden) return;
  if (!layer.censors.some((censor) => censor.id === censorState.selectedId)) censorState.selectedId = null;

  const heading = document.createElement("p");
  heading.className = "eyebrow";
  heading.textContent = "Censor boxes";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "button";
  add.textContent = "Add box";
  add.addEventListener("click", () => { checkpoint(); addCensor(layer); refreshThumbnail(layer); render(); });
  const list = document.createElement("div");
  list.className = "censor-list";
  layer.censors.forEach((censor, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `button${censor.id === censorState.selectedId ? " is-active" : ""}`;
    item.textContent = `Box ${index + 1}`;
    item.addEventListener("click", () => { censorState.selectedId = censor.id; render(); });
    list.append(item);
  });
  panel.append(heading, add, list);

  const censor = layer.censors.find((candidate) => candidate.id === censorState.selectedId);
  if (!censor) {
    const hint = document.createElement("p");
    hint.className = "help-text";
    hint.textContent = "Drag on the preview to draw a box, or select one to move, resize and rotate it.";
    panel.append(hint);
    return;
  }
  const fields = document.createElement("div");
  fields.className = "censor-fields";
  for (const [key, label] of [["x", "Center X"], ["y", "Center Y"], ["w", "Width"], ["h", "Height"], ["rotation", "Rotation °"], ["color", "Color"]]) {
    const input = key === "color" ? createColorPicker() : document.createElement("input");
    if (key !== "color") {
      input.type = "number";
      input.step = "any";
    }
    input.addEventListener("input", () => {
      const value = key === "color" ? input.value : Number(input.value);
      if (key !== "color" && !Number.isFinite(value)) return;
      checkpoint(`censor-${censor.id}-${key}`);
      censor[key] = key === "w" || key === "h" ? Math.max(1, value) : value;
      renderOverlay();
    });
    input.addEventListener("change", () => { refreshThumbnail(layer); renderTree(); });
    censorInputs[key] = input;
    fields.append(labeled(label, input));
  }
  syncCensorInputs(censor);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button button-danger";
  remove.textContent = "Delete box";
  remove.addEventListener("click", () => removeCensor(censor.id));
  panel.append(fields, remove);
}

/* ---------- import ---------- */

function readDescription(ifd) {
  const raw = ifd.t270;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : "";
  const cleaned = text.replace(/\0+$/, "");
  if (!cleaned.startsWith(DESCRIPTION_PREFIX)) return null;
  try {
    return JSON.parse(cleaned.slice(DESCRIPTION_PREFIX.length));
  } catch {
    return null;
  }
}

async function loadTiff(file) {
  if (!file || !/\.tiff?$/i.test(file.name)) {
    setStatus("Choose a .tif or .tiff file.", true);
    return;
  }
  if (!window.UTIF) {
    setStatus("The TIFF codec did not load. Check your connection and reload the page.", true);
    return;
  }
  try {
    setStatus(`Reading ${file.name}…`);
    const buffer = await file.arrayBuffer();
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) throw new Error("The file contains no TIFF pages.");
    const jpegStreams = legacyJpegStreams(buffer);
    const root = [];
    let current = null;
    let layerNumber = 0;
    for (let index = 0; index < ifds.length; index += 1) {
      setStatus(`Decoding page ${index + 1} of ${ifds.length}…`);
      await nextFrame();
      const ifd = ifds[index];
      let page;
      if (jpegStreams[index]) {
        page = await decodeEmbeddedJpeg(buffer, jpegStreams[index]);
      } else {
        UTIF.decodeImage(buffer, ifd);
        page = { height: ifd.height, pixels: UTIF.toRGBA8(ifd), width: ifd.width };
      }
      const meta = readDescription(ifd);
      const separator = isBlackSeparator(page.pixels);
      if (separator || meta) {
        const containerMeta = meta ?? {};
        current = createContainer(typeof containerMeta.name === "string" && containerMeta.name ? containerMeta.name : `Container ${root.filter(isContainer).length + 1}`);
        current.typeId = typeof containerMeta.typeId === "string" ? containerMeta.typeId : "";
        if (containerMeta.values && typeof containerMeta.values === "object") current.values = Object.fromEntries(Object.entries(containerMeta.values).map(([key, value]) => [key, String(value)]));
        if (containerMeta.overrides && typeof containerMeta.overrides === "object") current.overrides = { ...containerMeta.overrides };
        root.push(current);
        if (separator) {
          current.separator = { width: page.width, height: page.height, dpi: 300, pixels: new Uint8Array(page.pixels) };
        } else {
          layerNumber += 1;
          current.children.push(createLayer(page.pixels, page.width, page.height, layerNumber, 300));
        }
      } else {
        layerNumber += 1;
        (current ? current.children : root).push(createLayer(page.pixels, page.width, page.height, layerNumber, 300));
      }
    }
    state.root = root;
    undoStack.length = 0;
    redoStack.length = 0;
    state.selectedIds.clear();
    state.activeId = null;
    state.sourceName = file.name.replace(/\.tiff?$/i, "") || "layers";
    setStatus(`${layerNumber} layers in ${root.filter(isContainer).length} containers loaded.`);
    render();
  } catch (error) {
    console.error(error);
    setStatus(`Could not read TIFF: ${error.message}`, true);
  }
}

/* ---------- export ---------- */

function describeContainer(container) {
  const type = typeOf(container);
  const values = { ...container.values };
  const fields = {};
  for (const field of type?.fields ?? []) {
    values[field.id] = fieldValue(container, field);
    fields[field.label] = values[field.id];
  }
  const json = JSON.stringify({ name: container.name, typeId: container.typeId, typeName: type?.name ?? "", values, overrides: container.overrides, fields });
  return DESCRIPTION_PREFIX + json.replace(/[\u0080-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function exportPages() {
  const pages = [];
  for (const entry of state.root) {
    if (!isContainer(entry)) {
      pages.push(bakedPage(entry));
      continue;
    }
    const children = entry.children.map(bakedPage);
    if (pages.length === 0 && children.length) {
      children[0].description = describeContainer(entry);
      pages.push(...children);
    } else {
      pages.push({ ...blackPage(), description: describeContainer(entry) }, ...children);
    }
  }
  return pages;
}

function writeEntry(view, offset, tag, type, count, value) {
  view.setUint16(offset, tag, true);
  view.setUint16(offset + 2, type, true);
  view.setUint32(offset + 4, count, true);
  if (type === 3 && count === 1) view.setUint16(offset + 8, value, true);
  else view.setUint32(offset + 8, value, true);
}

function buildTiff(pages) {
  let cursor = 8;
  const plan = pages.map((page) => {
    const text = page.description ? new TextEncoder().encode(`${page.description}\0`) : null;
    const tags = text ? 15 : 14;
    const ifdOffset = cursor;
    const metadataOffset = ifdOffset + 2 + tags * 12 + 4;
    const textOffset = metadataOffset + 24;
    cursor = textOffset + (text ? text.length + (text.length & 1) : 0);
    return { ifdOffset, metadataOffset, page, tags, text, textOffset };
  });
  const header = new ArrayBuffer(cursor);
  const view = new DataView(header);
  view.setUint8(0, 0x49); view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  let pixelOffset = cursor;
  plan.forEach(({ ifdOffset, metadataOffset, page, tags, text, textOffset }, index) => {
    view.setUint16(ifdOffset, tags, true);
    let entry = ifdOffset + 2;
    const add = (tag, type, count, value) => { writeEntry(view, entry, tag, type, count, value); entry += 12; };
    add(256, 4, 1, page.width);
    add(257, 4, 1, page.height);
    add(258, 3, 4, metadataOffset);
    add(259, 3, 1, 1);
    add(262, 3, 1, 2);
    if (text) {
      add(270, 2, text.length, textOffset);
      new Uint8Array(header, textOffset, text.length).set(text);
    }
    add(273, 4, 1, pixelOffset);
    add(274, 3, 1, 1);
    add(277, 3, 1, 4);
    add(278, 4, 1, page.height);
    add(279, 4, 1, page.pixels.byteLength);
    add(282, 5, 1, metadataOffset + 8);
    add(283, 5, 1, metadataOffset + 16);
    add(284, 3, 1, 1);
    add(338, 3, 1, 2);
    view.setUint32(entry, plan[index + 1]?.ifdOffset ?? 0, true);
    [0, 2, 4, 6].forEach((offset) => view.setUint16(metadataOffset + offset, 8, true));
    const dpi = Math.max(1, Math.round(page.dpi || 300));
    view.setUint32(metadataOffset + 8, dpi, true); view.setUint32(metadataOffset + 12, 1, true);
    view.setUint32(metadataOffset + 16, dpi, true); view.setUint32(metadataOffset + 20, 1, true);
    pixelOffset += page.pixels.byteLength;
  });
  return new Blob([header, ...plan.map(({ page }) => page.pixels)], { type: "image/tiff" });
}

function exportTiff() {
  if (!state.root.length) return;
  try {
    setStatus("Preparing TIFF export…");
    const blob = buildTiff(exportPages());
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${state.sourceName}-edited.tif`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
    setStatus("TIFF export started.");
  } catch (error) {
    console.error(error);
    setStatus(`Could not export TIFF: ${error.message}`, true);
  }
}

elements.fileInput.addEventListener("change", (event) => loadTiff(event.target.files[0]));
elements.clearSelection.addEventListener("click", clearSelection);
elements.delete.addEventListener("click", deleteSelected);
elements.duplicate.addEventListener("click", duplicateSelected);
elements.group.addEventListener("click", groupSelected);
elements.ungroup.addEventListener("click", ungroupSelected);
elements.groupLoose.addEventListener("click", groupLoose);
elements.moveUp.addEventListener("click", () => moveSelected(-1));
elements.moveDown.addEventListener("click", () => moveSelected(1));
elements.export.addEventListener("click", exportTiff);
elements.rotateLeft.addEventListener("click", () => transformSelected("ccw"));
elements.rotateRight.addEventListener("click", () => transformSelected("cw"));
elements.mirrorH.addEventListener("click", () => transformSelected("flipX"));
elements.mirrorV.addEventListener("click", () => transformSelected("flipY"));
elements.censorButton.addEventListener("click", () => { censorState.active = !censorState.active; render(); });
window.addEventListener("resize", renderOverlay);
["dragenter", "dragover"].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("is-over");
}));
["dragleave", "drop"].forEach((eventName) => elements.dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("is-over");
}));
elements.dropZone.addEventListener("drop", (event) => loadTiff(event.dataTransfer.files[0]));

route();
render();
