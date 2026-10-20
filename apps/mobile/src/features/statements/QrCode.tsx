import Svg, { Path, Rect } from 'react-native-svg';

import { qrPath } from '@/lib/qr';

export type Props = { value: string; size: number; accessibilityLabel: string };

/** Black on white whatever the theme: scanners read dark-on-light most reliably. */
export function QrCode({ value, size, accessibilityLabel }: Props) {
  const qr = qrPath(value);
  const box = qr.size + 8;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`-4 -4 ${box} ${box}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Rect x={-4} y={-4} width={box} height={box} fill="#FFFFFF" />
      <Path d={qr.d} fill="#000000" />
    </Svg>
  );
}
