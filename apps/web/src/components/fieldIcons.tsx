import type { FieldType } from "@brill/shared";
import { GridColumnIcon } from "@glideapps/glide-data-grid";
import {
  AlignLeft, AtSign, Paperclip, Calendar, CircleDot, Globe, Hash, Link2, ListChecks, ListOrdered, Phone, Search, Sigma,
  SquareCheck, SquareFunction, Type, type LucideIcon,
} from "lucide-react";

/** Icons for field types in menus, dialogs and the record form. */
export const FIELD_ICONS: Record<FieldType, LucideIcon> = {
  singleLineText: Type,
  longText: AlignLeft,
  number: Hash,
  checkbox: SquareCheck,
  singleSelect: CircleDot,
  multipleSelect: ListChecks,
  date: Calendar,
  email: AtSign,
  url: Globe,
  phone: Phone,
  link: Link2,
  lookup: Search,
  rollup: Sigma,
  count: ListOrdered,
  formula: SquareFunction,
  attachment: Paperclip,
};

export function FieldIcon({ type, size = 15 }: { type: FieldType; size?: number }) {
  const Icon = FIELD_ICONS[type];
  return <Icon size={size} strokeWidth={2} />;
}

/** The grid's built-in header icons (drawn on canvas). */
export const GRID_ICONS: Record<FieldType, GridColumnIcon> = {
  singleLineText: GridColumnIcon.HeaderString,
  longText: GridColumnIcon.HeaderMarkdown,
  number: GridColumnIcon.HeaderNumber,
  checkbox: GridColumnIcon.HeaderBoolean,
  singleSelect: GridColumnIcon.HeaderSingleValue,
  multipleSelect: GridColumnIcon.HeaderArray,
  date: GridColumnIcon.HeaderDate,
  email: GridColumnIcon.HeaderEmail,
  url: GridColumnIcon.HeaderUri,
  phone: GridColumnIcon.HeaderPhone,
  link: GridColumnIcon.HeaderReference,
  lookup: GridColumnIcon.HeaderLookup,
  rollup: GridColumnIcon.HeaderRollup,
  count: GridColumnIcon.HeaderNumber,
  formula: GridColumnIcon.HeaderMath,
  attachment: GridColumnIcon.HeaderImage,
};
