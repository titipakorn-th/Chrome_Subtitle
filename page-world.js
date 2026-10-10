// Runs in the page's main world, the only place that can read the player's JS state.
// Answers a request from the isolated content script with the caption tracks.
window.addEventListener('lr-request-tracks', () => {
  const player = document.getElementById('movie_player');
  let payload = { videoId: '', tracks: [] };
  try {
    const response = player.getPlayerResponse();
    payload = {
      videoId: response.videoDetails.videoId,
      tracks: response.captions.playerCaptionsTracklistRenderer.captionTracks || [],
    };
  } catch (e) {
    // Player not ready yet. The content script retries.
  }
  window.dispatchEvent(new CustomEvent('lr-tracks', { detail: JSON.stringify(payload) }));
});
