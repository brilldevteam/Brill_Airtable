import type {
  Action, Automation, AutomationRun, Trigger, Dashboard, Widget, WidgetData,
  AttachmentInfo, EditAccess, Base, Field, FieldOptions, FieldType, RecordRow, Table, TableDetail, User, View, ViewConfig, ViewRecords, ViewType,
} from "@brill/shared";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Identifies this browser tab, so it can ignore live-update events about its own changes. */
export const CLIENT_ID = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).slice(0, 36);

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "X-Client-Id": CLIENT_ID, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Session ended (expired, or signed out elsewhere): let the app return to the sign-in screen.
  if (res.status === 401 && !url.startsWith("/api/auth/") && !url.startsWith("/api/public/")) {
    window.dispatchEvent(new Event("brill:signed-out"));
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface DevEmail { id: number; to: string; subject: string; text: string; html: string; sentAt: string }
export type Role = "owner" | "creator" | "editor" | "commenter" | "read";
export interface Workspace { id: string; name: string; role: Role }
export interface Member { userId: string; name: string; email: string; role: Role }
export interface PendingInvite { id: string; email: string; role: Role; createdAt: string; expiresAt: string }
export interface PublicFormField {
  id: string;
  type: FieldType;
  label: string;
  help: string;
  required: boolean;
  options: {
    choices?: { id: string; name: string; color: string }[]; precision?: number; includeTime?: boolean;
    symbol?: string; max?: number; durationFormat?: "h:mm" | "h:mm:ss";
  };
}
export interface PublicForm {
  title: string;
  description: string;
  submitText: string;
  successMessage: string;
  allowAnother: boolean;
  fields: PublicFormField[];
}
export interface PublicView {
  base: { name: string; color: string };
  table: { name: string; primaryFieldId: string | null };
  view: { name: string; type: ViewType; config: { coverFieldId: string | null; coverFit: "cover" | "contain"; cardSize: "small" | "medium" | "large" } };
  fields: Field[];
  records: { id: string; cells: Record<string, import("@brill/shared").CellValue> }[];
  labels: Record<string, string>;
  files: Record<string, AttachmentInfo>;
}
export interface Comment { id: string; body: string; createdAt: string; userId: string; userName: string }
export interface HistoryEntry {
  id: string; kind: "create" | "update" | "delete" | "restore"; createdAt: string; userId: string | null; userName: string | null;
  changes: Record<string, { from: import("@brill/shared").CellValue; to: import("@brill/shared").CellValue }>;
}
export interface AttachmentComment { id: string; body: string; createdAt: string; userId: string; userName: string }
export interface TrashItem {
  id: string; tableId: string; tableName: string; name: string;
  details: { field: string; value: string }[]; deletedAt: string; deletedBy: string | null;
}
export interface SharedBase extends Base { role: Role; workspaceName: string }
export interface BaseSharing {
  base: { id: string; name: string };
  workspace: { id: string; name: string };
  myRole: Role;
  guest: boolean;
  canManageBase: boolean;
  canManageWorkspace: boolean;
  members: Member[];
  guests: Member[];
  invites: (PendingInvite & { scope: "base" | "workspace" })[];
}
export interface FieldInput {
  name?: string;
  type?: FieldType;
  editAccess?: EditAccess;
  options?: Omit<Partial<FieldOptions>, "choices"> & { choices?: { id?: string; name: string; color?: string }[] };
}

export const api = {
  me: () => call<{ user: User | null }>("GET", "/api/auth/me"),
  login: (email: string, password: string) => call<{ user: User }>("POST", "/api/auth/login", { email, password }),
  register: (name: string, email: string, password: string) =>
    call<{ user: User }>("POST", "/api/auth/register", { name, email, password }),
  logout: () => call("POST", "/api/auth/logout", {}),
  authConfig: () => call<{ signups: "open" | "invite"; firstAccount: boolean; emailSending: boolean }>("GET", "/api/auth/config"),
  updateMe: (name: string) => call<{ user: User }>("PATCH", "/api/auth/me", { name }),
  changeEmail: (newEmail: string, currentPassword: string) =>
    call<{ ok: true; pending: string }>("POST", "/api/auth/email", { newEmail, currentPassword }),
  confirmEmail: (token: string) => call<{ ok: true; email: string }>("POST", "/api/auth/confirm-email", { token }),
  changePassword: (currentPassword: string, newPassword: string) => call("POST", "/api/auth/password", { currentPassword, newPassword }),
  sessions: () => call<{ active: number }>("GET", "/api/auth/sessions"),
  revokeOtherSessions: () => call("POST", "/api/auth/sessions/revoke-others", {}),
  verifyEmail: (token: string) => call<{ ok: true; email: string }>("POST", "/api/auth/verify-email", { token }),
  resendVerification: () => call<{ ok: true; alreadyVerified?: boolean }>("POST", "/api/auth/resend-verification", {}),
  forgotPassword: (email: string) => call<{ ok: true }>("POST", "/api/auth/forgot-password", { email }),
  resetPassword: (token: string, password: string) => call<{ user: User }>("POST", "/api/auth/reset-password", { token, password }),
  devMail: () => call<{ emails: DevEmail[] }>("GET", "/api/dev/mail"),

  workspaces: () => call<{ workspaces: Workspace[]; bases: Base[]; sharedBases: SharedBase[] }>("GET", "/api/workspaces"),
  createBase: (wsId: string, name: string, color: string) =>
    call<{ base: Base; firstTableId: string }>("POST", `/api/workspaces/${wsId}/bases`, { name, color }),
  updateBase: (id: string, patch: { name?: string; color?: string }) => call("PATCH", `/api/bases/${id}`, patch),
  deleteBase: (id: string) => call("DELETE", `/api/bases/${id}`),

  base: (id: string) => call<{ base: Base; tables: Table[]; role: Role; guest: boolean }>("GET", `/api/bases/${id}`),
  collaborators: (baseId: string) => call<{ users: { id: string; name: string; email: string }[] }>("GET", `/api/bases/${baseId}/collaborators`),
  baseSharing: (baseId: string) => call<BaseSharing>("GET", `/api/bases/${baseId}/sharing`),
  inviteToBase: (baseId: string, email: string, role: Role) =>
    call<{ invite: { id: string; email: string; role: Role; token: string; path: string; emailed: boolean } }>(
      "POST", `/api/bases/${baseId}/invites`, { email, role }),
  cancelBaseInvite: (baseId: string, inviteId: string) => call("DELETE", `/api/bases/${baseId}/invites/${inviteId}`),
  setBaseMemberRole: (baseId: string, userId: string, role: Role) => call("PATCH", `/api/bases/${baseId}/members/${userId}`, { role }),
  removeBaseMember: (baseId: string, userId: string) => call("DELETE", `/api/bases/${baseId}/members/${userId}`),
  setRecordAccess: (tableId: string, recordAccess: EditAccess) => call("PATCH", `/api/tables/${tableId}`, { recordAccess }),

  members: (wsId: string) => call<{ members: Member[]; invites: PendingInvite[]; myRole: Role }>("GET", `/api/workspaces/${wsId}/members`),
  invite: (wsId: string, email: string, role: Role) =>
    call<{ invite: { id: string; email: string; role: Role; token: string; path: string; emailed: boolean } }>(
      "POST", `/api/workspaces/${wsId}/invites`, { email, role }),
  cancelInvite: (wsId: string, inviteId: string) => call("DELETE", `/api/workspaces/${wsId}/invites/${inviteId}`),
  setMemberRole: (wsId: string, userId: string, role: Role) => call("PATCH", `/api/workspaces/${wsId}/members/${userId}`, { role }),
  removeMember: (wsId: string, userId: string) => call("DELETE", `/api/workspaces/${wsId}/members/${userId}`),
  inviteInfo: (token: string) =>
    call<{ email: string; role: Role; workspace: string; base: string | null; invitedBy: string | null }>("GET", `/api/invites/${token}`),
  acceptInvite: (token: string) => call<{ workspaceId: string; baseId: string | null }>("POST", `/api/invites/${token}/accept`, {}),

  viewShare: (viewId: string) => call<{ share: { token: string; enabled: boolean } | null }>("GET", `/api/views/${viewId}/share`),
  enableShare: (viewId: string, regenerate = false) =>
    call<{ share: { token: string; enabled: boolean } }>("POST", `/api/views/${viewId}/share`, { regenerate }),
  disableShare: (viewId: string) => call("DELETE", `/api/views/${viewId}/share`),

  // Public (no sign-in) — used by the shared form and shared view pages.
  publicForm: (token: string) => call<{ base: { name: string; color: string }; form: PublicForm }>("GET", `/api/public/forms/${token}`),
  publicFormUpload: (token: string, file: File, onProgress?: (p: number) => void) =>
    new Promise<{ id: string; filename: string; size: number; mime: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/public/forms/${token}/attachments`);
      xhr.setRequestHeader("X-Brill-Upload", "1");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data: any = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data.attachments[0]);
        else reject(new ApiError(xhr.status, data.error ?? `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error while uploading"));
      const form = new FormData();
      form.append("file", file, file.name);
      xhr.send(form);
    }),
  publicFormSubmit: (token: string, cells: Record<string, unknown>) => call<{ ok: true }>("POST", `/api/public/forms/${token}/submit`, { cells }),
  publicView: (token: string) => call<PublicView>("GET", `/api/public/views/${token}`),

  recordComments: (recordId: string) => call<{ comments: Comment[] }>("GET", `/api/records/${recordId}/comments`),
  addRecordComment: (recordId: string, body: string) => call<{ comment: Comment }>("POST", `/api/records/${recordId}/comments`, { body }),
  deleteRecordComment: (id: string) => call("DELETE", `/api/record-comments/${id}`),
  recordHistory: (recordId: string) =>
    call<{ entries: HistoryEntry[]; labels: Record<string, string> }>("GET", `/api/records/${recordId}/history`),
  createTable: (baseId: string, name: string) => call<{ table: Table }>("POST", `/api/bases/${baseId}/tables`, { name }),
  renameTable: (id: string, name: string) => call("PATCH", `/api/tables/${id}`, { name }),
  deleteTable: (id: string) => call("DELETE", `/api/tables/${id}`),

  table: (id: string) => call<TableDetail>("GET", `/api/tables/${id}`),
  createField: (tableId: string, input: FieldInput) => call<{ field: Field }>("POST", `/api/tables/${tableId}/fields`, input),
  updateField: (id: string, input: FieldInput) => call<{ field: Field }>("PATCH", `/api/fields/${id}`, input),
  deleteField: (id: string) => call("DELETE", `/api/fields/${id}`),

  viewRecords: (viewId: string) => call<ViewRecords>("GET", `/api/views/${viewId}/records`),
  recordNames: (tableId: string, q = "") =>
    call<{ records: { id: string; name: string }[] }>("GET", `/api/tables/${tableId}/record-names?q=${encodeURIComponent(q)}`),
  createView: (tableId: string, name: string, type: ViewType, copyFromViewId?: string) =>
    call<{ view: View }>("POST", `/api/tables/${tableId}/views`, { name, type, copyFromViewId }),
  updateView: (id: string, patch: { name?: string; config?: ViewConfig }) => call<{ view: View }>("PATCH", `/api/views/${id}`, patch),
  deleteView: (id: string) => call("DELETE", `/api/views/${id}`),

  /** Upload files to a table; returns their attachment info (ids go into attachment cells). */
  uploadAttachments: async (tableId: string, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    const res = await fetch(`/api/tables/${tableId}/attachments`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-Brill-Upload": "1" },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `Upload failed (${res.status})`);
    return data.attachments as AttachmentInfo[];
  },
  /** Upload one file with progress (0..1). */
  uploadFile: (tableId: string, file: File, onProgress?: (p: number) => void) =>
    new Promise<AttachmentInfo>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/tables/${tableId}/attachments`);
      xhr.setRequestHeader("X-Brill-Upload", "1");
      xhr.setRequestHeader("X-Client-Id", CLIENT_ID);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data: any = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data.attachments[0]);
        else reject(new ApiError(xhr.status, data.error ?? `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error while uploading"));
      const form = new FormData();
      form.append("file", file, file.name);
      xhr.send(form);
    }),
  attachFromUrl: (tableId: string, url: string) =>
    call<{ attachments: AttachmentInfo[] }>("POST", `/api/tables/${tableId}/attachments/from-url`, { url }),
  renameAttachment: (id: string, filename: string) => call<{ attachment: AttachmentInfo }>("PATCH", `/api/attachments/${id}`, { filename }),
  attachmentComments: (id: string) => call<{ comments: AttachmentComment[] }>("GET", `/api/attachments/${id}/comments`),
  addAttachmentComment: (id: string, body: string) => call<{ comment: AttachmentComment }>("POST", `/api/attachments/${id}/comments`, { body }),
  deleteAttachmentComment: (commentId: string) => call("DELETE", `/api/attachment-comments/${commentId}`),
  batchCreate: (tableId: string, records: { cells: Record<string, unknown> }[], opts: { typecast?: boolean; dateOrder?: "dmy" | "mdy" } = {}) =>
    call<{ created: number; ids: string[] }>("POST", `/api/tables/${tableId}/records/batch`, { records, ...opts }),
  exportCsvUrl: (viewId: string) => `/api/views/${viewId}/export.csv`,

  createRecord: (tableId: string, cells: Record<string, unknown> = {}) =>
    call<{ record: RecordRow }>("POST", `/api/tables/${tableId}/records`, { cells }),
  dashboards: (baseId: string) => call<{ dashboards: Dashboard[] }>("GET", `/api/bases/${baseId}/dashboards`),
  createDashboard: (baseId: string, body: { name: string; tableId?: string | null; starter?: boolean }) =>
    call<{ dashboard: Dashboard }>("POST", `/api/bases/${baseId}/dashboards`, body),
  updateDashboard: (id: string, patch: { name?: string; widgets?: Widget[] }) => call<{ dashboard: Dashboard }>("PATCH", `/api/dashboards/${id}`, patch),
  deleteDashboard: (id: string) => call("DELETE", `/api/dashboards/${id}`),
  dashboardData: (id: string) => call<{ data: Record<string, WidgetData> }>("GET", `/api/dashboards/${id}/data`),
  automations: (baseId: string) => call<{ automations: Automation[] }>("GET", `/api/bases/${baseId}/automations`),
  createAutomation: (baseId: string, body: { name: string; trigger: Trigger; actions: Action[]; enabled?: boolean }) =>
    call<{ automation: Automation }>("POST", `/api/bases/${baseId}/automations`, body),
  updateAutomation: (id: string, patch: Partial<{ name: string; enabled: boolean; trigger: Trigger; actions: Action[] }>) =>
    call<{ automation: Automation }>("PATCH", `/api/automations/${id}`, patch),
  deleteAutomation: (id: string) => call("DELETE", `/api/automations/${id}`),
  automationRuns: (id: string) => call<{ runs: AutomationRun[] }>("GET", `/api/automations/${id}/runs`),
  testAutomation: (id: string, recordId?: string) => call<{ run: AutomationRun }>("POST", `/api/automations/${id}/test`, recordId ? { recordId } : {}),
  updateRecord: (id: string, cells: Record<string, unknown>) => call<{ record: RecordRow }>("PATCH", `/api/records/${id}`, { cells }),
  deleteRecord: (id: string) => call("DELETE", `/api/records/${id}`),
  restoreRecord: (id: string) => call<{ record: RecordRow }>("POST", `/api/records/${id}/restore`, {}),
  deleteRecordForever: (id: string) => call("DELETE", `/api/records/${id}/permanent`),
  trash: (baseId: string) => call<{ days: number; items: TrashItem[] }>("GET", `/api/bases/${baseId}/trash`),
};
