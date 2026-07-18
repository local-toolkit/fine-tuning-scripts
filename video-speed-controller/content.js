if (!globalThis.__quickSpeedLoaded) {
  globalThis.__quickSpeedLoaded = true;

  const DEFAULT_SPEED = 1.3;
  const DEFAULT_STEP = 0.1;
  let defaultSpeed = DEFAULT_SPEED;
  let step = DEFAULT_STEP;
  let videos = [];
  let overlay = null;
  let overlayHost = null;
  let overlayTimer = null;
  const handledEvents = new WeakSet();

  function getOverlayHost() {
    const fullscreenElement = document.fullscreenElement;
    if (fullscreenElement && fullscreenElement.tagName !== 'VIDEO') {
      return fullscreenElement;
    }
    return document.body || document.documentElement;
  }

  function ensureOverlay() {
    const host = getOverlayHost();
    if (overlay?.isConnected && overlayHost === host) return overlay;

    if (overlay?.isConnected) {
      overlay.remove();
    }

    overlayHost = host;
    overlay = document.createElement('div');
    overlay.setAttribute('aria-live', 'polite');
    overlay.id = 'quick-speed-overlay';
    overlay.style.all = 'initial';
    overlay.style.position = 'fixed';
    overlay.style.top = '24px';
    overlay.style.left = '24px';
    overlay.style.zIndex = '2147483647';
    overlay.style.padding = '10px 14px';
    overlay.style.borderRadius = '8px';
    overlay.style.background = 'rgba(128, 128, 128, 0.55)';
    overlay.style.color = '#fff';
    overlay.style.font = '600 18px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    overlay.style.boxShadow = '0 8px 28px rgba(0, 0, 0, 0.35)';
    overlay.style.pointerEvents = 'none';
    overlay.style.opacity = '0';
    overlay.style.transform = 'translateY(-8px)';
    overlay.style.transition = 'opacity 120ms ease, transform 120ms ease';
    overlay.style.userSelect = 'none';

    overlayHost.appendChild(overlay);
    return overlay;
  }

  function formatSpeed(speed) {
    return `${speed.toFixed(2).replace(/\.?0+$/, '')}x`;
  }

  function showOverlay(text) {
    const speedOverlay = ensureOverlay();
    speedOverlay.textContent = text;
    speedOverlay.style.opacity = '1';
    speedOverlay.style.transform = 'translateY(0)';

    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      speedOverlay.style.opacity = '0';
      speedOverlay.style.transform = 'translateY(-8px)';
    }, 900);
  }

  function showSpeed(speed) {
    showOverlay(formatSpeed(speed));
  }

  function collectVideos() {
    videos = [];
    for (const video of document.querySelectorAll('video')) {
      if (video.isConnected) {
        videos.push(video);
      }
    }
    return videos.length > 0;
  }

  function applyDefaultSpeed() {
    for (const video of videos) {
      if (Math.abs(video.playbackRate - 1.0) < 0.1) {
        video.playbackRate = defaultSpeed;
      }
    }
  }

  function pruneVideos() {
    let writeIndex = 0;
    for (const video of videos) {
      if (video.isConnected) {
        videos[writeIndex] = video;
        writeIndex += 1;
      }
    }
    videos.length = writeIndex;
  }

  function handleKeydown(e) {
    if (handledEvents.has(e)) return;
    handledEvents.add(e);

    const target = e.target;
    if (target instanceof Element && (target.matches('input, textarea, select') || target.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = String(e.key || '').toLowerCase();
    if (key !== 's' && key !== 'd' && key !== 'r') return;

    collectVideos();
    pruneVideos();
    if (videos.length === 0) return;

    let currentSpeed = 1.0;
    for (const video of videos) {
      if (key === 's') {
        video.playbackRate = Math.max(0.1, video.playbackRate - step);
      } else if (key === 'd') {
        video.playbackRate = Math.min(16.0, video.playbackRate + step);
      } else {
        video.playbackRate = 1.0;
      }
      currentSpeed = video.playbackRate;
    }
    showSpeed(currentSpeed);
  }

  function showCurrentSpeed() {
    collectVideos();
    pruneVideos();

    if (videos.length === 0) {
      showOverlay('No video');
      return;
    }

    showSpeed(videos[videos.length - 1].playbackRate);
  }

  // Register the receiver synchronously. The popup may inject this script and
  // send `quickSpeedShow` immediately; waiting for storage.sync.get() first
  // creates a race where Chrome has no message receiver yet.
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'quickSpeedShow') {
      showCurrentSpeed();
    }
  });

  function handleMutations() {
    if (!collectVideos()) return;
    applyDefaultSpeed();
  }

  chrome.storage.sync.get(['defaultSpeed', 'step'], result => {
    if (result.defaultSpeed !== undefined) defaultSpeed = parseFloat(result.defaultSpeed);
    if (result.step !== undefined) step = parseFloat(result.step);

    if (collectVideos()) {
      applyDefaultSpeed();
      showSpeed(videos[videos.length - 1].playbackRate);
    }

    window.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('fullscreenchange', showCurrentSpeed);

    const observer = new MutationObserver(handleMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}
