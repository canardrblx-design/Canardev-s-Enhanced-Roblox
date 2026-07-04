// Runs in the PAGE's world (see manifest "world": "MAIN"), not the extension's
// isolated world — that's the only place Roblox's own GameLauncher is visible.
// The extension side talks to it with window.postMessage.
// Security: only accepts messages from this same window/origin, and the only
// thing it can do is launch a game — no data flows back.

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  const launcher = window.Roblox && window.Roblox.GameLauncher;
  if (!launcher) return;

  if (msg.cer === "join-instance" && msg.placeId && msg.jobId) {
    launcher.joinGameInstance(Number(msg.placeId), String(msg.jobId));
  } else if (msg.cer === "join-multiplayer" && msg.placeId) {
    launcher.joinMultiplayerGame(Number(msg.placeId));
  }
});
