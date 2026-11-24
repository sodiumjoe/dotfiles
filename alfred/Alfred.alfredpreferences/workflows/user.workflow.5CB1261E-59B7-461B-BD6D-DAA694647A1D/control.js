async function controlPage(command) {
  const video = document.querySelector("video");
  const player = document.querySelector("ytmusic-player-bar");
  if (!video || !player) {
    throw new Error("Start a track in YouTube Music first.");
  }
  const title = (player.querySelector(".title")?.textContent || "").trim();
  switch (command) {
    case "play":
      await video.play();
      return "Playing";
    case "pause":
      video.pause();
      return "Paused";
    case "toggle":
      if (video.paused) {
        await video.play();
        return "Playing";
      }
      video.pause();
      return "Paused";
    case "next":
    case "prev": {
      const selector = command === "next" ? ".next-button" : ".previous-button";
      const button = player.querySelector(selector);
      if (
        !button ||
        button.hasAttribute("disabled") ||
        button.getAttribute("aria-disabled") === "true" ||
        button.querySelector("button")?.disabled
      ) {
        throw new Error(
          command === "next" ? "No next track is available." : "No previous track is available.",
        );
      }
      button.click();
      return command === "next" ? "Skipped to the next track" : "Selected the previous track";
    }
    case "status":
      return `${video.paused ? "Paused" : "Playing"}${title ? `: ${title}` : ""}`;
  }
}

function run(argv) {
  const command = argv[0] || "toggle";
  if (!["play", "pause", "toggle", "next", "prev", "status"].includes(command)) {
    return "Unknown command. Use play, pause, next, prev, toggle, or status.";
  }
  const chrome = Application("Google Chrome");
  if (!chrome.running()) {
    return "Open YouTube Music in Chrome first.";
  }
  try {
    const urls = chrome.windows.tabs.url();
    for (let w = 0; w < urls.length; w++) {
      for (let t = 0; t < urls[w].length; t++) {
        if (!/^https:\/\/music\.youtube\.com(?:\/|$)/.test(urls[w][t])) {
          continue;
        }
        const tab = chrome.windows[w].tabs[t];
        const key = JSON.stringify(`__moonYtControl_${Date.now()}_${Math.random().toString(36).slice(2)}`);
        tab.execute({
          javascript: `(${controlPage.toString()})(${JSON.stringify(command)}).then(message => window[${key}] = JSON.stringify({message}), error => window[${key}] = JSON.stringify({error: error.message})); undefined;`,
        });
        for (let attempt = 0; attempt < 50; attempt++) {
          const result = tab.execute({
            javascript: `(() => { const result = window[${key}]; if (result) delete window[${key}]; return result || ''; })()`,
          });
          if (result) {
            const response = JSON.parse(result);
            return response.error ? `Could not control YouTube Music: ${response.error}` : response.message;
          }
          delay(0.1);
        }
        tab.execute({ javascript: `delete window[${key}]; undefined;` });
        return "YouTube Music did not respond. Check that a track is loaded.";
      }
    }
    return "Open YouTube Music in Chrome first.";
  } catch (error) {
    const message = error.message || String(error);
    if (/JavaScript through AppleScript|Apple Events/i.test(message)) {
      return "Enable View > Developer > Allow JavaScript from Apple Events in the Chrome profile used by YouTube Music.";
    }
    return `Could not control YouTube Music: ${message}`;
  }
}