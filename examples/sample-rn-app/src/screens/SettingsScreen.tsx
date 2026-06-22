// SettingsScreen — a comparatively clean screen. It imports Row too (raising
// Row's fan-in / centrality) and has only one minor inline-style finding, so
// it should stay BELOW the hotspot gate: a good signal-vs-noise control.
import React from 'react';
import { View, Text } from 'react-native';
import Row from '../components/Row';
import Avatar from '../components/Avatar';

export default function SettingsScreen() {
  return (
    <View style={{ padding: 16 }}>
      <Text>Settings</Text>
      <Avatar uri="https://example.com/me.png" size={40} />
      <Row item={{ id: 'theme', title: 'Theme' }} />
    </View>
  );
}
