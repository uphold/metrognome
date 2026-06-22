// Card — a low-severity offender: one inline style literal. On its own this is
// the kind of harmless finding that should stay BELOW the hotspot gate.
import React from 'react';
import { View } from 'react-native';

export default function Card({ children }: { children: React.ReactNode }) {
  return <View style={{ borderRadius: 8, padding: 12 }}>{children}</View>;
}
