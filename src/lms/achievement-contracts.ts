export type Certificate = {
  schemaVersion: 1;
  id: string;
  code: string;
  recipientName: string;
  employeeCode: string;
  courseTitle: string;
  series: string;
  version: number;
  checksum: string;
  score: number;
  completedAt: number;
  issuedAt: number;
  tracking: 'self-confirmed' | 'player-reported';
};
export type Ranking = {
  scope: 'unit';
  orgUnitId: string;
  total: number;
  page: number;
  pageSize: number;
  myRank: number | null;
  items: {
    rank: number;
    name: string;
    code: string;
    isMe: boolean;
    completed: number;
    attempted: number;
    average: number;
  }[];
};
export const certificateCode = (attemptId: string) => 'TLQM-' + attemptId.toUpperCase();
