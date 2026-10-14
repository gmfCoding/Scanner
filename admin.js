/* global Config */
(() => {

const typesRoot = document.querySelector("#types");
const listsRoot = document.querySelector("#lists");
const statusRoot = document.querySelector("#status");
const configFile = document.querySelector("#config-file");

let config = Config.load();
let importMode = "replace";

function setStatus(message, isError = false) {
  statusRoot.textContent = message;
  statusRoot.classList.toggle("is-error", isError);
}

function persist() {
  Config.save(config);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function textInput(value, placeholder, onInput) {
  const input = el("input", { type: "text", value, placeholder });
  input.addEventListener("input", () => { onInput(input.value); persist(); });
  return input;
}

function select(options, value, onChange) {
  const control = el("select");
  for (const [optionValue, label] of options) control.append(new Option(label, optionValue));
  control.value = value;
  control.addEventListener("change", () => onChange(control.value));
  return control;
}

function button(label, onClick, className = "button") {
  const node = el("button", { type: "button", className, textContent: label });
  node.addEventListener("click", onClick);
  return node;
}

function renderFieldRow(type, field) {
  const listOptions = [["", "— no list —"], ...config.lists.map((list) => [list.id, list.name])];
  const listSelect = select(listOptions, field.listId, (value) => { field.listId = value; persist(); });
  listSelect.hidden = field.kind !== "combo";
  const kind = select([["string", "Any string"], ["combo", "Combo list"]], field.kind, (value) => {
    field.kind = value;
    listSelect.hidden = value !== "combo";
    persist();
  });
  return el("div", { className: "field-row" },
    textInput(field.label, "Field label", (value) => { field.label = value; }),
    kind,
    listSelect,
    textInput(field.default, "Default value", (value) => { field.default = value; }),
    button("×", () => { type.fields = type.fields.filter((candidate) => candidate !== field); persist(); renderTypes(); }, "icon-button"));
}

function renderTypes() {
  typesRoot.replaceChildren(...config.types.map((type) => el("div", { className: "admin-card" },
    el("div", { className: "admin-row" },
      textInput(type.name, "Type name", (value) => { type.name = value; }),
      button("Delete type", () => { config.types = config.types.filter((candidate) => candidate !== type); persist(); renderTypes(); }, "button button-danger")),
    ...type.fields.map((field) => renderFieldRow(type, field)),
    button("Add field", () => {
      type.fields.push({ id: Config.uid("field"), label: "", kind: "string", listId: "", default: "" });
      persist();
      renderTypes();
    }))));
  if (!config.types.length) typesRoot.textContent = "No container types yet.";
}

const itemsToText = (list) => list.items.map((item) => (list.kind === "dict" ? `${item.key}=${item.value}` : item)).join("\n");

function textToItems(list, text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (list.kind === "list") return lines;
  return lines.map((line) => {
    const split = line.indexOf("=");
    return split < 0 ? { key: line, value: line } : { key: line.slice(0, split).trim(), value: line.slice(split + 1).trim() };
  }).filter((item) => item.key);
}

function renderLists() {
  listsRoot.replaceChildren(...config.lists.map((list) => {
    const items = el("textarea", {
      placeholder: list.kind === "dict" ? "One per line: display name=value" : "One value per line",
      value: itemsToText(list),
    });
    items.addEventListener("change", () => { list.items = textToItems(list, items.value); persist(); });
    const kind = select([["list", "List"], ["dict", "Dictionary"]], list.kind, (value) => {
      list.items = textToItems(list, items.value);
      if (value === "dict" && list.kind === "list") list.items = list.items.map((item) => ({ key: item, value: item }));
      if (value === "list" && list.kind === "dict") list.items = list.items.map((item) => item.value);
      list.kind = value;
      persist();
      renderLists();
    });
    const name = textInput(list.name, "List name", (value) => { list.name = value; });
    name.addEventListener("change", renderTypes);
    return el("div", { className: "admin-card" },
      el("div", { className: "admin-row" },
        name,
        kind,
        button("Delete", () => {
          config.lists = config.lists.filter((candidate) => candidate !== list);
          for (const type of config.types) for (const field of type.fields) if (field.listId === list.id) field.listId = "";
          persist();
          renderAll();
        }, "button button-danger")),
      items);
  }));
  if (!config.lists.length) listsRoot.textContent = "No data lists yet.";
}

function renderAll() {
  renderTypes();
  renderLists();
}

document.querySelector("#add-type").addEventListener("click", () => {
  config.types.push({ id: Config.uid("type"), name: "New type", fields: [] });
  persist();
  renderTypes();
});

document.querySelector("#add-list").addEventListener("click", () => {
  config.lists.push({ id: Config.uid("list"), name: "New list", kind: "list", items: [] });
  persist();
  renderAll();
});

document.querySelector("#export-config").addEventListener("click", () => {
  const link = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" })), download: "scanner-config.json" });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  setStatus("Configuration exported.");
});

for (const [id, mode] of [["#import-config", "replace"], ["#merge-config", "merge"]]) {
  document.querySelector(id).addEventListener("click", () => { importMode = mode; configFile.click(); });
}

configFile.addEventListener("change", async () => {
  const [file] = configFile.files;
  configFile.value = "";
  if (!file) return;
  try {
    const incoming = Config.parse(await file.text());
    config = importMode === "merge" ? Config.merge(config, incoming) : incoming;
    persist();
    renderAll();
    setStatus(importMode === "merge" ? "Configuration merged." : "Configuration replaced.");
  } catch (error) {
    setStatus(`Could not import: ${error.message}`, true);
  }
});

renderAll();
})();
