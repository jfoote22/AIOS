/**
 * AIOS v2 shared UI primitives.
 *
 * Import from "@/ui" across features for a consistent, professional surface:
 *   import { Button, Card, Dialog, useToast } from "@/ui";
 */
export { cn } from "./cn";
export type { ClassValue } from "./cn";

export { Button, IconButton } from "./Button";
export type {
  ButtonProps,
  IconButtonProps,
  ButtonVariant,
  ButtonSize,
} from "./Button";

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardBody,
  CardFooter,
} from "./Card";
export type { CardProps } from "./Card";

export { Badge } from "./Badge";
export type { BadgeProps, BadgeTone, BadgeVariant } from "./Badge";

export { Input, Textarea, Label, Field } from "./Input";
export type { InputProps, TextareaProps, FieldProps } from "./Input";

export { Select } from "./Select";
export type { SelectProps, SelectOption } from "./Select";

export { Spinner, Skeleton, Separator, Kbd } from "./Feedback";

export { Dialog } from "./Dialog";
export type { DialogProps, DialogSize } from "./Dialog";

export { Drawer } from "./Drawer";
export type { DrawerProps, DrawerSide, DrawerSize } from "./Drawer";

export { Tooltip } from "./Tooltip";
export type { TooltipProps, TooltipSide } from "./Tooltip";

export { ToastProvider, useToast } from "./Toast";
export type { ToastOptions, ToastTone } from "./Toast";

export { Tabs, TabsList, TabsTrigger, TabsContent } from "./Tabs";
export type { TabsProps, TabsListVariant } from "./Tabs";

export { Table, THead, TBody, TR, TH, TD } from "./Table";

export {
  PageHeader,
  Toolbar,
  ToolbarSpacer,
  SectionLabel,
  EmptyState,
} from "./Layout";
export type { PageHeaderProps, EmptyStateProps } from "./Layout";

export { SplitPane } from "./SplitPane";
export type { SplitPaneProps } from "./SplitPane";

export {
  useOnEscape,
  useLockBodyScroll,
  useFocusReturn,
} from "./overlay";
