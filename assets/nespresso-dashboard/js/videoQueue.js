// videoQueue.js
//
// Manages the main <video> element + N-1 thumbnail queue items in comparison
// mode. Clicking a thumbnail swaps which session is the active video.
//
// Thumbnails are static <video preload=metadata> with poster behavior — we
// load metadata only (not the full stream) so memory stays bounded.
//
// Public API:
//   buildVideoQueue(mainVideoEl, queueContainerEl, sessions, options) → {
//     setActiveSession(sessionIndex),
//     getActiveSession(),
//   }

export function buildVideoQueue(mainVideoEl, queueContainerEl, sessions, options = {}) {
  const onActiveChange = options.onActiveChange || (() => {});
  let activeSessionIndex = sessions[0].index;

  queueContainerEl.innerHTML = "";
  const thumbElements = {}; // sessionIndex → wrapper

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
        vid.src = session.video_path;
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
        thumbElements[session.index] = wrap;
      });
  }

  function setActiveSession(sessionIndex) {
    if (sessionIndex === activeSessionIndex) return;
    const session = sessions.find((s) => s.index === sessionIndex);
    if (!session) return;

    activeSessionIndex = sessionIndex;
    mainVideoEl.src = session.video_path;
    mainVideoEl.currentTime = 0;
    renderQueue();
    onActiveChange(sessionIndex);
  }

  function getActiveSession() {
    return sessions.find((s) => s.index === activeSessionIndex);
  }

  // Initialize: load first session into main video
  const firstSession = sessions[0];
  mainVideoEl.src = firstSession.video_path;
  mainVideoEl.currentTime = 0;
  renderQueue();

  return { setActiveSession, getActiveSession };
}