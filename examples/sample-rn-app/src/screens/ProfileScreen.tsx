// ProfileScreen — seeds memory-leak detectors (uncleaned subscription + timer)
// and a component-defined-inside-component smell, plus a dimensionless remote Image.
import React, { useEffect, useState } from 'react';
import { View, Image, Text, AppState } from 'react-native';
import Row from '../components/Row';

export default function ProfileScreen() {
  const [online, setOnline] = useState(true);

  // No cleanup returned -> leak on unmount.
  useEffect(() => {
    AppState.addEventListener('change', (s) => setOnline(s === 'active'));
    const id = setInterval(() => setOnline((o) => !o), 1000);
    // (intentionally missing: return () => { ...remove... clearInterval(id) })
  }, []);

  // Component defined inside another component -> remounts every render.
  const Badge = () => <Text>{online ? 'online' : 'offline'}</Text>;

  return (
    <View>
      <Image source={{ uri: 'https://example.com/avatar.png' }} />
      <Badge />
      <Row item={{ id: 'me', title: 'My profile' }} />
    </View>
  );
}
