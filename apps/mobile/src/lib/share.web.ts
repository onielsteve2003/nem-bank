import type { RefObject, ComponentRef } from 'react';
import type { View } from 'react-native';

export { escapeHtml } from './shareHtml';

// Browsers cannot snapshot a React Native Web view without html2canvas, so the
// web demo offers the PDF only: the browser's print dialog has "Save as PDF".
export const canShareImage = false;

export async function shareViewAsImage(
  _ref: RefObject<ComponentRef<typeof View> | null>,
  _title: string,
) {
  throw new Error('Image sharing is only in the app');
}

/**
 * Prints the document from a hidden iframe. `window.print()` on the page itself
 * would print the whole web demo (phone frame and all).
 */
export async function shareHtmlAsPdf(html: string, title: string) {
  const frame = document.createElement('iframe');
  frame.title = title;
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0';
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) throw new Error('Printing is blocked in this browser');
    doc.open();
    doc.write(html);
    doc.close();
    doc.title = title;
    win.focus();
    win.print();
  } finally {
    // print() blocks until the dialog closes in every major browser.
    frame.remove();
  }
}
