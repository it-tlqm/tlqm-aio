import { Courses } from './courses.js';
import type { CourseAuthorization, CourseCommand } from './courses.js';
import { allowed, requirePermission } from './access.js';
import { LmsError } from './security.js';
import type { D1Database } from './types.js';
import type { LearnerDirectory } from './learner-directory.js';
import type { IntegrationIdentity } from '../integration-identity-proof.js';
export type LearnerAction = 'provision' | 'enable' | 'disable' | 'reconcile';
export type LearnerChange = { accountId: string; orgUnitId: string; expectedRevision: number };
type Mapping = {
  account_id: string;
  person_id: string;
  employee_id: string;
  tenant_id: string;
  org_unit_id: string;
  active: number;
  revision: number;
  is_active: number;
  code: string;
  name: string;
  credential_kind: string;
  external_active: number;
};
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const columns =
  'SELECT a.account_id,a.person_id,a.employee_id,a.tenant_id,a.org_unit_id,a.active,a.revision,e.is_active,e.code,e.name,e.credential_kind,EXISTS(SELECT 1 FROM aio_external_links x WHERE x.account_id=a.account_id AND x.active=1) AS external_active FROM aio_account_links a JOIN employees e ON e.id=a.employee_id';
export class Learners extends Courses {
  constructor(
    db: D1Database,
    authorize: CourseAuthorization,
    private learnerDirectory: LearnerDirectory,
  ) {
    super(
      db,
      async () => {
        const actor = await authorize();
        requirePermission(actor.principal, actor.link, 'lms:admin');
        if (
          !allowed(actor.principal, 'identity:provision', actor.link.tenant_id) ||
          !allowed(actor.principal, 'directory:lookup', actor.link.tenant_id)
        )
          throw new LmsError(403, 'LMS_PROVISIONING_DENIED');
        return actor;
      },
      learnerDirectory,
    );
  }
  async mappings(cursor?: string) {
    if (cursor !== undefined && !uuid(cursor)) throw new LmsError(400, 'INVALID_REQUEST');
    const actor = await this.actor('lms:admin'),
      tenantId = actor.link.tenant_id;
    const rows = (
      await this.db
        .prepare(
          columns +
            ' WHERE a.tenant_id=? AND (? IS NULL OR a.account_id>?) ORDER BY a.account_id LIMIT 51',
        )
        .bind(tenantId, cursor ?? null, cursor ?? null)
        .all<Mapping>()
    ).results;
    const page = rows.slice(0, 50),
      people = await this.directory.people(
        tenantId,
        page.map((r) => r.account_id),
      );
    const units = await this.directory.units(tenantId);
    return {
      items: page.map((row) => {
        const person = people.find(
          (p) => p.accountId === row.account_id && p.personId === row.person_id,
        );
        return {
          accountId: row.account_id,
          employeeId: row.employee_id,
          code: row.code,
          name: person?.displayName ?? row.name,
          orgUnitId: row.org_unit_id,
          unitName:
            units.find((u) => u.id === row.org_unit_id)?.name ?? 'Đơn vị không còn hiệu lực',
          units: person?.units ?? [],
          revision: row.revision,
          active: Boolean(row.active),
          credentialKind: row.credential_kind,
          state: !row.active
            ? 'disabled'
            : !row.is_active
              ? 'profile-inactive'
              : !person
                ? 'unavailable'
                : !person.units.some((u) => u.id === row.org_unit_id)
                  ? 'stale-unit'
                  : !row.external_active
                    ? 'identity-disabled'
                    : 'ready',
        };
      }),
      units,
      nextCursor: rows.length > 50 ? rows[49]!.account_id : null,
    };
  }
  async discover(query: { search?: string; orgUnitId?: string; cursor?: string }) {
    if (
      (query.search !== undefined &&
        (typeof query.search !== 'string' || query.search.length > 160)) ||
      (query.orgUnitId !== undefined && !uuid(query.orgUnitId)) ||
      (query.cursor !== undefined && !uuid(query.cursor))
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    const actor = await this.actor('lms:admin'),
      result = await this.learnerDirectory.discover({ ...query, tenantId: actor.link.tenant_id });
    const links = (
      await this.db
        .prepare(
          'SELECT account_id FROM aio_account_links WHERE account_id IN (SELECT value FROM json_each(?))',
        )
        .bind(JSON.stringify(result.items.map((p) => p.accountId)))
        .all<{ account_id: string }>()
    ).results;
    // Account ownership is global and immutable. A mapping in another tenant must not be reattached.
    return {
      ...result,
      items: result.items.map((p) => ({
        ...p,
        alreadyLinked: links.some((l) => l.account_id === p.accountId),
      })),
    };
  }
  async change(action: LearnerAction, data: LearnerChange, command: CourseCommand) {
    if (
      !['provision', 'enable', 'disable', 'reconcile'].includes(action) ||
      !data ||
      typeof data !== 'object' ||
      Object.keys(data).some((k) => !['accountId', 'orgUnitId', 'expectedRevision'].includes(k)) ||
      !uuid(data.accountId) ||
      !uuid(data.orgUnitId) ||
      !Number.isInteger(data.expectedRevision) ||
      data.expectedRevision < (action === 'provision' ? 0 : 1) ||
      (action === 'provision' && data.expectedRevision !== 0)
    )
      throw new LmsError(400, 'INVALID_REQUEST');
    const actor = await this.actor('lms:admin'),
      tenantId = actor.link.tenant_id;
    if (data.accountId === actor.principal.accountId)
      throw new LmsError(403, 'LMS_SELF_MAPPING_CHANGE_DENIED');
    const prior = await this.db
      .prepare(columns + ' WHERE a.account_id=? AND a.tenant_id=?')
      .bind(data.accountId, tenantId)
      .first<Mapping>();
    let target: IntegrationIdentity | undefined;
    const verifyTarget = async () => {
      if (action === 'disable') return;
      const verified = await this.learnerDirectory.identity({
        accountId: data.accountId,
        tenantId,
        orgUnitId: data.orgUnitId,
      });
      if (prior) {
        if (prior.person_id !== verified.personId)
          throw new LmsError(409, 'LMS_IDENTITY_OWNERSHIP_MISMATCH');
        const external = await this.db
          .prepare('SELECT account_id FROM aio_external_links WHERE issuer=? AND subject=?')
          .bind(verified.issuer, verified.subject)
          .first<{ account_id: string }>();
        if (external?.account_id !== prior.account_id)
          throw new LmsError(409, 'LMS_IDENTITY_OWNERSHIP_MISMATCH');
        if (!prior.is_active) throw new LmsError(409, 'LMS_PROFILE_INACTIVE');
      }
      if (target && JSON.stringify(verified) !== JSON.stringify(target))
        throw new LmsError(409, 'LMS_IDENTITY_TARGET_CHANGED');
      target = verified;
    };
    await verifyTarget();
    const payload = { action, ...data },
      event =
        'learner.' +
        {
          provision: 'provisioned',
          enable: 'enabled',
          disable: 'disabled',
          reconcile: 'reconciled',
        }[action];
    const replay = await this.replayCommand<Record<string, unknown>>(
      actor,
      command,
      event,
      payload,
    );
    if (replay) return replay;
    if (action === 'provision') {
      if (
        await this.db
          .prepare('SELECT 1 FROM aio_account_links WHERE account_id=?')
          .bind(data.accountId)
          .first()
      )
        throw new LmsError(409, 'LMS_ACCOUNT_ALREADY_LINKED');
    } else {
      if (!prior) throw new LmsError(404, 'LMS_MAPPING_NOT_FOUND');
      if (prior.revision !== data.expectedRevision) throw new LmsError(409, 'REVISION_CONFLICT');
      if (action !== 'reconcile' && data.orgUnitId !== prior.org_unit_id)
        throw new LmsError(400, 'LMS_RECONCILE_REQUIRED');
    }
    await verifyTarget();
    const employeeId = prior?.employee_id ?? crypto.randomUUID(),
      now = Date.now(),
      revision = data.expectedRevision + 1;
    return this.commit(actor, 'lms:admin', command, event, payload, (operation) => {
      const statements =
        action === 'provision'
          ? [
              this.db
                .prepare(
                  "INSERT INTO employees(id,code,name,department,role,password_hash,credential_kind,created_at,updated_at) VALUES (?,?,?,?,'learner',NULL,'sso-only',?,?)",
                )
                .bind(
                  employeeId,
                  'SSO-' + data.accountId,
                  target!.displayName,
                  target!.unitName,
                  new Date(now).toISOString(),
                  new Date(now).toISOString(),
                ),
              this.db
                .prepare(
                  'INSERT INTO aio_account_links(account_id,person_id,employee_id,tenant_id,org_unit_id,verified_at,verified_by,last_operation_id) VALUES (?,?,?,?,?,?,?,?)',
                )
                .bind(
                  data.accountId,
                  target!.personId,
                  employeeId,
                  tenantId,
                  data.orgUnitId,
                  now,
                  actor.principal.accountId,
                  operation,
                ),
              this.db
                .prepare(
                  'INSERT INTO aio_external_links(issuer,subject,account_id,verified_at,verified_by) VALUES (?,?,?,?,?)',
                )
                .bind(
                  target!.issuer,
                  target!.subject,
                  data.accountId,
                  now,
                  actor.principal.accountId,
                ),
            ]
          : [
              this.db
                .prepare(
                  'UPDATE aio_account_links SET active=?,org_unit_id=?,auth_not_before=max(auth_not_before,unixepoch()),revision=revision+1,verified_at=?,verified_by=?,last_operation_id=? WHERE account_id=? AND tenant_id=? AND revision=?',
                )
                .bind(
                  action === 'disable' ? 0 : action === 'enable' ? 1 : prior!.active,
                  data.orgUnitId,
                  now,
                  actor.principal.accountId,
                  operation,
                  data.accountId,
                  tenantId,
                  data.expectedRevision,
                ),
              ...(action === 'enable'
                ? [
                    this.db
                      .prepare(
                        'UPDATE aio_external_links SET active=1,revision=revision+1,verified_at=?,verified_by=? WHERE account_id=? AND issuer=? AND subject=? AND active=0 AND EXISTS(SELECT 1 FROM aio_account_links WHERE account_id=? AND last_operation_id=?)',
                      )
                      .bind(
                        now,
                        actor.principal.accountId,
                        data.accountId,
                        target!.issuer,
                        target!.subject,
                        data.accountId,
                        operation,
                      ),
                  ]
                : []),
            ];
      const result = {
        accountId: data.accountId,
        employeeId,
        revision,
        active:
          action === 'disable' ? false : action === 'reconcile' ? Boolean(prior!.active) : true,
        orgUnitId: data.orgUnitId,
      };
      return {
        statements,
        condition:
          'EXISTS(SELECT 1 FROM aio_account_links WHERE account_id=? AND tenant_id=? AND revision=? AND last_operation_id=?)',
        values: [data.accountId, tenantId, revision, operation],
        result,
        details: {
          targetAccountId: data.accountId,
          employeeId,
          before: prior
            ? {
                active: Boolean(prior.active),
                orgUnitId: prior.org_unit_id,
                revision: prior.revision,
              }
            : null,
          after: result,
        },
      };
    });
  }
}
