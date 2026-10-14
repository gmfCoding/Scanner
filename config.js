/* Shared configuration store (container types, data lists) persisted in localStorage. */
const Config = (() => {
  const KEY = "scanner.config.v1";

  const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const str = (value) => (typeof value === "string" ? value : value == null ? "" : String(value));

  function cleanField(field) {
    return {
      id: str(field?.id) || uid("field"),
      label: str(field?.label),
      kind: field?.kind === "combo" ? "combo" : "string",
      listId: str(field?.listId),
      default: str(field?.default),
    };
  }

  function cleanType(type) {
    return {
      id: str(type?.id) || uid("type"),
      name: str(type?.name) || "Untitled type",
      fields: Array.isArray(type?.fields) ? type.fields.map(cleanField) : [],
    };
  }

  function cleanList(list) {
    const kind = list?.kind === "dict" ? "dict" : "list";
    const raw = Array.isArray(list?.items) ? list.items : [];
    const items = kind === "dict"
      ? raw.map((item) => ({ key: str(item?.key), value: str(item?.value) })).filter((item) => item.key)
      : raw.map(str).filter(Boolean);
    return { id: str(list?.id) || uid("list"), name: str(list?.name) || "Untitled list", kind, items };
  }

  function sanitize(raw) {
    return {
      version: 1,
      types: Array.isArray(raw?.types) ? raw.types.map(cleanType) : [],
      lists: Array.isArray(raw?.lists) ? raw.lists.map(cleanList) : [],
    };
  }

  function seed() {
    const list = { id: uid("list"), name: "Permit classes", kind: "dict", items: [
      { key: "Resident", value: "RES" }, { key: "Visitor", value: "VIS" }, { key: "Business", value: "BUS" },
    ] };
    const type = { id: uid("type"), name: "Parking Permit", fields: [
      { id: uid("field"), label: "Name", kind: "string", listId: "", default: "" },
      { id: uid("field"), label: "Address", kind: "string", listId: "", default: "" },
      { id: uid("field"), label: "Permit class", kind: "combo", listId: list.id, default: "" },
    ] };
    return { version: 1, types: [type], lists: [list] };
  }

  function load() {
    const stored = localStorage.getItem(KEY);
    if (stored === null) {
      const initial = seed();
      localStorage.setItem(KEY, JSON.stringify(initial));
      return initial;
    }
    try {
      return sanitize(JSON.parse(stored));
    } catch {
      return sanitize(null);
    }
  }

  function save(config) {
    localStorage.setItem(KEY, JSON.stringify(sanitize(config)));
    window.dispatchEvent(new CustomEvent("scanner:config"));
  }

  function parse(text) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || (!Array.isArray(raw.types) && !Array.isArray(raw.lists))) {
      throw new Error("This file is not a Scanner configuration.");
    }
    return sanitize(raw);
  }

  // Same ids are merged: list items are unioned, imported names/fields win on conflict.
  function merge(base, incoming) {
    const result = sanitize(base);
    const extra = sanitize(incoming);
    for (const list of extra.lists) {
      const existing = result.lists.find((candidate) => candidate.id === list.id);
      if (!existing) result.lists.push(list);
      else if (existing.kind !== list.kind) Object.assign(existing, list);
      else {
        existing.name = list.name;
        if (list.kind === "list") existing.items = [...new Set([...existing.items, ...list.items])];
        else {
          const byKey = new Map(existing.items.map((item) => [item.key, item]));
          for (const item of list.items) byKey.set(item.key, item);
          existing.items = [...byKey.values()];
        }
      }
    }
    for (const type of extra.types) {
      const existing = result.types.find((candidate) => candidate.id === type.id);
      if (!existing) result.types.push(type);
      else {
        existing.name = type.name;
        for (const field of type.fields) {
          const index = existing.fields.findIndex((candidate) => candidate.id === field.id);
          if (index < 0) existing.fields.push(field);
          else existing.fields[index] = field;
        }
      }
    }
    return result;
  }

  // Dictionary lists display the key and store the value.
  function options(config, listId) {
    const list = config.lists.find((candidate) => candidate.id === listId);
    if (!list) return null;
    return list.kind === "dict"
      ? list.items.map((item) => ({ label: item.key, value: item.value }))
      : list.items.map((item) => ({ label: item, value: item }));
  }

  return { KEY, load, merge, options, parse, save, uid };
})();
