import { formatSeconds } from "./utils.js";

export function drawTimeline(timelineBodyEl, sequence) {
  timelineBodyEl.innerHTML = "";

  return sequence.map((item) => {
    const tr = document.createElement("tr");
    tr.dataset.index = String(item.index);
    tr.innerHTML =
      `<td>${item.index + 1}</td>` +
      `<td title="${item.action}">${item.action}</td>` +
      `<td>${formatSeconds(item.start)}</td>` +
      `<td>${formatSeconds(item.end)}</td>` +
      `<td>${formatSeconds(item.duration)}</td>`;
    timelineBodyEl.appendChild(tr);
    return tr;
  });
}

function scrollTimelineToRow(footerPanelEl, rowEl) {
  const rowTop = rowEl.offsetTop;
  const rowHeight = rowEl.offsetHeight;
  const panelHeight = footerPanelEl.clientHeight;
  footerPanelEl.scrollTop = rowTop - (panelHeight - rowHeight) / 2;
}

export function updateTimelineActive(timelineRows, footerPanelEl, activeItem) {
  timelineRows.forEach((rowEl) => {
    const isActive = activeItem && Number(rowEl.dataset.index) === activeItem.index;
    rowEl.classList.toggle("active", Boolean(isActive));
    if (isActive) {
      scrollTimelineToRow(footerPanelEl, rowEl);
    }
  });
}
