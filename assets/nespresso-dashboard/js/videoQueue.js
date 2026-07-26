// videoQueue.js
//
// Renders N-1 thumbnail queue items in comparison mode. Clicking a thumbnail
// fires onActiveChange(sessionIndex). The caller is responsible for driving
// the actual <video> element (via captureController) — this module just
// handles thumbnail rendering and which session is "active."
//
// Thumbnails are static <video preload=metadata> elements showing the first
// video of each capture (sessions are captures; multi-video captures pick
// their first video for the thumbnail).
//
// Public API:
//   buildVideoQueue(queueContainerEl, sessions, options) → {
//     setActiveSession(sessionIndex),
//     getActiveSession(),
//   }
//
//   sessions: [{ index, videos: [{video_id, video_path, ...}, ...], ... }, ...]

export function buildVideoQueue(queueContainerEl, sessions, options = {}) {
  const onActiveChange = options.onActiveChange || (() => {});
  let activeSessionIndex = sessions[0].index;

  queueContainerEl.innerHTML = "";

  function getThumbSrc(session) {
    // Each session has a `videos` array; thumbnail = first video.
    if (session.videos && session.videos.length > 0) {
      return session.videos[0].video_path;
    }
    return session.video_path; // back-compat fallback
  }

  function renderQueue() {
    queueContainerEl.innerHTML = "";
    sessions
      .filter((s) => s.index !== activeSessionIndex)
      .forEach((session) => {
        const wrap = document.createElement("div");
        wrap.className = "video-queue-thumb";
        wrap.dataset.sessionIndex = String(session.index);
        wrap.title = `Session ${session.index + 1} — click to switch`;

        const vid = document.createElement("video");
        vid.src = getThumbSrc(session);
        vid.preload = "metadata";
        vid.muted = true;
        vid.playsInline = true;
        wrap.appendChild(vid);

        const label = document.createElement("div");
        label.className = "video-queue-label";
        label.textContent = `Session ${session.index + 1}`;
        wrap.appendChild(label);

        wrap.addEventListener("click", () => {
          setActiveSession(session.index);
        });

        queueContainerEl.appendChild(wrap);
      });
  }

  function setActiveSession(sessionIndex) {
    if (sessionIndex === activeSessionIndex) return;
    const session = sessions.find((s) => s.index === sessionIndex);
    if (!session) return;
    activeSessionIndex = sessionIndex;
    renderQueue();
    onActiveChange(sessionIndex);
  }

  function getActiveSession() {
    return sessions.find((s) => s.index === activeSessionIndex);
  }

  renderQueue();

  return { setActiveSession, getActiveSession };
}