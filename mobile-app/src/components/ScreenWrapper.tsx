import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface ScreenWrapperProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  applyBottomInset?: boolean;
}

const ScreenWrapper: React.FC<ScreenWrapperProps> = ({
  children,
  style,
  applyBottomInset = false,
}) => {
  const edges: ('top' | 'bottom' | 'left' | 'right')[] = applyBottomInset
    ? ['top', 'bottom', 'left', 'right']
    : ['top', 'left', 'right'];

  return (
    <SafeAreaView edges={edges} style={[{ flex: 1 }, style]}>
      {children}
    </SafeAreaView>
  );
};

export default ScreenWrapper;
