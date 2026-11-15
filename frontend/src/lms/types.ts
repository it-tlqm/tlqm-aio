import type { Me } from '@/lib/api';

export type LmsMe = Me & {
  unit?: { orgUnitId: string; tenantId: string; name?: string; code?: string };
  legacy: { id: string; name: string; code: string; department: string; role: string };
  capabilities: Record<string, boolean>;
};
export type LessonProgress = {
  id: string;
  lesson_id: string;
  title: string;
  subtitle: string;
  series: string;
  duration: number;
  position: number;
  watched: number;
  finished: number;
  deadline: string;
  is_mandatory: number;
};
export type Attempt = {
  id: string;
  lesson_id: string;
  title: string | null;
  score: number;
  created_at: string;
};
export type Note = {
  id: string;
  lesson_id: string;
  title: string | null;
  time: number;
  content: string;
  created_at: string;
};
export type Learning = {
  employeeId: string;
  progress: LessonProgress[];
  attempts: Attempt[];
  notes: Note[];
};
export type ReviewRow = {
  progress_id?: string | null;
  id: string;
  code: string;
  name: string;
  department: string;
  role: string;
  org_unit_id: string;
  lesson_id: string | null;
  title: string | null;
  duration: number | null;
  watched: number | null;
  finished: number | null;
};
export type Review = { items: ReviewRow[] };
