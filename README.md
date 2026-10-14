# TIFF Layer Editor

A responsive, browser-only TIFF layer editor. Open `index.html` through a local static server, then choose or drop a `.tif`/`.tiff` file.

## Features

- Decodes multi-page TIFF files and shows a thumbnail hierarchy with a full selected-layer preview.
- Uses **Ctrl/Cmd + click** to toggle layers in a multi-selection; clicking a layer normally selects only it, and the **×** control clears the selection.
- Reorders layers and containers by dragging: a ghost preview follows the cursor and a highlighted line shows the drop position. Move controls, duplicate and delete also work on the selection.
- Containers replace visible separators: layers live inside a container, and on export each container becomes a black separator page (its type and field values are stored in the page's ImageDescription tag and restored on import). Existing nearly black pages become containers on import.
- Containers have a type; the **Admin** view (`#/admin`, same page, so the loaded TIFF stays in memory) defines types with fields (any string or combo list) and data lists (lists or key/value dictionaries; dictionary combos show the key and store the value). Right-click a combo field to override or revert it.
- Configuration is kept in `localStorage` and can be exported, imported (replace) or merged as JSON.
- Yields between page decodes so large multi-page files do not monopolize the main thread.

The app uses vanilla HTML, CSS, and JavaScript. TIFF decoding is provided by the browser-loaded [UTIF](https://github.com/photopea/UTIF.js) codec; no build step is required.