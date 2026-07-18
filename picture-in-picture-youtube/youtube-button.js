// Copyright 2026
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

(() => {
  if (globalThis.__youtubePipButtonLoaded) {
    return;
  }
  globalThis.__youtubePipButtonLoaded = true;

  const BUTTON_ID = "local-youtube-pip-button";
  const BUTTON_TITLE = "Picture-in-Picture";
  const FALLBACK_BUTTON_ID = "local-youtube-pip-fallback-button";
  const PAGE_BUTTON_ID = "local-youtube-pip-page-button";

  function findLargestVideo() {
    return Array.from(document.querySelectorAll("video"))
      .filter((video) => video.readyState !== 0)
      .filter((video) => video.disablePictureInPicture === false)
      .sort((a, b) => {
        const aRect = a.getClientRects()[0] || { width: 0, height: 0 };
        const bRect = b.getClientRects()[0] || { width: 0, height: 0 };
        return bRect.width * bRect.height - aRect.width * aRect.height;
      })[0];
  }

  async function togglePictureInPicture() {
    const video = findLargestVideo();
    if (!video) {
      return;
    }

    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      return;
    }

    await video.requestPictureInPicture();
  }

  function setButtonState(button) {
    const active = Boolean(document.pictureInPictureElement);
    button.classList.toggle("local-youtube-pip-button-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  function updateAllButtonStates() {
    for (const button of document.querySelectorAll(".local-youtube-pip-button")) {
      setButtonState(button);
    }
  }

  function createButton(id = BUTTON_ID) {
    const button = document.createElement("button");
    button.id = id;
    button.className = "ytp-button local-youtube-pip-button";
    button.type = "button";
    button.title = BUTTON_TITLE;
    button.setAttribute("aria-label", BUTTON_TITLE);
    button.setAttribute("aria-pressed", "false");
    button.textContent = "PiP";

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      try {
        await togglePictureInPicture();
      } catch (error) {
        console.warn("[YouTube PiP] Unable to toggle Picture-in-Picture:", error);
      } finally {
        updateAllButtonStates();
      }
    });

    return button;
  }

  function injectStyles() {
    if (document.getElementById("local-youtube-pip-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "local-youtube-pip-style";
    style.textContent = `
      .local-youtube-pip-button {
        color: #fff;
        font: 600 13px/1 Roboto, Arial, sans-serif;
        min-width: 44px;
        padding: 0 8px;
      }

      .local-youtube-pip-button-active {
        color: #3ea6ff;
      }

      #${FALLBACK_BUTTON_ID} {
        align-items: center;
        background: rgba(0, 0, 0, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 4px;
        box-sizing: border-box;
        cursor: pointer;
        display: flex;
        height: 32px;
        justify-content: center;
        min-width: 48px;
        padding: 0 10px;
        position: absolute;
        right: 12px;
        top: 12px;
        z-index: 9999;
      }

      #${FALLBACK_BUTTON_ID}:hover {
        background: rgba(32, 32, 32, 0.9);
      }

      #${PAGE_BUTTON_ID} {
        align-items: center;
        background: #0f0f0f;
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 18px;
        bottom: 24px;
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.32);
        box-sizing: border-box;
        color: #fff;
        cursor: pointer;
        display: flex;
        font: 600 13px/1 Roboto, Arial, sans-serif;
        height: 36px;
        justify-content: center;
        min-width: 58px;
        padding: 0 14px;
        position: fixed;
        right: 24px;
        z-index: 2147483647;
      }

      #${PAGE_BUTTON_ID}:hover {
        background: #272727;
      }
    `;
    document.documentElement.append(style);
  }

  function ensureControlsButton() {
    const controls = document.querySelector(".ytp-right-controls");
    if (!controls || !controls.isConnected || document.getElementById(BUTTON_ID)) {
      return false;
    }

    const button = createButton(BUTTON_ID);
    const settingsButton = controls.querySelector(".ytp-settings-button");
    const referenceNode =
      settingsButton?.parentNode === controls ? settingsButton : controls.firstChild;

    // YouTube can rebuild the controls between observer callbacks. Only use a
    // reference node that is still owned by this controls element.
    if (referenceNode?.parentNode === controls) {
      controls.insertBefore(button, referenceNode);
    } else {
      controls.append(button);
    }
    setButtonState(button);
    return true;
  }

  function ensureFallbackButton() {
    const player = document.querySelector(".html5-video-player");
    if (!player || document.getElementById(FALLBACK_BUTTON_ID)) {
      return;
    }

    const button = createButton(FALLBACK_BUTTON_ID);
    player.append(button);
    setButtonState(button);
  }

  function ensurePageButton() {
    if (!findLargestVideo() || document.getElementById(PAGE_BUTTON_ID)) {
      return;
    }

    const button = createButton(PAGE_BUTTON_ID);
    button.className = "local-youtube-pip-button";
    document.body.append(button);
    setButtonState(button);
  }

  function ensureButton() {
    injectStyles();
    ensureControlsButton();
    ensureFallbackButton();
    ensurePageButton();
  }

  ensureButton();

  const observer = new MutationObserver(ensureButton);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("yt-navigate-finish", ensureButton);
  document.addEventListener("enterpictureinpicture", updateAllButtonStates);
  document.addEventListener("leavepictureinpicture", updateAllButtonStates);
  setInterval(ensureButton, 1000);
})();
