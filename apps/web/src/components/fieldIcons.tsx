import type { FieldType } from "@brill/shared";
import { GridColumnIcon } from "@glideapps/glide-data-grid";
import {
  AlignLeft, AtSign, Paperclip, Calendar, CalendarPlus, CircleDot, Clock, Globe, Hash, IndianRupee, Link2, ListChecks, ListOrdered,
  Percent, Phone, Search, Sigma, SquareCheck, SquareFunction, Star, Timer, Type, User, UserCheck, UserPlus, type LucideIcon,
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
  currency: IndianRupee,
  percent: Percent,
  rating: Star,
  duration: Timer,
  user: User,
  autonumber: Hash,
  createdTime: CalendarPlus,
  lastModifiedTime: Clock,
  createdBy: UserPlus,
  lastModifiedBy: UserCheck,
};

export function FieldIcon({ type, size = 15 }: { type: FieldType; size?: number }) {
  const Icon = FIELD_ICONS[type];
  return <Icon size={size} strokeWidth={2} />;
}

/** The grid's built-in header icons (drawn on canvas). */
export const GRID_ICONS: Record<FieldType, string> = {
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
  currency: "brillCurrency",
  percent: "brillPercent",
  rating: "brillStar",
  duration: "brillTimer",
  user: "brillUser",
  autonumber: GridColumnIcon.HeaderRowID,
  createdTime: "brillCalendar",
  lastModifiedTime: "brillClock",
  createdBy: "brillUserPlus",
  lastModifiedBy: "brillUserCheck",
};

/** Header icons the grid doesn't have, drawn like its own (white glyph on a rounded square). */
const glyph = (paths: string) => ({ fgColor, bgColor }: { fgColor: string; bgColor: string }) =>
  `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="16" height="16" rx="4" fill="${bgColor}"/>
    <g transform="translate(4.6 4.6) scale(0.45)" fill="none" stroke="${fgColor}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
  </svg>`;
const USER = '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>';
export const CUSTOM_HEADER_ICONS = {
  brillCurrency: glyph('<path d="M6 3h12"/><path d="M6 8h12"/><path d="m6 13 8.5 8"/><path d="M6 13h3"/><path d="M9 13c6.667 0 6.667-10 0-10"/>'),
  brillPercent: glyph('<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>'),
  brillStar: glyph('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>'),
  brillTimer: glyph('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M10 2h4"/>'),
  brillUser: glyph(USER),
  brillUserPlus: glyph(USER.replace("M20 21", "M16 21").replace("cx=\"12\"", "cx=\"9\"") + '<line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>'),
  brillUserCheck: glyph(USER.replace("M20 21", "M16 21").replace("cx=\"12\"", "cx=\"9\"") + '<polyline points="16 11 18 13 22 9"/>'),
  brillCalendar: glyph('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  brillClock: glyph('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
};
