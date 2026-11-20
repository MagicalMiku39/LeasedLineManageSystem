export const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// The file's bytes as base64, read straight from the Blob: no temporary link to fetch back.
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * Saves a file made in the page. Inside the Android app the bytes go straight to the app's own
 * bridge (LedgerApp.saveBase64, there since the app's first versions), which stores them under
 * 下载/专线台账; nothing has to be read back from a temporary link. In a browser the file is
 * offered as an ordinary download.
 */
export async function saveFile(blob, fileName, host = globalThis) {
  const app = host.LedgerApp;
  if (app && typeof app.saveBase64 === 'function') {
    app.saveBase64(fileName, blob.type || '', await blobToBase64(blob));
    return 'app';
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'browser';
}

/** An Excel workbook built in the page (SheetJS), saved the same way. */
export function saveWorkbook(XLSX, book, fileName, host = globalThis) {
  const data = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  return saveFile(new Blob([data], { type: xlsxType }), fileName, host);
}
