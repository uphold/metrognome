// App entry — intentionally imports a heavy library synchronously at the top
// level (first-load anti-pattern) for the metrognome fixture.
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import moment from 'moment'; // heavy, full-package, at entry -> first-load HIGH
import FeedScreen from './screens/FeedScreen';
import ProfileScreen from './screens/ProfileScreen';
import SettingsScreen from './screens/SettingsScreen';

export default function App() {
  const startedAt = moment().format();
  return (
    <NavigationContainer>
      <FeedScreen startedAt={startedAt} />
      <ProfileScreen />
      <SettingsScreen />
    </NavigationContainer>
  );
}
