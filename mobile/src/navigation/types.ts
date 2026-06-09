import type { NavigatorScreenParams } from '@react-navigation/native';

export type TabsParamList = {
  Brain: undefined;
  Dives: undefined;
  Build: undefined;
  Terminal: undefined;
  More: undefined;
};

export type RootStackParamList = {
  Pair: undefined;
  Tabs: NavigatorScreenParams<TabsParamList>;
  SnippetDetail: { id: string; title?: string };
  DiveChat: { id?: string; title?: string };
  NewAgent: undefined;
  NewSkill: undefined;
  Capture: undefined;
  QuickAction: { text?: string } | undefined;
};
