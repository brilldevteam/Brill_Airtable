import type { CellValue, Field, LinkLabels } from "./fields";
import type { View } from "./views";

export interface User {
  id: string;
  email: string;
  name: string;
  /** Has the user confirmed their email address? (Only sent for the signed-in user.) */
  emailVerified?: boolean;
}
export interface Base {
  id: string; workspaceId: string; name: string; color: string;
  /** Home page extras (per person): an icon name, starred, and when they last opened it. */
  icon?: string | null; starred?: boolean; lastOpenedAt?: string | null;
  /** File name of an uploaded logo, shown instead of the icon. */
  logo?: string | null;
}
export type EditAccess = "all" | "team" | "creators";
export interface Table {
  id: string;
  baseId: string;
  name: string;
  primaryFieldId: string | null;
  position: number;
  /** Who may add and delete records. */
  recordAccess: EditAccess;
}
export interface RecordRow {
  id: string;
  cells: Record<string, CellValue>;
  createdAt: string;
  updatedAt: string;
}
/** An uploaded file. url / thumbUrl are relative to the app. */
export interface AttachmentInfo {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbUrl: string | null;
}

/**
 * Records of a view plus display names for every record they link to (and attachment
 * filenames, keyed by attachment id), and details of every attachment shown.
 */
export interface ViewRecords { records: RecordRow[]; labels: LinkLabels; files: Record<string, AttachmentInfo> }

/** Table schema: everything except the records (those are loaded per view). */
export interface TableDetail { table: Table; fields: Field[]; views: View[] }
