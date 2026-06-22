// Row — a list-row component rendered inside FlatList/map but NOT wrapped in
// React.memo, and imported by 3 screens (high fan-in -> high centrality).
// This is the kind of shared hub whose debt should be amplified.
import React from 'react';
import { View, Text } from 'react-native';

export default function Row({ item }: { item: { id: string; title: string } }) {
  return (
    <View style={{ paddingVertical: 8 }}>
      <Text>{item.title}</Text>
    </View>
  );
}
