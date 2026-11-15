/** Additive 007. Every SQL statement here is immutable once applied. */
export const learningPolicyMigration = {
  version: '007',
  statements: [
    `DROP TRIGGER lms_certificate_valid`,
    `CREATE TRIGGER lms_certificate_valid BEFORE INSERT ON lms_certificates WHEN NOT EXISTS(SELECT 1 FROM lms_attempts a JOIN lms_course_versions v ON v.id=a.version_id JOIN lms_courses c ON c.id=v.course_id WHERE a.id=NEW.id AND a.employee_id=NEW.employee_id AND c.tenant_id=NEW.tenant_id AND json_extract(a.snapshot_json,'$.passed')=1 AND a.score>=COALESCE(json_extract(a.snapshot_json,'$.policy.passScore'),80)) BEGIN SELECT RAISE(ABORT,'LMS_CERTIFICATE_NOT_ELIGIBLE'); END`,
    `CREATE TRIGGER lms_prerequisite_version_guard BEFORE INSERT ON lms_course_versions BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.spec_json,'$.policy.prerequisiteVersionIds') p WHERE NOT EXISTS(
      SELECT 1 FROM lms_course_versions v JOIN lms_courses c ON c.id=v.course_id JOIN lms_courses target ON target.id=NEW.course_id
      WHERE v.id=p.value AND c.tenant_id=target.tenant_id AND c.status='active' AND c.published_version_id=v.id
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.spec_json,'$.audienceUnits') audience WHERE NOT EXISTS(SELECT 1 FROM json_each(v.spec_json,'$.audienceUnits') WHERE value=audience.value))
    )) THEN RAISE(ABORT,'LMS_PREREQUISITE_UNAVAILABLE') END;
    SELECT CASE WHEN EXISTS(WITH RECURSIVE required(id) AS (
      SELECT value FROM json_each(NEW.spec_json,'$.policy.prerequisiteVersionIds') UNION
      SELECT p.value FROM required r JOIN lms_course_versions v ON v.id=r.id JOIN json_each(v.spec_json,'$.policy.prerequisiteVersionIds') p
    ) SELECT 1 FROM required r JOIN lms_course_versions v ON v.id=r.id WHERE v.course_id=NEW.course_id)
    THEN RAISE(ABORT,'LMS_PREREQUISITE_CYCLE') END;
  END`,
    `CREATE TRIGGER lms_attempt_policy_guard BEFORE INSERT ON lms_attempts BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM lms_course_versions v WHERE v.id=NEW.version_id AND
      COALESCE(json_extract(v.spec_json,'$.policy.maxAttempts'),0)>0 AND
      (SELECT count(*) FROM lms_attempts a WHERE a.employee_id=NEW.employee_id AND a.version_id=NEW.version_id)>=json_extract(v.spec_json,'$.policy.maxAttempts'))
    THEN RAISE(ABORT,'LMS_ATTEMPT_LIMIT') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM lms_course_versions v WHERE v.id=NEW.version_id AND
      COALESCE(json_extract(v.spec_json,'$.policy.cooldownMinutes'),0)>0 AND
      NEW.created_at<(SELECT max(a.created_at) FROM lms_attempts a WHERE a.employee_id=NEW.employee_id AND a.version_id=NEW.version_id)+json_extract(v.spec_json,'$.policy.cooldownMinutes')*60000)
    THEN RAISE(ABORT,'LMS_ATTEMPT_COOLDOWN') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM lms_course_versions v JOIN json_each(v.spec_json,'$.policy.prerequisiteVersionIds') p WHERE v.id=NEW.version_id AND NOT EXISTS(
      SELECT 1 FROM lms_attempts a WHERE a.employee_id=NEW.employee_id AND a.version_id=p.value AND json_extract(a.snapshot_json,'$.passed')=1))
    THEN RAISE(ABORT,'LMS_PREREQUISITES_REQUIRED') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM lms_course_versions v WHERE v.id=NEW.version_id AND
      json_extract(NEW.snapshot_json,'$.passed') IS NOT (NEW.score>=COALESCE(json_extract(v.spec_json,'$.policy.passScore'),80)))
    THEN RAISE(ABORT,'LMS_ASSESSMENT_POLICY_MISMATCH') END;
  END`,
  ],
} as const;
