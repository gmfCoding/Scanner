/* Self-contained colour picker; the returned button emits `input` while editing and `change` when committed. */
function createColorPicker(initial = "#000000") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "color-swatch";

  let hex = "#000000";
  let hsv = { h: 0, s: 0, v: 0 };
  let popover = null;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function hexToRgb(text) {
    const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
    if (!match) return null;
    const number = parseInt(match[1], 16);
    return { r: number >> 16, g: (number >> 8) & 255, b: number & 255 };
  }

  function rgbToHex({ r, g, b }) {
    return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
  }

  function rgbToHsv({ r, g, b }) {
    const [red, green, blue] = [r / 255, g / 255, b / 255];
    const max = Math.max(red, green, blue);
    const delta = max - Math.min(red, green, blue);
    let h = 0;
    if (delta) {
      if (max === red) h = ((green - blue) / delta) % 6;
      else if (max === green) h = (blue - red) / delta + 2;
      else h = (red - green) / delta + 4;
    }
    return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
  }

  function hsvToRgb({ h, s, v }) {
    const channel = (offset) => {
      const k = (offset + h / 60) % 6;
      return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
    };
    return { r: channel(5), g: channel(3), b: channel(1) };
  }

  function paintSwatch() {
    button.style.background = hex;
    button.title = hex;
  }

  function setHex(next, updateHsv = true) {
    hex = next.toLowerCase();
    if (updateHsv) hsv = rgbToHsv(hexToRgb(hex));
    paintSwatch();
  }

  Object.defineProperty(button, "value", {
    get: () => hex,
    set: (next) => {
      if (!hexToRgb(String(next))) return;
      setHex(String(next).startsWith("#") ? String(next) : `#${next}`);
      popover?.refresh();
    },
  });

  const emit = (name) => button.dispatchEvent(new Event(name, { bubbles: true }));

  function closePopover() {
    if (!popover) return;
    popover.element.remove();
    document.removeEventListener("pointerdown", popover.outside, true);
    document.removeEventListener("keydown", popover.escape, true);
    popover = null;
    emit("change");
  }

  function openPopover() {
    const element = document.createElement("div");
    element.className = "color-popover";

    const plane = document.createElement("canvas");
    plane.width = 200;
    plane.height = 140;
    plane.className = "color-plane";

    const hue = document.createElement("input");
    hue.type = "range";
    hue.min = "0";
    hue.max = "360";
    hue.className = "color-hue";

    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.maxLength = 7;
    hexInput.spellcheck = false;

    const presets = document.createElement("div");
    presets.className = "color-presets";

    const row = document.createElement("div");
    row.className = "color-row";
    row.append(hexInput);

    function drawPlane() {
      const context = plane.getContext("2d");
      context.fillStyle = rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
      context.fillRect(0, 0, plane.width, plane.height);
      const white = context.createLinearGradient(0, 0, plane.width, 0);
      white.addColorStop(0, "#fff");
      white.addColorStop(1, "#fff0");
      context.fillStyle = white;
      context.fillRect(0, 0, plane.width, plane.height);
      const black = context.createLinearGradient(0, 0, 0, plane.height);
      black.addColorStop(0, "#0000");
      black.addColorStop(1, "#000");
      context.fillStyle = black;
      context.fillRect(0, 0, plane.width, plane.height);
      const x = hsv.s * plane.width;
      const y = (1 - hsv.v) * plane.height;
      context.strokeStyle = hsv.v > 0.5 && hsv.s < 0.5 ? "#000" : "#fff";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y, 6, 0, Math.PI * 2);
      context.stroke();
    }

    function refresh() {
      drawPlane();
      hue.value = String(Math.round(hsv.h));
      if (document.activeElement !== hexInput) hexInput.value = hex;
    }

    function applyHsv() {
      setHex(rgbToHex(hsvToRgb(hsv)), false);
      refresh();
      emit("input");
    }

    function pickFromPlane(event) {
      const rect = plane.getBoundingClientRect();
      hsv.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      hsv.v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
      applyHsv();
    }

    plane.addEventListener("pointerdown", (event) => {
      plane.setPointerCapture(event.pointerId);
      pickFromPlane(event);
    });
    plane.addEventListener("pointermove", (event) => {
      if (plane.hasPointerCapture(event.pointerId)) pickFromPlane(event);
    });
    hue.addEventListener("input", () => { hsv.h = Number(hue.value); applyHsv(); });
    hexInput.addEventListener("input", () => {
      const rgb = hexToRgb(hexInput.value);
      if (!rgb) return;
      setHex(rgbToHex(rgb));
      refresh();
      emit("input");
    });
    hexInput.addEventListener("blur", () => { hexInput.value = hex; });

    for (const preset of ["#000000", "#ffffff", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#6b7280"]) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "color-swatch is-small";
      swatch.style.background = preset;
      swatch.title = preset;
      swatch.addEventListener("click", () => { setHex(preset); refresh(); emit("input"); });
      presets.append(swatch);
    }

    if ("EyeDropper" in window) {
      const eyedropper = document.createElement("button");
      eyedropper.type = "button";
      eyedropper.className = "button";
      eyedropper.textContent = "Pick";
      eyedropper.addEventListener("click", async () => {
        try {
          const { sRGBHex } = await new window.EyeDropper().open();
          setHex(sRGBHex);
          refresh();
          emit("input");
        } catch {
          // Cancelled by the user.
        }
      });
      row.append(eyedropper);
    }

    element.append(plane, hue, row, presets);
    document.body.append(element);
    const rect = button.getBoundingClientRect();
    element.style.left = `${clamp(rect.left, 4, window.innerWidth - element.offsetWidth - 4)}px`;
    element.style.top = `${clamp(rect.bottom + 4, 4, window.innerHeight - element.offsetHeight - 4)}px`;

    popover = {
      element,
      refresh,
      outside: (event) => { if (!element.contains(event.target) && !button.contains(event.target)) closePopover(); },
      escape: (event) => { if (event.key === "Escape") { event.stopPropagation(); closePopover(); } },
    };
    document.addEventListener("pointerdown", popover.outside, true);
    document.addEventListener("keydown", popover.escape, true);
    refresh();
  }

  button.addEventListener("click", () => (popover ? closePopover() : openPopover()));
  button.value = initial;
  return button;
}
