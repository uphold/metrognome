// Avatar — a CONTROL: it IS wrapped in React.memo and gives its Image explicit
// dimensions. metrognome should NOT flag it as a missing-memo or image hotspot.
import React from 'react';
import { Image } from 'react-native';

const Avatar = React.memo(({ uri, size }: { uri: string; size: number }) => (
  <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} />
));

export default Avatar;
