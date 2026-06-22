// FeedScreen — the worst offender by design: a FlatList missing getItemLayout,
// index-as-key, oversized initialNumToRender, inline props, and a non-memoized
// row component rendered in the list.
import React from 'react';
import { View, FlatList, Text, TouchableOpacity } from 'react-native';
import Row from '../components/Row';
import { Card } from '../components'; // barrel import -> bundle-size

// Module-level row component used in a .map() below but NOT memoized -> D4.
const Tag = ({ label }: { label: string }) => <Text style={{ margin: 2 }}>{label}</Text>;

export default function FeedScreen({ startedAt }: { startedAt: string }) {
  const data = new Array(500).fill(0).map((_, i) => ({ id: String(i), title: `Item ${i}` }));
  const tags = ['new', 'hot', 'trending'];

  return (
    <View style={{ flex: 1 }}>
      <Card>
        <Text>Feed since {startedAt}</Text>
        {tags.map((t) => <Tag key={t} label={t} />)}
      </Card>
      <FlatList
        data={data}
        initialNumToRender={50}
        keyExtractor={(item, index) => index}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => console.log('tap', item.id)}
            style={{ padding: 12, backgroundColor: '#fff' }}
          >
            <Row item={item} />
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
