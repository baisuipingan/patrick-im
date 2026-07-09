export const TEXT_ATTACHMENT_THRESHOLD_BYTES = 200 * 1024;

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function shouldSendTextAsAttachment(value: string): boolean {
  return byteLength(value) > TEXT_ATTACHMENT_THRESHOLD_BYTES;
}

export function createTextAttachmentFile(value: string, now = new Date()): File {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  return new File([value], `message-${stamp}.txt`, {
    type: 'text/plain;charset=utf-8',
  });
}

export function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/');
}
