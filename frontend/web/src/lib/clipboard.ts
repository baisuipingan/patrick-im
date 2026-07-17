export async function copyImageToClipboard(url: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('image clipboard is not supported');
  }
  const pngBlob = imageClipboardBlob(url);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
  } catch {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await pngBlob })]);
  }
}

async function imageClipboardBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('image fetch failed');
  }
  const blob = await response.blob();
  if (blob.type.toLowerCase() === 'image/png') {
    return blob;
  }
  return imageBlobToPng(blob);
}

async function imageBlobToPng(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try {
      return canvasToPngBlob(bitmap.width, bitmap.height, (context) => {
        context.drawImage(bitmap, 0, 0);
      });
    } finally {
      bitmap.close();
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(objectUrl);
    return canvasToPngBlob(image.naturalWidth || image.width, image.naturalHeight || image.height, (context) => {
      context.drawImage(image, 0, 0);
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canvasToPngBlob(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return Promise.reject(new Error('canvas is not available'));
  }
  draw(context);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('image conversion failed'));
      }
    }, 'image/png');
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = url;
  });
}
