if (!globalThis.__quickSpeedLoaded) {
  globalThis.__quickSpeedLoaded = true;

  const DEFAULT_SPEED = 1.5;
  const DEFAULT_STEP = 0.25;
  let defaultSpeed = DEFAULT_SPEED;
  let step = DEFAULT_STEP;
  let videos = [];

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

  function cleanupIfEmpty() {
    let writeIndex = 0;
    for (const video of videos) {
      if (video.isConnected) {
        videos[writeIndex] = video;
        writeIndex += 1;
      }
    }
    videos.length = writeIndex;

    if (videos.length === 0) {
      document.removeEventListener('keydown', handleKeydown);
      globalThis.__quickSpeedLoaded = false;
      return true;
    }
    return false;
  }

  function handleKeydown(e) {
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const key = e.key.toLowerCase();
    if (key !== 's' && key !== 'd' && key !== 'r') return;

    if (cleanupIfEmpty()) return;

    for (const video of videos) {
      if (key === 's') {
        video.playbackRate = Math.max(0.1, video.playbackRate - step);
      } else if (key === 'd') {
        video.playbackRate = Math.min(16.0, video.playbackRate + step);
      } else {
        video.playbackRate = 1.0;
      }
    }
  }

  if (!collectVideos()) {
    globalThis.__quickSpeedLoaded = false;
  } else {
    chrome.storage.sync.get(['defaultSpeed', 'step'], result => {
      if (result.defaultSpeed !== undefined) defaultSpeed = parseFloat(result.defaultSpeed);
      if (result.step !== undefined) step = parseFloat(result.step);
      applyDefaultSpeed();
      document.addEventListener('keydown', handleKeydown);
    });
  }
}
