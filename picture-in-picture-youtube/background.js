// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ["script.js"],
  });
});

chrome.runtime.onInstalled.addListener(disableAutomaticPictureInPicture);
chrome.runtime.onStartup.addListener(disableAutomaticPictureInPicture);

async function disableAutomaticPictureInPicture() {
  chrome.action.setBadgeBackgroundColor({ color: "#4285F4" });
  chrome.action.setBadgeTextColor({ color: "#fff" });
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({ title: "Picture-in-Picture" });
  await chrome.scripting.unregisterContentScripts({ ids: ["autoPip"] }).catch(() => {});
}
