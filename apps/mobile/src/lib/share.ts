import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { RefObject } from 'react';
import type { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

export { escapeHtml } from './shareHtml';

/** Whether this platform can turn a view into a PNG (native yes, web no). */
export const canShareImage = true;

/** Captures a mounted view as a PNG and opens the share sheet with it. */
export async function shareViewAsImage(ref: RefObject<View | null>, title: string) {
  if (!ref.current) throw new Error('Nothing to capture');
  // Captured at the screen's pixel density; a temp file avoids a huge base64 string.
  const uri = await captureRef(ref, { format: 'png', quality: 1, result: 'tmpfile' });
  await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: title });
}

/** Renders an HTML document to a PDF file and opens the share sheet with it. */
export async function shareHtmlAsPdf(html: string, title: string) {
  const { uri } = await Print.printToFileAsync({ html });
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: title,
  });
}
