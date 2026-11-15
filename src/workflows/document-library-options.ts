export const documentReviewStates = ['draft', 'pending', 'approved', 'rejected'] as const;
export type DocumentReviewState = (typeof documentReviewStates)[number];
export const documentActions = [
  'submit',
  'reopen',
  'approve',
  'reject',
  'issue',
  'withdraw',
] as const;
export type DocumentAction = (typeof documentActions)[number];
export type DocumentFolder = {
  id: string;
  org_unit_id: string;
  parent_id: string | null;
  name: string;
  revision: number;
};
export type DocumentFile = {
  id: string;
  file_name: string;
  byte_count: number;
  format: string;
  scan_status: 'ready' | 'quarantined';
};
export type DocumentDraftInput = {
  unitId: string;
  folderId: string | null;
  title: string;
  content: string;
  viewerUnits: string[];
  workflow?: { definitionId: string; versionId: string };
  files: ({ reuseId: string } | { fileName: string; content: string })[];
};
export type DocumentItem = {
  id: string;
  unitId: string;
  folderId: string | null;
  title: string;
  version: number;
  published: boolean;
  updatedAt: string;
  revision?: number;
  reviewState?: DocumentReviewState;
  issuedVersion?: number | null;
};
export type DocumentContent = DocumentItem & {
  content: string;
  viewerUnits?: string[];
  workflow: { definitionId: string; versionId: string } | null;
  files: DocumentFile[];
  canDraft: boolean;
  canPublish: boolean;
  versions: { version: number; title: string; createdAt: string }[];
  history: {
    id: string;
    action: string;
    reason: string;
    occurred_at: string;
    actor_account_id: string;
    details: { version?: number; sourceVersion?: number; actorName?: string };
  }[];
};
