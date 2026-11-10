/**
 * Shared navigation ref so non-screen components (e.g. ExternalEpubImportHandler)
 * can dispatch navigation actions without being inside a navigator.
 *
 * Pass this ref to <NavigationContainer ref={navigationRef}> in App.tsx, then
 * call `navigationRef.current?.navigate(...)` from anywhere — guarded by
 * `navigationRef.isReady()` to handle the brief window before the container
 * mounts.
 */

import { createNavigationContainerRef } from '@react-navigation/native';
import { RootStackParamList } from '../types';

export const navigationRef = createNavigationContainerRef<RootStackParamList>();
