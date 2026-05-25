(() => {
  const api = window.aiosOverlay;
  const screenshotEl = document.getElementById('screenshot');
  const dimEl = document.getElementById('dim');
  const marqueeEl = document.getElementById('marquee');
  const sizeTagEl = document.getElementById('size-tag');

  let nativeImageDataUrl = null;
  let imgWidth = 0;
  let imgHeight = 0;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;

  api.getScreenSource().then(({ dataUrl, width, height }) => {
    nativeImageDataUrl = dataUrl;
    imgWidth = width;
    imgHeight = height;
    screenshotEl.src = dataUrl;
    dimEl.style.display = 'block';
  }).catch(err => {
    console.error('Failed to get screen source:', err);
    api.cancel();
  });

  function updateMarquee() {
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    marqueeEl.style.display = 'block';
    marqueeEl.style.left = x + 'px';
    marqueeEl.style.top = y + 'px';
    marqueeEl.style.width = w + 'px';
    marqueeEl.style.height = h + 'px';
    sizeTagEl.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  }

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    curX = e.clientX;
    curY = e.clientY;
    updateMarquee();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    curX = e.clientX;
    curY = e.clientY;
    updateMarquee();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    if (w < 5 || h < 5 || !nativeImageDataUrl) {
      api.cancel();
      return;
    }
    cropAndSend(x, y, w, h);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.cancel();
  });

  function cropAndSend(cssX, cssY, cssW, cssH) {
    const img = new Image();
    img.onload = () => {
      const scaleX = img.naturalWidth / window.innerWidth;
      const scaleY = img.naturalHeight / window.innerHeight;
      const sx = Math.round(cssX * scaleX);
      const sy = Math.round(cssY * scaleY);
      const sw = Math.max(1, Math.round(cssW * scaleX));
      const sh = Math.max(1, Math.round(cssH * scaleY));
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const dataUrl = canvas.toDataURL('image/png');
      api.submit(dataUrl);
    };
    img.onerror = () => api.cancel();
    img.src = nativeImageDataUrl;
  }
})();
