import createQr from 'qrcode-generator';

/**
 * The dark modules of a QR code as one SVG path, in module units (no quiet
 * zone). The app draws it with react-native-svg and PDFs inline it, so both
 * show the same code.
 */
export function qrPath(text: string): { size: number; d: string } {
  // Level M survives a crease or a smudge on a printed page.
  const qr = createQr(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  return { size, d };
}

/** A standalone SVG for HTML documents, with the 4-module quiet zone scanners expect. */
export function qrSvg(text: string, px: number): string {
  const { size, d } = qrPath(text);
  const box = size + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="-4 -4 ${box} ${box}" shape-rendering="crispEdges"><rect x="-4" y="-4" width="${box}" height="${box}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
