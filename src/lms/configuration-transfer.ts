import { Training } from './training.js';
import type { CourseAuthorization, CourseCommand } from './courses.js';
import type { D1Database } from './types.js';
import type { LmsDirectory } from './directory.js';
import type { LmsConfig } from './security.js';
import { LmsError } from './security.js';
import { parseCourse } from './course-contracts.js';
import { parseTrainingPath } from './training-contracts.js';
import { ConfigurationTransfer } from '../configuration-transfer.js';
import {
  configUuid,
  ConfigurationTransferError,
  emptyReferenceOptions,
} from '../configuration-package.js';
import type { ConfigurationKind } from '../configuration-package.js';
type Row = Record<string, any>;
export class LmsConfigurationTransfer extends Training {
  constructor(
    db: D1Database,
    authorize: CourseAuthorization,
    directory: LmsDirectory,
    readonly config: LmsConfig,
  ) {
    super(db, authorize, directory);
  }
  private async target(kind: ConfigurationKind, id: string) {
    if (!['lms-course', 'lms-path'].includes(kind) || !configUuid(id))
      throw new ConfigurationTransferError('CONFIGURATION_KIND_INVALID');
    const actor = await this.actor('lms:admin');
    if (!actor.sessionHash) throw new LmsError(403, 'LMS_PORTAL_READ_ONLY');
    const row =
      kind === 'lms-course'
        ? await this.course(actor, id)
        : await this.db
            .prepare('SELECT * FROM lms_learning_paths WHERE id=? AND tenant_id=?')
            .bind(id, actor.link.tenant_id)
            .first<Row>();
    if (!row) throw new ConfigurationTransferError('CONFIGURATION_TARGET_NOT_FOUND', 404);
    return { actor, row };
  }
  private async transferOptions(kind: ConfigurationKind, id: string) {
    const { actor } = await this.target(kind, id),
      units = await this.directory.units(actor.link.tenant_id),
      courses = (
        await this.db
          .prepare(
            "SELECT v.id,v.version,json_extract(v.spec_json,'$.title') AS title FROM lms_course_versions v JOIN lms_courses c ON c.published_version_id=v.id WHERE c.tenant_id=? AND c.status='active' AND (?='lms-path' OR c.id<>?) ORDER BY c.code LIMIT 5001",
          )
          .bind(actor.link.tenant_id, kind, id)
          .all<Row>()
      ).results,
      media = (
        await this.db
          .prepare('SELECT id,name FROM lms_media WHERE tenant_id=? ORDER BY name,id LIMIT 5001')
          .bind(actor.link.tenant_id)
          .all<{ id: string; name: string }>()
      ).results;
    if (courses.length > 5000 || media.length > 5000 || units.length > 5000)
      throw new ConfigurationTransferError('CONFIGURATION_TOO_LARGE', 413);
    return {
      ...emptyReferenceOptions(),
      unit: units.map(({ id, name }) => ({ id, name })),
      courseVersion: courses.map((c) => ({
        id: String(c.id),
        name: String(c.title) + ' · v' + c.version,
      })),
      media,
    };
  }
  service(kind: ConfigurationKind, id: string, command: CourseCommand) {
    const normalize = (content: unknown) =>
      kind === 'lms-course' ? parseCourse(content) : parseTrainingPath(content);
    return new ConfigurationTransfer(
      kind,
      id,
      this.config.encryptionKey,
      this.config.instanceId + ':' + this.config.purpose + ':configuration',
      {
        read: async () => {
          const { actor, row } = await this.target(kind, id),
            content = normalize(JSON.parse(row.draft_json));
          return {
            tenantId: actor.link.tenant_id,
            accountId: actor.principal.accountId,
            personId: actor.principal.personId,
            revision: Number(row.revision),
            label: content.title,
            content,
            metadata:
              kind === 'lms-course' ? { code: row.code, ownerUnitId: row.owner_unit_id } : {},
          };
        },
        normalize,
        options: () => this.transferOptions(kind, id),
        validate: async (value) => {
          const { actor } = await this.target(kind, id),
            content = value as any;
          if (kind === 'lms-course' && content.video?.kind === 'file') {
            const media = await this.media(content.video.id);
            if (media.kind !== 'video')
              throw new ConfigurationTransferError('CONFIGURATION_REFERENCE_KIND');
          }
          const versions: string[] =
            kind === 'lms-path'
              ? content.courseVersionIds
              : (content.policy?.prerequisiteVersionIds ?? []);
          for (const version of versions) {
            const row = await this.db
              .prepare(
                "SELECT v.spec_json FROM lms_course_versions v JOIN lms_courses c ON c.published_version_id=v.id AND c.id=v.course_id WHERE v.id=? AND c.tenant_id=? AND c.status='active'",
              )
              .bind(version, actor.link.tenant_id)
              .first<{ spec_json: string }>();
            if (
              !row ||
              content.audienceUnits.some(
                (u: string) => !JSON.parse(row.spec_json).audienceUnits.includes(u),
              )
            )
              throw new ConfigurationTransferError('CONFIGURATION_REFERENCE_UNAVAILABLE');
          }
        },
        write: async (review) => {
          const { row } = await this.target(kind, id);
          if (kind === 'lms-path')
            return this.savePath(
              { id, expectedRevision: review.revision, spec: review.content },
              command,
            );
          if (
            row.code !== review.metadata.code ||
            row.owner_unit_id !== review.metadata.ownerUnitId
          )
            throw new ConfigurationTransferError('CONFIGURATION_PREVIEW_STALE', 409);
          return this.save(
            {
              courseId: id,
              code: row.code,
              ownerUnitId: row.owner_unit_id,
              expectedRevision: review.revision,
              spec: review.content,
            },
            command,
          );
        },
      },
    );
  }
}
