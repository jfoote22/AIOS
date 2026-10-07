import type { NavigatorScreenParams } from '@react-navigation/native';

export type TabsParamList = {
  Home: undefined;
  Brain: undefined;
  Dives: undefined;
  Build: undefined;
  More: undefined;
};

export type RootStackParamList = {
  Pair: undefined;
  Tabs: NavigatorScreenParams<TabsParamList>;
  SnippetDetail: { id: string; title?: string };
  DiveChat: { id?: string; title?: string };
  NewAgent: undefined;
  NewSkill: undefined;
  Capture: { imageUri?: string; mimeType?: string } | undefined;
  QuickAction: { text?: string } | undefined;
};
