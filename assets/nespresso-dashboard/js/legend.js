export function buildLegend(legendStripEl, legendItems) {
  legendStripEl.innerHTML = "";
  const groups = Array.isArray(legendItems)
    ? { edge: legendItems }
    : legendItems;

  function createLegendItem(item) {
    const el = document.createElement("div");
    el.className = "legend-item";

    if (item.type === "dot") {
      el.innerHTML =
        `<div class="legend-dot" style="background:${item.color}"></div>` +
        `<span>${item.label}</span>`;
    } else if (item.type === "line") {
      el.innerHTML =
        `<div class="legend-line${item.dashed ? " dashed" : ""}"></div>` +
        `<span>${item.label}</span>`;
    } else if (item.type === "badge1") {
      el.innerHTML =
        `<div class="legend-badge">1</div>` +
        `<span>${item.label}</span>`;
    } else if (item.type === "badge") {
      el.innerHTML =
        `<div class="legend-badge"></div>` +
        `<span>${item.label}</span>`;
    } else if (item.type === "ring") {
      el.innerHTML =
        `<div class="legend-ring">⟳</div>` +
        `<span>${item.label}</span>`;
    } else if (item.type === "arrow") {
      el.innerHTML =
        `<div class="legend-arrow">↔</div>` +
        `<span>${item.label}</span>`;
    } else if (item.type === "label") {
      el.innerHTML =
        `<div class="legend-label-sample">Aa</div>` +
        `<span>${item.label}</span>`;
    }

    return el;
  }

  Object.entries(groups).forEach(([groupName, items]) => {
    const section = document.createElement("div");
    section.className = "legend-section";

    const title = document.createElement("div");
    title.className = "legend-section-title";
    title.textContent = groupName === "node" ? "Node" : "Edge";
    section.appendChild(title);

    const list = document.createElement("div");
    list.className = "legend-section-items";

    if (groupName === "node") {
      const colorItems = items.filter((item) => item.type === "dot");
      const annotationItems = items.filter((item) => item.type !== "dot");

      const colorGrid = document.createElement("div");
      colorGrid.className = "legend-node-colors-grid";
      colorItems.forEach((item) => colorGrid.appendChild(createLegendItem(item)));

      const annotationGrid = document.createElement("div");
      annotationGrid.className = "legend-node-annotations-grid";
      annotationItems.forEach((item) => annotationGrid.appendChild(createLegendItem(item)));

      list.appendChild(colorGrid);
      list.appendChild(annotationGrid);
    } else {
      items.forEach((item) => {
        list.appendChild(createLegendItem(item));
      });
    }

    section.appendChild(list);
    legendStripEl.appendChild(section);
  });
}
