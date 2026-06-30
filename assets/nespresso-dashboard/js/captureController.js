// captureController.js
//
// Drives a single <video> element to play back a multi-video CAPTURE as if
// it were one continuous timeline. The pipeline produces session JSONs whose
// `sequence` items carry unified-timeline timestamps and a `videos` array
// describing each video's offset and duration on that timeline. This
// controller maps between unified time and which underlying video file
// should be loaded at any moment.
//
// Public API:
//   makeCaptureController(videoEl, videos, options) → {
//     load(videos)              — replace the videos list (when switching session)
//     seekUnified(unifiedTime)  — seek to a unified-timeline timestamp
//     getUnifiedTime()          — current playback time on unified timeline
//     getCurrentVideoId()       — video_id of currently loaded file (or null)
//     destroy()
//   }
//
// `videos` is the session JSON's `videos` array:
//   [{ video_id, video_path, offset_s, duration_s }, ...]
//
// Notes:
//   - For single-video captures (most of the dataset), this is a thin
//     wrapper: layout has one entry with offset_s=0, no source switching
//     ever happens, getUnifiedTime() returns videoEl.currentTime.
//   - For multi-video captures, when the user seeks past a video boundary
//     or playback reaches the end of one video, the controller swaps the
//     <video> element's `src` and seeks within the new file.

export function makeCaptureController(videoEl, videos, options = {}) {
  const autoAdvance = options.autoAdvance !== false; // default true
  const onVideoChange = options.onVideoChange || (() => {});

  let layout = Array.isArray(videos) ? videos.slice() : [];
  let currentIndex = -1;          // index into layout
  let pendingSeek = null;         // within-video time queued for next loadedmetadata

  function findVideoForUnified(unifiedTime) {
    for (let i = 0; i < layout.length; i++) {
      const v = layout[i];
      if (unifiedTime < v.offset_s + v.duration_s) return i;
    }
    return layout.length > 0 ? layout.length - 1 : -1;
  }

  function applyPendingSeek() {
    if (pendingSeek === null) return;
    videoEl.currentTime = pendingSeek;
    pendingSeek = null;
  }

  function onLoadedMetadata() {
    applyPendingSeek();
  }

  function loadVideoAt(index, withinVideoTime, autoplay) {
    if (index < 0 || index >= layout.length) return;
    const v = layout[index];
    const switching = currentIndex !== index;
    if (switching) {
      currentIndex = index;
      videoEl.src = v.video_path;
      onVideoChange(v);
    }
    // Queue the seek; if metadata is already loaded apply it now.
    // Using a single pendingSeek means later calls overwrite earlier ones
    // — correct when load() and seekUnified() arrive in quick succession.
    pendingSeek = withinVideoTime;
    if (!switching && videoEl.readyState >= 1) {
      applyPendingSeek();
    }
    if (autoplay) {
      const p = videoEl.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  }

  function seekUnified(unifiedTime) {
    if (layout.length === 0) return;
    const idx = findVideoForUnified(unifiedTime);
    const within = Math.max(0, unifiedTime - layout[idx].offset_s);
    const wasPlaying = !videoEl.paused;
    loadVideoAt(idx, within, wasPlaying);
  }

  function getUnifiedTime() {
    if (currentIndex < 0) return 0;
    return layout[currentIndex].offset_s + (videoEl.currentTime || 0);
  }

  function getCurrentVideoId() {
    if (currentIndex < 0) return null;
    return layout[currentIndex].video_id;
  }

  function load(newVideos) {
    layout = Array.isArray(newVideos) ? newVideos.slice() : [];
    currentIndex = -1;
    pendingSeek = null;
    if (layout.length > 0) loadVideoAt(0, 0, false);
  }

  function onEnded() {
    if (!autoAdvance) return;
    if (currentIndex + 1 < layout.length) {
      loadVideoAt(currentIndex + 1, 0, true);
    }
  }

  videoEl.addEventListener("loadedmetadata", onLoadedMetadata);
  videoEl.addEventListener("ended", onEnded);

  if (layout.length > 0) loadVideoAt(0, 0, false);

  function destroy() {
    videoEl.removeEventListener("loadedmetadata", onLoadedMetadata);
    videoEl.removeEventListener("ended", onEnded);
    videoEl.removeAttribute("src");
    videoEl.load();
    layout = [];
    currentIndex = -1;
    pendingSeek = null;
  }

  return {
    load,
    seekUnified,
    getUnifiedTime,
    getCurrentVideoId,
    destroy,
  };
}